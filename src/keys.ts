// ------------------------------------------------------------------
// Multi-key management: parsing, round-robin selection and cooldowns.
//
// Deliberately free of the `vscode` module so the logic can be unit
// tested with plain node.
// ------------------------------------------------------------------

/**
 * Server-side failures: the request is handed to the next key
 * immediately, without putting the failing key on cooldown.
 */
export const SERVER_FALLBACK_STATUSES: readonly number[] = [
    500,
    502,
    503,
    504
];

/**
 * Authentication failures: the key is marked as burned (×) until the
 * user replaces it.
 */
export const AUTH_FAILURE_STATUSES: readonly number[] = [401, 403];

export type KeyStatus = 'ready' | 'cooldown' | 'burned';

export type KeyDetail = {
    /** Zero-based position of the key in the provider's key list. */
    index: number;
    /** Short masked representation, e.g. `sk-1…9f2a`. */
    preview: string;
    status: KeyStatus;
    /** Milliseconds left until the cooldown ends (0 when not cooling). */
    cooldownRemainingMs: number;
    /** Last failure recorded for the key, if any. */
    lastError?: string;
};

export type KeyStats = {
    total: number;
    ready: number;
    cooldown: number;
    burned: number;
};

/** Per-key details plus the key's optional label, for UI display. */
export type NamedKeyDetail = KeyDetail & { name?: string };

export type PickedKey = {
    index: number;
    key: string;
};

/** An HTTP failure returned by the provider. */
export class ProviderHttpError extends Error {
    readonly status: number;
    readonly retryAfterSeconds?: number;
    readonly body?: string;

    constructor(
        status: number,
        retryAfterSeconds?: number,
        body?: string
    ) {
        super(
            ProviderHttpError.buildMessage(status, body)
        );

        this.name = 'ProviderHttpError';
        this.status = status;
        this.retryAfterSeconds = retryAfterSeconds;
        this.body = body;
    }

    /**
     * Turns a raw HTTP error into a short, human-readable message.
     *
     * Many OpenAI-compatible providers return JSON like:
     *   { "error": { "code": "model_not_found", "message": "…", "type": "…" } }
     *
     * Instead of dumping the whole blob we extract the meaningful
     * fields and present them on separate lines.
     */
    private static buildMessage(status: number, body?: string): string {
        const statusLabel = `HTTP ${status}`;

        if (!body) {
            return statusLabel;
        }

        // Try to parse the body as JSON and extract useful fields.
        const parsed = ProviderHttpError.tryParseJson(body);

        if (parsed) {
            const parts: string[] = [];

            // Common OpenAI-style: { error: { message, code, type } }
            const errObj: Record<string, unknown> =
                typeof parsed.error === 'object' && parsed.error !== null
                    ? parsed.error as Record<string, unknown>
                    : parsed;

            if (typeof errObj.message === 'string' && errObj.message) {
                parts.push(errObj.message);
            }

            if (typeof errObj.code === 'string' && errObj.code) {
                parts.push(`Code: ${errObj.code}`);
            }

            if (typeof errObj.type === 'string' && errObj.type) {
                parts.push(`Type: ${errObj.type}`);
            }

            if (parts.length > 0) {
                return `${statusLabel}: ${parts.join(' · ')}`;
            }
        }

        // Fallback: show a truncated version of the raw body.
        return `${statusLabel}: ${truncate(body, 300)}`;
    }

    private static tryParseJson(text: string): Record<string, unknown> | undefined {
        try {
            const obj = JSON.parse(text);
            return typeof obj === 'object' && obj !== null
                ? obj as Record<string, unknown>
                : undefined;
        } catch {
            return undefined;
        }
    }
}

/**
 * One stored API key: the secret itself plus an optional free-form
 * label the user gave it, e.g. `Work account | sk-…`.
 */
export type NamedKey = {
    key: string;
    name?: string;
};

/**
 * Splits raw user input into named API keys. Accepted per line:
 * `name | key` (also `name|key1, key2` — several keys may share a
 * name) or a bare `key` without a name. Keys are additionally
 * separated by commas / semicolons / whitespace, so the old plain-key
 * input still works. Duplicates are removed while preserving order.
 */
