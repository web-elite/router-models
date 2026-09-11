// ------------------------------------------------------------------
// OpenAI-compatible SSE / completion parsing.
//
// Deliberately free of the `vscode` module so the logic can be unit
// tested with plain node.
// ------------------------------------------------------------------

export type StreamEvent =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | {
          type: 'toolCall';
          index: number;
          id?: string;
          name?: string;
          arguments?: string;
      }
    | { type: 'finish'; reason?: string }
    | { type: 'error'; message: string };

export type ToolCallFragment = {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
};

export type CompletedToolCall = {
    id: string;
    name: string;
    arguments: string;
};

/**
 * Field names providers use for reasoning / thinking output
 * (OpenRouter: `reasoning`, Gemini-compatible routers:
 * `reasoning_content`, others: `thinking` / `thought`).
 */
const REASONING_FIELDS: readonly string[] = [
    'reasoning_content',
    'reasoning',
    'thinking',
    'thought'
];

/** Parses the `data: …` SSE stream of OpenAI-compatible providers. */
export class OpenAiSseParser {
    private buffer = '';
    private dataBuffer: string[] = [];

    /** Feeds a decoded chunk and returns the events it produced. */
    feed(chunk: string): StreamEvent[] {
        this.buffer += chunk;

        const events: StreamEvent[] = [];
        let newlineIndex = this.buffer.indexOf('\n');

        while (newlineIndex >= 0) {
            let line = this.buffer.slice(0, newlineIndex);

            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (line.endsWith('\r')) {
                line = line.slice(0, -1);
            }

            this.handleLine(line, events);

            newlineIndex = this.buffer.indexOf('\n');
        }

        return events;
    }

    /** Flushes a trailing line / pending event at end of stream. */
    end(): StreamEvent[] {
        const events: StreamEvent[] = [];

        if (this.buffer) {
            const line = this.buffer.replace(/\r$/, '');

            this.buffer = '';
            this.handleLine(line, events);
        }

        this.dispatchData(events);

        return events;
    }

    private handleLine(line: string, events: StreamEvent[]): void {
        if (!line) {
            // Blank line = end of one SSE event.
            this.dispatchData(events);
            return;
        }

        if (line.startsWith(':')) {
            // Comment / keep-alive ping.
            return;
        }

        if (line.startsWith('data:')) {
            this.dataBuffer.push(line.slice(5).trimStart());
        }

        // `event:`, `id:`, `retry:` and unknown fields are ignored.
    }

    private dispatchData(events: StreamEvent[]): void {
        if (this.dataBuffer.length === 0) {
            return;
        }

        const data = this.dataBuffer.join('\n');

        this.dataBuffer = [];

        if (!data) {
            return;
        }

        if (data === '[DONE]') {
            return;
        }

        try {
            events.push(...eventsFromChunk(JSON.parse(data)));
        } catch {
            events.push({
                type: 'error',
                message:
                    'Malformed JSON from provider: ' +
                    truncate(data, 200)
            });
        }
    }
}

/**
 * Extracts events from one OpenAI-compatible chat completion chunk.
 * Also handles non-streamed completions, where the payload sits in
 * `message` instead of `delta` (some routers ignore `stream: true`).
 */
export function eventsFromChunk(json: unknown): StreamEvent[] {
    const events: StreamEvent[] = [];

    if (!json || typeof json !== 'object') {
        return events;
    }

    const record = json as Record<string, unknown>;

    if (record.error) {
        events.push({
            type: 'error',
            message:
                typeof record.error === 'string'
                    ? record.error
                    : String(
                          (record.error as Record<string, unknown>)
                              ?.message ??
                              JSON.stringify(record.error)
                      )
        });

        return events;
    }

    const choices = Array.isArray(record.choices)
        ? record.choices
        : [];

    for (const choice of choices) {
        const source = choice as Record<string, unknown> | null;
        const delta = source?.delta ?? source?.message;

        if (delta && typeof delta === 'object') {
            extractContentEvents(
                delta as Record<string, unknown>,
                events
            );
        }

        const finish =
            source?.finish_reason ?? source?.native_finish_reason;

        if (typeof finish === 'string' && finish) {
            events.push({ type: 'finish', reason: finish });
        }
    }

    return events;
}

