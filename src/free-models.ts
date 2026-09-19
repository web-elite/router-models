/**
 * Remote "free models" registry.
 *
 * A JSON file, curated by the extension author and shipped as a
 * built-in service (see `RouterProvider.FREE_MODELS_URL`), lists the
 * model ids that are free to use for a given provider. Users only
 * turn the feature on or off (`routerModels.freeModelsEnabled`); the
 * URL itself is never exposed as a setting. Providers declared in
 * that file are matched against the providers the user added by
 * comparing the *registrable domain* of their base URL, so
 * `https://openrouter.ai/api/v1` in the file matches a user-entered
 * `https://openrouter.ai` (and vice versa).
 *
 * Deliberately free of the `vscode` module so the logic can be unit
 * tested in isolation, like `import.ts` and `keys.ts`.
 */

/** One provider inside the remote registry file. */
export type RegistryProvider = {
    baseUrl: string;
    freeModels: string[];
};

/** Shape of the remote free-models JSON file. */
export type FreeModelsFile = {
    version?: number;
    updated?: string;
    providers: RegistryProvider[];
};

/** What gets persisted in globalState between restarts. */
export type CachedFreeModels = {
    source?: string;
    fetchedAt: string;
    json: unknown;
};

/**
 * Second-level domains that need three labels to identify a
 * registrable domain (`example.co.uk`, `foo.github.io`, …). Anything
 * not listed here falls back to the last two labels, which is right
 * for the overwhelming majority of API hosts (`api.deepseek.com` →
 * `deepseek.com`, `generativelanguage.googleapis.com` →
 * `googleapis.com`).
 */
const MULTI_PART_SUFFIXES = new Set([
    // Country second-level domains
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'geek.nz',
    'co.jp', 'ne.jp', 'ac.jp', 'go.jp', 'or.jp', 'ed.jp',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'co.za', 'net.za', 'org.za', 'web.za', 'ac.za',
    'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'gen.in',
    'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
    'co.kr', 'or.kr', 'go.kr', 'ac.kr', 'ne.kr',
    'com.tw', 'org.tw', 'net.tw', 'gov.tw',
    'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
    'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
    'com.ar', 'org.ar', 'net.ar', 'gov.ar',
    'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'edu.tr',
    'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
    'com.my', 'org.my', 'net.my', 'gov.my', 'edu.my',
    'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
    'com.ua', 'org.ua', 'net.ua', 'gov.ua',
    'co.th', 'or.th', 'ac.th', 'go.th',
    'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
    'com.ph', 'org.ph', 'net.ph', 'gov.ph',
    'co.ke', 'or.ke', 'go.ke', 'ac.ke',
    'com.ng', 'org.ng', 'gov.ng', 'edu.ng',
    'com.eg', 'org.eg', 'net.eg', 'gov.eg',
    // Hosted / platform suffixes where the subdomain is the app
    'github.io', 'gitlab.io', 'bitbucket.io',
    'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
    'herokuapp.com', 'firebaseapp.com', 'appspot.com',
    'run.app', 'web.app', 'deno.dev', 'fly.dev'
]);

/** Converts a glob (`*`, `?`) into a case-insensitive RegExp. */
function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    return new RegExp(`^${source}$`, 'i');
}

/**
 * Extracts the registrable domain from a URL so that a provider in
 * the registry and a provider the user added are recognized as the
 * same host even when their base URLs differ in scheme, subdomain,
 * path or port.
 *
 *     rootDomainOf('https://api.openrouter.ai/api/v1')  → 'openrouter.ai'
 *     rootDomainOf('https://openrouter.ai')             → 'openrouter.ai'
 *     rootDomainOf('https://api.deepseek.com')          → 'deepseek.com'
 *     rootDomainOf('http://localhost:1234/v1')          → 'localhost'
 */