export function parseNamedKeys(input: unknown): NamedKey[] {
    if (typeof input !== 'string') {
        return [];
    }

    const keys: NamedKey[] = [];

    const push = (name: string | undefined, raw: string): void => {
        const key = raw.trim();

        if (key && !keys.some(entry => entry.key === key)) {
            keys.push(name ? { key, name } : { key });
        }
    };

    for (const line of input.split(/\r?\n/)) {
        const trimmed = line.trim();

        if (!trimmed) {
            continue;
        }

        const separator = trimmed.indexOf('|');

        if (separator === -1) {
            for (const part of trimmed.split(/[\s,;]+/)) {
                push(undefined, part);
            }

            continue;
        }

        const name = trimmed.slice(0, separator).trim();

        for (const part of trimmed
            .slice(separator + 1)
            .split(/[\s,;]+/)) {
            push(name || undefined, part);
        }
    }

    return keys;
}

/** Key values only, in order (for round-robin selection and fetches). */
export function namedKeyValues(named: NamedKey[]): string[] {
    return named.map(entry => entry.key);
}

/**
 * Accepts stored or imported key entries in any historical shape —
 * plain strings, `{ key }` and `{ name, key }` objects — and returns
 * a clean `NamedKey[]` (duplicates removed, order preserved).
 */
export function coerceNamedKeys(value: unknown): NamedKey[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const keys: NamedKey[] = [];

    for (const entry of value) {
        if (typeof entry === 'string') {
            const key = entry.trim();

            if (key && !keys.some(k => k.key === key)) {
                keys.push({ key });
            }

            continue;
        }

        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const key =
            typeof record['key'] === 'string'
                ? record['key'].trim()
                : '';

        if (!key || keys.some(k => k.key === key)) {
            continue;
        }

        const name =
            typeof record['name'] === 'string'
                ? record['name'].trim()
                : '';

        keys.push(name ? { key, name } : { key });
    }

    return keys;
}

/**
 * Merges incoming keys into the stored list without ever removing
 * existing keys: new key values are appended in order, and an
 * incoming label renames the existing key with the same value.
 */
export function mergeNamedKeys(
    existing: NamedKey[],
    incoming: NamedKey[]
): NamedKey[] {
    const merged = existing.map(entry => ({ ...entry }));

    for (const entry of incoming) {
        const current = merged.find(
            candidate => candidate.key === entry.key
        );

        if (current) {
            if (entry.name) {
                current.name = entry.name;
            }

            continue;
        }

        merged.push({ ...entry });
    }

    return merged;
}

/** Renders named keys back to the `name | key` input format. */
export function namedKeysToInput(keys: NamedKey[]): string {
    return keys
        .map(entry =>
            entry.name ? `${entry.name} | ${entry.key}` : entry.key
        )
        .join('\n');
}

/**
 * Splits a raw user input into a list of API keys. Keys may be entered
 * one per line, or separated by commas / semicolons / whitespace.
 * Duplicates are removed while preserving order.
 */
export function parseKeys(input: unknown): string[] {
    return namedKeyValues(parseNamedKeys(input));
}

/** Masked preview like `sk-1…9f2a` (keeps head and tail). */
export function previewKey(key: string): string {
    if (key.length <= 10) {
        return `${key.slice(0, 2)}…`;
    }

    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Parses the standard `Retry-After` response header, which is either a
 * number of seconds or an HTTP date.
 */
export function parseRetryAfter(value: unknown): number | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();

    if (!trimmed) {
        return undefined;
    }

    const seconds = Number(trimmed);

    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.ceil(seconds));
    }

    const date = Date.parse(trimmed);

    if (!Number.isNaN(date)) {
        return Math.max(
            0,
            Math.ceil((date - Date.now()) / 1000)
        );
    }

    return undefined;
}

export function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function isAuthFailure(status: number): boolean {
    return AUTH_FAILURE_STATUSES.includes(status);
}

export function isServerFallback(status: number): boolean {
    return SERVER_FALLBACK_STATUSES.includes(status);
}

export function aggregateKeyStats(details: KeyDetail[]): KeyStats {
    return {
        total: details.length,
        ready: details.filter(d => d.status === 'ready').length,
        cooldown: details.filter(d => d.status === 'cooldown')
            .length,
        burned: details.filter(d => d.status === 'burned').length
    };
}

type KeyState = {
    key: string;
    /** Epoch ms when the cooldown ends; 0 when the key is usable. */
    cooldownUntil: number;
    burned: boolean;
    lastError?: string;
};

type Listener = () => void;

export class KeyManager {
    private readonly states = new Map<string, KeyState[]>();
    private readonly cursors = new Map<string, number>();
    private readonly listeners = new Set<Listener>();

    onDidChange(listener: Listener): { dispose(): void } {
        this.listeners.add(listener);

        return {
            dispose: () => {
                this.listeners.delete(listener);
            }
        };
    }