function extractContentEvents(
    delta: Record<string, unknown>,
    events: StreamEvent[]
): void {
    pushTextEvents(delta.content, 'text', events);

    for (const field of REASONING_FIELDS) {
        pushTextEvents(delta[field], 'reasoning', events);
    }

    const toolCalls = delta.tool_calls;

    if (Array.isArray(toolCalls)) {
        for (let position = 0; position < toolCalls.length; position++) {
            const call = toolCalls[position] as
                Record<string, unknown>
                | null;
            const fn = call?.function as
                Record<string, unknown>
                | undefined;

            const id =
                typeof call?.id === 'string' && call.id
                    ? call.id
                    : undefined;
            const name =
                typeof fn?.name === 'string' && fn.name
                    ? fn.name
                    : typeof call?.name === 'string' && call.name
                      ? call.name
                      : undefined;
            const args =
                typeof fn?.arguments === 'string'
                    ? fn.arguments
                    : typeof call?.arguments === 'string'
                      ? call.arguments
                      : undefined;

            events.push({
                type: 'toolCall',
                index:
                    typeof call?.index === 'number'
                        ? call.index
                        : position,
                id,
                name,
                arguments: args
            });
        }
    }
}

function pushTextEvents(
    value: unknown,
    kind: 'text' | 'reasoning',
    events: StreamEvent[]
): void {
    if (typeof value === 'string') {
        if (value) {
            emit(kind, value, events);
        }

        return;
    }

    // Some providers send arrays of content parts.
    if (Array.isArray(value)) {
        for (const part of value) {
            const text =
                typeof part === 'string'
                    ? part
                    : (part as Record<string, unknown> | null)?.text;

            if (typeof text === 'string' && text) {
                emit(kind, text, events);
            }
        }
    }
}

function emit(
    kind: 'text' | 'reasoning',
    text: string,
    events: StreamEvent[]
): void {
    if (kind === 'text') {
        events.push({ type: 'text', text });
    } else {
        events.push({ type: 'reasoning', text });
    }
}

/**
 * Accumulates streamed `tool_calls` fragments (by index) and completes
 * them once id + name + valid JSON arguments are available.
 */
export class ToolCallAccumulator {
    private readonly calls = new Map<
        number,
        { id?: string; name?: string; arguments: string }
    >();

    /** Adds a fragment; returns calls that just became complete. */
    add(fragment: ToolCallFragment): CompletedToolCall[] {
        const entry = this.calls.get(fragment.index) ?? {
            arguments: ''
        };

        if (fragment.id) {
            entry.id = fragment.id;
        }

        if (fragment.name) {
            entry.name = fragment.name;
        }

        if (fragment.arguments) {
            entry.arguments += fragment.arguments;
        }

        this.calls.set(fragment.index, entry);

        // Providers that deliver a call in a single chunk can be
        // completed (and surfaced to the chat) immediately.
        if (
            entry.id &&
            entry.name &&
            isCompleteJson(entry.arguments)
        ) {
            this.calls.delete(fragment.index);

            return [
                {
                    id: entry.id,
                    name: entry.name,
                    arguments: entry.arguments
                }
            ];
        }

        return [];
    }

    /** Completes everything still pending (end of stream). */
    finish(): CompletedToolCall[] {
        const completed: CompletedToolCall[] = [];
        const ordered = [...this.calls.entries()].sort(
            (a, b) => a[0] - b[0]
        );

        this.calls.clear();

        for (const [, entry] of ordered) {
            if (!entry.name) {
                continue; // Fragment never got a name; unusable.
            }

            completed.push({
                id: entry.id ?? `call_${completed.length}`,
                name: entry.name,
                arguments: entry.arguments
            });
        }

        return completed;
    }
}

function isCompleteJson(value: string): boolean {
    if (!value) {
        return false;
    }

    try {
        JSON.parse(value);
        return true;
    } catch {
        return false;
    }
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}
