// ------------------------------------------------------------------
// Conversion of VS Code language model messages / tools to the
// OpenAI-compatible wire format.
//
// Tool calls (assistant) and tool results (user role) are preserved so
// tool calling keeps working end to end in Copilot Chat.
// ------------------------------------------------------------------

import * as vscode from 'vscode';

export type OpenAiToolCall = {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
};

export type OpenAiMessage = {
    role: 'user' | 'assistant' | 'tool';
    content?: string | null;
    name?: string;
    tool_calls?: OpenAiToolCall[];
    tool_call_id?: string;
};

export type OpenAiTool = {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: unknown;
    };
};

function stringifyToolInput(input: object | undefined): string {
    try {
        return JSON.stringify(input ?? {});
    } catch {
        return '{}';
    }
}

function textOfPart(part: unknown): string {
    if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
    }

    if (typeof part === 'string') {
        return part;
    }

    return '';
}

function toolResultText(content: ReadonlyArray<unknown>): string {
    return content
        .map(part => {
            if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
            }

            if (typeof part === 'string') {
                return part;
            }

            try {
                return JSON.stringify(part);
            } catch {
                return '';
            }
        })
        .filter(text => text !== '')
        .join('\n');
}

export function convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
): OpenAiMessage[] {
    const converted: OpenAiMessage[] = [];

    for (const message of messages) {
        const role =
            message.role ===
            vscode.LanguageModelChatMessageRole.Assistant
                ? 'assistant'
                : 'user';

        const parts: readonly unknown[] = message.content ?? [];

        if (role === 'assistant') {
            let text = '';
            const toolCalls: OpenAiToolCall[] = [];

            for (const part of parts) {
                if (
                    part instanceof vscode.LanguageModelToolCallPart
                ) {
                    toolCalls.push({
                        id: part.callId,
                        type: 'function',
                        function: {
                            name: part.name,
                            arguments: stringifyToolInput(
                                part.input
                            )
                        }
                    });
                } else {
                    text += textOfPart(part);
                }
            }

            const out: OpenAiMessage = {
                role: 'assistant',
                content: text || null
            };

            if (toolCalls.length > 0) {
                out.tool_calls = toolCalls;
            }

            converted.push(out);
        } else {
            let text = '';
            const toolResults: OpenAiMessage[] = [];

            for (const part of parts) {
                if (
                    part instanceof
                    vscode.LanguageModelToolResultPart
                ) {
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: part.callId,
                        content: toolResultText(part.content ?? [])
                    });
                } else {
                    text += textOfPart(part);
                }
            }

            // Tool results must directly follow the assistant message
            // that requested them, so they are emitted first.
            converted.push(...toolResults);

            if (text) {
                const out: OpenAiMessage = {
                    role: 'user',
                    content: text
                };

                if (message.name) {
                    out.name = message.name;
                }

                converted.push(out);
            }
        }
    }

    if (converted.length === 0) {
        converted.push({ role: 'user', content: ' ' });
    }

    return converted;
}

export function convertTools(
    tools?: readonly vscode.LanguageModelChatTool[]
): OpenAiTool[] | undefined {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters:
                (tool.inputSchema as object | undefined) ?? {
                    type: 'object',
                    properties: {}
                }
        }
    }));
}

export function convertToolChoice(
    toolMode: vscode.LanguageModelChatToolMode | undefined,
    hasTools: boolean
): 'auto' | 'required' | undefined {
    if (!hasTools) {
        return undefined;
    }

    return toolMode === vscode.LanguageModelChatToolMode.Required
        ? 'required'
        : 'auto';
}