    private fire(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch {
                // A broken listener must not break the others.
            }
        }
    }

    /**
     * Selects the next usable key (round-robin, skipping burned keys and
     * keys resting in cooldown). When every key is resting, falls back to
     * the one whose cooldown expires next so requests still go out.
     */
    pickKey(providerId: string, keys: string[]): PickedKey {
        if (keys.length === 0) {
            throw new Error(
                'No API key configured for this provider.'
            );
        }

        const states = this.reconcile(providerId, keys);
        const now = Date.now();
        const start = this.cursors.get(providerId) ?? 0;

        for (let offset = 0; offset < states.length; offset++) {
            const index = (start + offset) % states.length;
            const state = states[index];

            if (!state.burned && state.cooldownUntil <= now) {
                this.cursors.set(
                    providerId,
                    (index + 1) % states.length
                );

                return { index, key: state.key };
            }
        }

        const cooling = states.filter(state => !state.burned);
        const pool = (cooling.length ? cooling : states)
            .slice()
            .sort((a, b) => a.cooldownUntil - b.cooldownUntil);

        const soonest = pool[0];

        return {
            index: states.indexOf(soonest),
            key: soonest.key
        };
    }

    /**
     * Puts a key on cooldown after a 429. A `Retry-After` header wins
     * over the provider's configured cooldown time.
     */
    markRateLimited(
        providerId: string,
        key: string,
        providerCooldownSeconds: number,
        retryAfterSeconds?: number
    ): number {
        const seconds = Math.max(
            0,
            retryAfterSeconds ?? providerCooldownSeconds
        );

        const state = this.stateFor(providerId, key);

        if (state) {
            state.cooldownUntil = Math.max(
                state.cooldownUntil,
                Date.now() + seconds * 1000
            );
            state.lastError = '429 rate limited';
            this.fire();
        }

        return seconds;
    }

    /** Records a transient server error (no cooldown). */
    markServerUnavailable(
        providerId: string,
        key: string,
        message?: string
    ): void {
        const state = this.stateFor(providerId, key);

        if (state) {
            state.lastError = message ?? 'server error';
            this.fire();
        }
    }

    /** Burns a key after an authentication failure. */
    markAuthFailure(
        providerId: string,
        key: string,
        message?: string
    ): void {
        const state = this.stateFor(providerId, key);

        if (state) {
            state.burned = true;
            state.lastError = message ?? 'authentication error';
            this.fire();
        }
    }

    /** Clears all cooldowns (optionally for a single provider). */
    resetCooldowns(providerId?: string): void {
        const ids = providerId ? [providerId] : [...this.states.keys()];
        const now = Date.now();
        let changed = false;

        for (const id of ids) {
            for (const state of this.states.get(id) ?? []) {
                if (state.cooldownUntil > now) {
                    state.cooldownUntil = 0;
                    changed = true;
                }

                if (state.lastError === '429 rate limited') {
                    state.lastError = undefined;
                    changed = true;
                }
            }
        }

        if (changed) {
            this.fire();
        }
    }

    /** Drops all runtime state of a provider (e.g. after removal). */
    clearStates(providerId: string): void {
        this.states.delete(providerId);
        this.cursors.delete(providerId);
        this.fire();
    }

    snapshot(providerId: string, keys: string[]): KeyDetail[] {
        const states = this.reconcile(providerId, keys);
        const now = Date.now();

        return states.map((state, index) => ({
            index,
            preview: previewKey(state.key),
            status: state.burned
                ? 'burned'
                : state.cooldownUntil > now
                  ? 'cooldown'
                  : 'ready',
            cooldownRemainingMs: state.burned
                ? 0
                : Math.max(0, state.cooldownUntil - now),
            lastError: state.lastError
        }));
    }

    hasActiveCooldowns(): boolean {
        const now = Date.now();

        for (const states of this.states.values()) {
            for (const state of states) {
                if (!state.burned && state.cooldownUntil > now) {
                    return true;
                }
            }
        }

        return false;
    }

    private reconcile(
        providerId: string,
        keys: string[]
    ): KeyState[] {
        const existing = this.states.get(providerId) ?? [];
        const byKey = new Map(
            existing.map(state => [state.key, state])
        );

        const next = keys.map(
            key =>
                byKey.get(key) ?? {
                    key,
                    cooldownUntil: 0,
                    burned: false
                }
        );

        this.states.set(providerId, next);

        return next;
    }

    private stateFor(
        providerId: string,
        key: string
    ): KeyState {
        let states = this.states.get(providerId);

        if (!states) {
            states = [];
            this.states.set(providerId, states);
        }

        let state = states.find(
            candidate => candidate.key === key
        );

        if (!state) {
            state = {
                key,
                cooldownUntil: 0,
                burned: false
            };

            states.push(state);
        }

        return state;
    }
}
