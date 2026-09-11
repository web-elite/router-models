// ------------------------------------------------------------------
// JSON import: locate `providerConnections` lists anywhere in an
// uploaded file (up to 4 object levels deep), map every connection
// onto the fields Router Models needs (name, base URL, API key) and
// group connections of the same upstream provider — identified by
// their `providerSpecificData.prefix` — so N connections with the
// same prefix become ONE provider with N API keys.
//
// Deliberately free of the `vscode` module so the logic can be unit
// tested with plain node.
// ------------------------------------------------------------------

/** How many object levels deep `providerConnections` is looked for. */
export const MAX_SEARCH_DEPTH = 4;

/**
 * Collects every object found inside a `providerConnections` array,
 * searching up to `maxDepth` object levels deep (the root counts as
 * level 1; arrays are transparent containers and do not add a level).
 * Multiple lists are supported, so the file may contain several
 * `providerConnections` arrays at different depths.
 */
export function findProviderConnections(
    root: unknown,
    maxDepth: number = MAX_SEARCH_DEPTH
): unknown[] {
    const found: unknown[] = [];

    const visit = (node: unknown, depth: number): void => {
        if (depth > maxDepth || node === null || typeof node !== 'object') {
            return;
        }

        if (Array.isArray(node)) {
            // Containers hold siblings, not a deeper level.
            for (const item of node) {
                visit(item, depth);
            }

            return;
        }

        for (const [key, value] of Object.entries(node)) {
            if (key === 'providerConnections' && Array.isArray(value)) {
                for (const item of value) {
                    if (item && typeof item === 'object') {
                        found.push(item);
                    }
                }
            }

            // Keep looking: the file may contain several lists, or nest
            // them inside unrelated wrappers.
            if (value && typeof value === 'object') {
                visit(value, depth + 1);
            }
        }
    };

    visit(root, 1);

    return found;
}

/** First value that is a non-empty string (trimmed). */
function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string') {
            const trimmed = value.trim();

            if (trimmed) {
                return trimmed;
            }
        }
    }

    return undefined;
}

export type ParsedConnection = {
    /** One-based position among all discovered connections. */
    index: number;
    /** Best-effort label for user-facing messages. */
    label: string;
    /** Display name from the JSON, if present. */
    name?: string;
    /** Endpoint URL from the JSON, if present. */
    baseUrl?: string;
    /** API key from the JSON, if present. */
    apiKey?: string;
    /** Upstream provider identifier (`provider` field), if present. */
    source?: string;
    /** `providerSpecificData.nodeName` — provider display name. */
    nodeName?: string;
    /** `providerSpecificData.prefix` — identifies the provider. */
    prefix?: string;
    /**
     * Lower-case key connections are grouped by: the prefix, falling
     * back to the upstream provider id, then the endpoint host.
     */
    groupKey: string;
};

/**
 * Maps every discovered connection onto the fields Router Models
 * needs. `providerSpecificData` is checked first (the common export
 * format), then the connection itself.
 */
export function parseConnections(root: unknown): ParsedConnection[] {
    return findProviderConnections(root).map((raw, index) => {
        const record: Record<string, unknown> =
            raw && typeof raw === 'object' && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : {};

        const specific: Record<string, unknown> =
            record['providerSpecificData'] &&
            typeof record['providerSpecificData'] === 'object' &&
            !Array.isArray(record['providerSpecificData'])
                ? (record['providerSpecificData'] as Record<string, unknown>)
                : {};

        const name = firstNonEmptyString(
            record['name'],
            specific['nodeName']
        );

        const nodeName = firstNonEmptyString(specific['nodeName']);

        const prefix = firstNonEmptyString(specific['prefix']);

        const source = firstNonEmptyString(record['provider']);

        const baseUrl = firstNonEmptyString(
            specific['baseUrl'],
            record['baseUrl'],
            record['baseURL'],
            record['endpoint'],
            record['url']
        );

        const apiKey = firstNonEmptyString(
            record['apiKey'],
            record['key'],
            record['api_key'],
            record['token']
        );

        const groupKey = (
            prefix ??
            source ??
            (baseUrl ? hostOf(baseUrl) : undefined) ??
            `connection-${index + 1}`
        ).toLowerCase();

        return {
            index: index + 1,
            label: name ?? source ?? prefix ?? `connection ${index + 1}`,
            name,
            baseUrl,
            apiKey,
            source,
            nodeName,
            prefix,
            groupKey
        };
    });
}

/** Host name of an URL, or undefined when it cannot be parsed. */
function hostOf(url: string): string | undefined {
    try {
        return new URL(url).hostname || undefined;
    } catch {
        return undefined;
    }
}

export type ProviderGroup = {
    /**
     * Suggested provider id — the `providerSpecificData.prefix` (e.g.
     * `uniKey`, `b-ai`), falling back to the upstream provider id.
     */
    id: string;
    /** Display name — `providerSpecificData.nodeName` when present. */
    name: string;
    /** Endpoint shared by the grouped connections. */
    baseUrl?: string;
    /** Unique API keys of the group, in order of appearance. */
    apiKeys: string[];
    /** How many raw connections were merged into the group. */
    connections: number;
};

/**
 * Merges connections that belong to the same upstream provider into a
 * single group: the `providerSpecificData.prefix` identifies the
 * provider, so N connections with the same prefix (one per API key)
 * become one provider carrying N keys.
 */
export function groupConnections(
    connections: ParsedConnection[]
): ProviderGroup[] {
    const groups = new Map<string, ProviderGroup>();

    for (const connection of connections) {
        let group = groups.get(connection.groupKey);

        if (!group) {
            group = {
                id:
                    connection.prefix ??
                    connection.source ??
                    connection.groupKey,
                name:
                    connection.nodeName ??
                    connection.prefix ??
                    connection.name ??
                    'Imported Provider',
                baseUrl: connection.baseUrl,
                apiKeys: [],
                connections: 0
            };

            groups.set(connection.groupKey, group);
        }

        group.connections++;

        if (!group.baseUrl && connection.baseUrl) {
            group.baseUrl = connection.baseUrl;
        }

        if (
            connection.apiKey &&
            !group.apiKeys.includes(connection.apiKey)
        ) {
            group.apiKeys.push(connection.apiKey);
        }
    }

    return [...groups.values()];
}