export function rootDomainOf(url: string): string {
    if (!url || typeof url !== 'string') {
        return '';
    }

    let rest = url.trim();

    // Strip the scheme.
    rest = rest.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');

    // Strip user info (`user:pass@host`).
    const at = rest.indexOf('@');

    if (at !== -1) {
        rest = rest.slice(at + 1);
    }

    // Stop at the first path / query / fragment.
    const end = rest.search(/[/?#]/);

    if (end !== -1) {
        rest = rest.slice(0, end);
    }

    // Strip the port.
    const colon = rest.lastIndexOf(':');

    if (colon !== -1) {
        rest = rest.slice(0, colon);
    }

    const host = rest.toLowerCase().replace(/[.]+$/, '').trim();

    if (!host) {
        return '';
    }

    // IPv6 literal — keep it verbatim.
    if (host.startsWith('[') && host.endsWith(']')) {
        return host;
    }

    // IPv4 literal — nothing to strip.
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
        return host;
    }

    const labels = host.split('.');
    const last = labels.slice(-2).join('.');

    if (labels.length <= 2) {
        return host;
    }

    // `foo.example.co.uk` → `example.co.uk`, but `a.b.example.com`
    // stays `example.com`.
    if (MULTI_PART_SUFFIXES.has(last)) {
        return labels.slice(-3).join('.');
    }

    return last;
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(item => item.length > 0);
}

function pickString(record: object, ...keys: string[]): string {
    for (const key of keys) {
        const value = (record as Record<string, unknown>)[key];

        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    return '';
}

/**
 * Indexes a parsed registry file by registrable domain so free-model
 * lookups are a cheap map read.
 */
export class FreeModelsIndex {
    /** registrable domain → free model ids / glob patterns */
    private readonly entries: Map<string, string[]> = new Map();

    /** `updated` field of the source file, if any. */
    updatedAt: string | undefined;

    /** When the file was last successfully fetched (ISO). */
    fetchedAt: string | undefined;

    /** URL the index was built from. */
    source: string | undefined;

    static empty(): FreeModelsIndex {
        return new FreeModelsIndex();
    }

    /**
     * Validates and indexes a parsed registry file. Accepts both the
     * documented object form and a bare array of providers. Unknown
     * keys are ignored; entries without a usable base URL are skipped.
     */
    static fromJson(json: unknown, source?: string): FreeModelsIndex {
        if (json === null || typeof json !== 'object') {
            throw new Error(
                'Free-models file must be a JSON object with a ' +
                    '"providers" array.'
            );
        }

        const root = (Array.isArray(json)
            ? { providers: json }
            : json) as Record<string, unknown>;

        const providers = root['providers'];

        if (!Array.isArray(providers)) {
            throw new Error(
                'Free-models file is missing a "providers" array.'
            );
        }

        const index = new FreeModelsIndex();
        index.source = source;

        if (typeof root['updated'] === 'string') {
            index.updatedAt = root['updated'];
        }

        for (const entry of providers) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }

            const baseUrl = pickString(
                entry as object,
                'baseUrl',
                'baseURL',
                'url',
                'host'
            );

            const patterns = asStringArray(
                (entry as Record<string, unknown>)['freeModels'] ??
                    (entry as Record<string, unknown>)['free_models'] ??
                    (entry as Record<string, unknown>)['models']
            );

            const domain = rootDomainOf(baseUrl);

            if (!domain || patterns.length === 0) {
                continue;
            }

            const existing = index.entries.get(domain) ?? [];
            const merged = existing.concat(
                patterns.filter(
                    pattern => !existing.includes(pattern)
                )
            );

            // Collapse duplicates inside the entry itself.
            index.entries.set(
                domain,
                merged.filter(
                    (pattern, position) =>
                        merged.indexOf(pattern) === position
                )
            );
        }

        return index;
    }

    /** Number of providers (domains) the index knows about. */
    get providerCount(): number {
        return this.entries.size;
    }

    /** Total number of free-model entries across all providers. */
    get modelCount(): number {
        let total = 0;

        for (const patterns of this.entries.values()) {
            total += patterns.length;
        }

        return total;
    }

    isEmpty(): boolean {
        return this.entries.size === 0;
    }

    /**
     * Free-model patterns declared for the registrable domain of
     * `baseUrl` (empty when the registry has no entry for it).
     */
    freePatternsFor(baseUrl: string): string[] {
        return this.entries.get(rootDomainOf(baseUrl)) ?? [];
    }

    /** True when `modelId` is declared free for `baseUrl`. */
    isFreeModel(baseUrl: string, modelId: string): boolean {
        const patterns = this.entries.get(rootDomainOf(baseUrl));

        if (!patterns) {
            return false;
        }

        const id = modelId.toLowerCase();

        for (const pattern of patterns) {
            if (pattern.includes('*') || pattern.includes('?')) {
                if (globToRegExp(pattern).test(modelId)) {
                    return true;
                }
            } else if (pattern.toLowerCase() === id) {
                return true;
            }
        }

        return false;
    }

    /** Round-trips the index back into its cacheable form. */
    toCache(): CachedFreeModels {
        const providers: RegistryProvider[] = [];

        for (const [domain, patterns] of this.entries) {
            providers.push({ baseUrl: domain, freeModels: patterns });
        }

        return {
            source: this.source,
            fetchedAt: this.fetchedAt ?? new Date().toISOString(),
            json: { version: 1, updated: this.updatedAt, providers }
        };
    }
}

/**
 * Downloads and parses the remote free-models file. Throws on any
 * network, HTTP or JSON problem so the caller can report it.
 */
export async function fetchFreeModelsRegistry(
    url: string,
    timeoutMs: number
): Promise<FreeModelsIndex> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            redirect: 'follow',
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}` +
                    (response.statusText
                        ? ` ${response.statusText}`
                        : '')
            );
        }

        const text = await response.text();

        if (!text.trim()) {
            throw new Error('The free-models file is empty.');
        }

        let json: unknown;

        try {
            json = JSON.parse(text);
        } catch {
            throw new Error(
                'The free-models file is not valid JSON: ' +
                    `${text.slice(0, 80)}…`
            );
        }

        return FreeModelsIndex.fromJson(json, url);
    } finally {
        clearTimeout(timer);
    }
}
