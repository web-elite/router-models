import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
    aggregateKeyStats,
    coerceNamedKeys,
    isAuthFailure,
    isServerFallback,
    mergeNamedKeys,
    namedKeyValues,
    parseNamedKeys,
    parseRetryAfter,
    truncate,
    KeyManager,
    KeyStats,
    NamedKey,
    NamedKeyDetail,
    ProviderHttpError
} from './keys';

import {
    MAX_SEARCH_DEPTH,
    decodeTextFile,
    groupConnections,
    parseConnections,
    ParsedConnection
} from './import';

import { discoverFavicon } from './favicon';
import {
    CachedFreeModels,
    fetchFreeModelsRegistry,
    FreeModelsIndex
} from './free-models';

import {
    convertMessages,
    convertToolChoice,
    convertTools,
    OpenAiMessage
} from './openai-messages';

import {
    CompletedToolCall,
    eventsFromChunk,
    OpenAiSseParser,
    StreamEvent,
    ToolCallAccumulator
} from './stream';

export type ProviderConfig = {
    id: string;
    name: string;
    baseUrl: string;
    iconUrl?: string;
    iconFile?: string;
    /** True when `iconUrl` was auto-detected, not entered manually. */
    iconAuto?: boolean;
    /** Cooldown time in seconds a key rests after a 429. */
    cooldownSeconds?: number;
    /** When true the provider is hidden from the model picker. */
    disabled?: boolean;
};

export type ModelEntry = {
    id: string;
    name?: string;
    context_length?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    manual?: boolean;
    /** Set when the user tags the model as free. */
    free?: boolean;
};

export type ModelSnapshot = {
    id: string;
    name?: string;
    manual: boolean;
    /** True when tagged free or when the id / name contains "free". */
    free: boolean;
    hidden: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
};

export type ProviderSnapshot = {
    id: string;
    name: string;
    baseUrl: string;
    iconUrl?: string;
    iconFile?: string;
    iconData?: string;
    hasKey: boolean;
    error?: string;
    disabled: boolean;
    models: ModelSnapshot[];
    /** Multi-key statistics for this provider. */
    keys: KeyStats;
    /** Per-key details (label + status), without raw key material. */
    keyList: NamedKeyDetail[];
    /** Configured cooldown time in seconds. */
    cooldownSeconds: number;
};

/** One provider inside the extension's own JSON export format. */
export type ExportedProvider = {
    id?: string;
    name: string;
    baseUrl: string;
    iconUrl?: string;
    cooldownSeconds?: number;
    /** API keys — plain strings or `{ name, key }` objects. */
    apiKeys?: (string | { name?: string; key: string })[];
    models?: ModelEntry[];
};

/** Shape of the file written by `Router Models: Export …`. */
export type ExportFile = {
    kind: string;
    version: number;
    exportedAt: string;
    settings?: {
        includePatterns?: string[];
        excludePatterns?: string[];
    };
    providers: ExportedProvider[];
};

/** Recognizes the extension's own export format in a parsed JSON. */
export function isRouterModelsExport(value: unknown): value is ExportFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const record = value as Record<string, unknown>;

    return (
        record['kind'] === 'router-models-export' &&
        Array.isArray(record['providers'])
    );
}

type ResolvedModel = {
    provider: ProviderConfig;
    model: ModelEntry;
};

function slugify(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');

    return slug || 'provider';
}

function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

    return new RegExp(`^${source}$`, 'i');
}

function extFromContentType(type: string): string | undefined {
    const map: Record<string, string> = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'image/svg+xml': 'svg',
        'image/x-icon': 'ico',
        'image/vnd.microsoft.icon': 'ico'
    };

    return map[type.split(';')[0].trim().toLowerCase()];
}

function extMime(ext: string): string {
    const map: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        ico: 'image/x-icon'
    };

    return map[ext] ?? 'image/png';
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A stream failure after response parts were already delivered. */
class MidStreamFailureError extends Error {
    readonly cause: unknown;
    /** True when a tool call was already reported to the chat. */
    readonly deliveredToolCall: boolean;

    constructor(cause: unknown, deliveredToolCall: boolean) {
        super('Stream failed after output was already delivered.');

        this.name = 'MidStreamFailureError';
        this.cause = cause;
        this.deliveredToolCall = deliveredToolCall;
    }
}

/**
 * Connection-level failures (dropped socket, aborted fetch, DNS or
 * timeout). These are worth retrying, unlike a clean HTTP error the
 * server actually formulated. Undici reports a remotely closed socket
 * — the usual "Sorry, your request failed" cause — as
 * `TypeError: terminated`.
 */
function isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    // A formulated HTTP response is not a network drop.
    if (error instanceof ProviderHttpError) {
        return false;
    }

    const name = error.name ?? '';
    const message = error.message ?? '';

    if (name === 'AbortError' || name === 'TimeoutError') {
        return true;
    }

    return /terminated|fetch failed|network|socket|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|aborted|timeout/i.test(
        message
    );
}

/** Parses streamed tool-call arguments into a JSON object. */
function parseToolArguments(rawArguments: string): object {
    try {
        const parsed: unknown = JSON.parse(rawArguments || '{}');

        return parsed && typeof parsed === 'object'
            ? (parsed as object)
            : { raw: rawArguments };
    } catch {
        return { raw: rawArguments };
    }
}

export class RouterProvider
    implements vscode.LanguageModelChatProvider {

    private static readonly PROVIDERS_KEY = 'router-models.providers';
    private static readonly CACHE_KEY = 'router-models.models-cache';
    /**
     * globalState key holding the last downloaded free-models
     * registry, so free tags survive a restart and work offline.
     */
    private static readonly FREE_MODELS_KEY =
        'router-models.free-models';
    /**
     * Curated free-models registry maintained by the extension
     * author. This is a service shipped with the extension, so the
     * URL is intentionally NOT a user setting; users only turn the
     * whole feature on or off (`routerModels.freeModelsEnabled`).
     */
    private static readonly FREE_MODELS_URL =
        'https://raw.githubusercontent.com/web-elite/' +
        'router-models/refs/heads/main/data/free-models.json';
    /**
     * Optional developer-only override of `FREE_MODELS_URL`. Not
     * documented anywhere; it exists so the list can be repointed
     * (e.g. to a staging file) without shipping an update.
     */
    private static readonly FREE_MODELS_ENV = 'ROUTER_MODELS_FREE_URL';
    /**
     * globalState key remembering that the user hid the
     * free-providers banner at the bottom of the provider list.
     */
    private static readonly OFFERS_BANNER_KEY =
        'router-models.offers-banner-hidden';
    /** Site that curates free AI providers, shown in the banner. */
    public static readonly OFFERS_URL = 'https://offers.webelitee.ir';
    private static readonly SECRET_PREFIX = 'router-models.apiKey.';
    /**
     * SecretStorage key holding the JSON array of API keys
     * (`SECRET_PREFIX` holds the legacy single-key format).
     */
    private static readonly KEYS_SECRET_PREFIX =
        'router-models.apiKeys.';
    private static readonly MAX_ICON_BYTES = 2 * 1024 * 1024;
    /**
     * globalState key holding the API-key mirror that participates in
     * VS Code Settings Sync (SecretStorage itself is never synced).
     */
    private static readonly SYNC_KEYS_KEY = 'router-models.sync.keys';
    /** Marker + version of the extension's own JSON export format. */
    private static readonly EXPORT_KIND = 'router-models-export';
    private static readonly EXPORT_VERSION = 1;

    private providers: ProviderConfig[] = [];
    private cache: Map<string, ModelEntry[]> = new Map();
    private errors: Map<string, string> = new Map();
    private resolved: Map<string, ResolvedModel> = new Map();
    private refreshing: Set<string> = new Set();

    /** Free models declared by the remote registry, by domain. */
    private freeIndex: FreeModelsIndex = FreeModelsIndex.empty();
    /** Handle of the automatic free-models refresh timer. */
    private freeModelsTimer: ReturnType<typeof setInterval> | undefined;
    /** Prevents overlapping automatic free-models downloads. */
    private refreshingFreeModels = false;

    /** Whether the user hid the free-providers banner. */
    private offersBannerHidden = false;

    /** Mirrors the current `syncApiKeys` setting (key set applied). */
    private syncKeysApplied = false;

    /** Runtime key state (cooldowns, burn marks) per provider. */
    private readonly keys = new KeyManager();

    /** Model and provider of the most recent chat request. */
    private lastUsedModelName?: string;
    private lastUsedProviderId?: string;

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();

    readonly onDidChangeLanguageModelChatInformation =
        this.onDidChangeEmitter.event;

    private readonly onDidChangeStateEmitter =
        new vscode.EventEmitter<void>();

    readonly onDidChangeState = this.onDidChangeStateEmitter.event;

    private readonly configWatcher =
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration(
                    'routerModels.includePatterns'
                ) ||
                event.affectsConfiguration(
                    'routerModels.excludePatterns'
                )
            ) {
                this.onDidChangeEmitter.fire();
            }

            if (
                event.affectsConfiguration(
                    'routerModels.freeModelsEnabled'
                ) ||
                event.affectsConfiguration(
                    'routerModels.freeModelsRefreshHours'
                )
            ) {
                this.scheduleFreeModelsRefresh();
                this.onDidChangeStateEmitter.fire();
            }
        });

    /** Reacts to `routerModels.syncApiKeys` being toggled. */
    private readonly syncWatcher =
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration('routerModels.syncApiKeys')
            ) {
                void this.onSyncSettingChanged();
            }
        });

    constructor(private readonly context: vscode.ExtensionContext) {
        this.load();
        this.syncKeysApplied = this.syncApiKeysEnabled();
        this.applySyncKeys();
        void this.migrateLegacyData();

        // Cooldown / key-state changes refresh the sidebar and the
        // status bar key monitor.
        this.context.subscriptions.push(
            this.keys.onDidChange(() =>
                this.onDidChangeStateEmitter.fire()
            )
        );

        this.context.subscriptions.push(
            this.configWatcher,
            this.syncWatcher,
            this.onDidChangeEmitter,
            this.onDidChangeStateEmitter,
            // Stop the automatic free-models download loop on
            // deactivation.
            new vscode.Disposable(() => this.clearFreeModelsTimer())
        );

        this.scheduleFreeModelsRefresh();
        this.maybeRefreshStaleFreeModels();
    }

    private get secrets(): vscode.SecretStorage {
        return this.context.secrets;
    }

    private get iconsDir(): vscode.Uri {
        return vscode.Uri.joinPath(this.context.globalStorageUri, 'icons');
    }

    private secretKey(providerId: string): string {
        return RouterProvider.SECRET_PREFIX + providerId;
    }

    private load(): void {
        this.providers = this.context.globalState.get<
            ProviderConfig[]
        >(RouterProvider.PROVIDERS_KEY, []);

        const saved = this.context.globalState.get<
            Record<string, ModelEntry[]>
        >(RouterProvider.CACHE_KEY, {});

        this.cache = new Map(Object.entries(saved));

        // The last downloaded free-models registry is reused until a
        // refresh replaces it, so free tags survive a restart.
        const cached = this.context.globalState.get<CachedFreeModels>(
            RouterProvider.FREE_MODELS_KEY
        );

        if (cached) {
            try {
                this.freeIndex = FreeModelsIndex.fromJson(
                    cached.json,
                    cached.source
                );
                this.freeIndex.fetchedAt = cached.fetchedAt;
            } catch {
                // A corrupt cache entry is ignored; the next
                // download repopulates it.
            }
        }

        this.offersBannerHidden = Boolean(
            this.context.globalState.get<boolean>(
                RouterProvider.OFFERS_BANNER_KEY
            )
        );
    }

    private async saveProviders(): Promise<void> {
        await this.context.globalState.update(
            RouterProvider.PROVIDERS_KEY,
            this.providers
        );
    }

    private async saveCache(): Promise<void> {
        await this.context.globalState.update(
            RouterProvider.CACHE_KEY,
            Object.fromEntries(this.cache)
        );
    }

    /**
     * Shows or hides the free-providers banner. The choice is kept
     * across sessions.
     */
    async setOffersBannerHidden(hidden: boolean): Promise<void> {
        this.offersBannerHidden = hidden;

        await this.context.globalState.update(
            RouterProvider.OFFERS_BANNER_KEY,
            hidden
        );

        this.fireChanged();
    }

    // ---------------------------------------------------------------
    // Free-models registry
    // ---------------------------------------------------------------

    /**
     * Whether the user opted in to automatic free-models detection.
     * Off by default; nothing is downloaded until this is on.
     */
    freeModelsEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('routerModels')
            .get<boolean>('freeModelsEnabled', false);
    }

    /**
     * Turns automatic free-models detection on or off and applies the
     * side effects (starts/stops the refresh timer, fetches on enable).
     */
    async setFreeModelsEnabled(enabled: boolean): Promise<void> {
        await vscode.workspace
            .getConfiguration('routerModels')
            .update(
                'freeModelsEnabled',
                enabled,
                vscode.ConfigurationTarget.Global
            );

        // The config watcher re-schedules the timer; on enable it
        // also kicks off the first download right away.
        if (enabled) {
            void this.backgroundRefreshFreeModels();
        }
    }

    /**
     * The URL of the free-models file. The undocumented
     * `ROUTER_MODELS_FREE_URL` environment variable can repoint it,
     * otherwise the curated list shipped with the extension is used.
     */
    freeModelsUrl(): string {
        const env = process.env[RouterProvider.FREE_MODELS_ENV];

        if (env && env.trim()) {
            return env.trim();
        }

        return RouterProvider.FREE_MODELS_URL;
    }

    private async saveFreeIndex(): Promise<void> {
        if (this.freeIndex.isEmpty()) {
            await this.context.globalState.update(
                RouterProvider.FREE_MODELS_KEY,
                undefined
            );
            return;
        }

        await this.context.globalState.update(
            RouterProvider.FREE_MODELS_KEY,
            this.freeIndex.toCache()
        );
    }

    /**
     * Downloads the free-models file, indexes it and persists the
     * result. Free tags are derived from the registry on the fly, so
     * a model that is dropped from the file stops being free again.
     */
    async refreshFreeModels(): Promise<FreeModelsIndex> {
        if (!this.freeModelsEnabled()) {
            throw new Error(
                'Free-models detection is turned off. Enable it via ' +
                    '"routerModels.freeModelsEnabled" first.'
            );
        }

        const timeoutMs = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('requestTimeoutMs', 30000);

        const index = await fetchFreeModelsRegistry(
            this.freeModelsUrl(),
            timeoutMs
        );

        this.freeIndex = index;
        await this.saveFreeIndex();
        this.fireChanged();

        return index;
    }

    /** Manual refresh with progress UI and a result message. */
    async refreshFreeModelsFlow(): Promise<void> {
        if (!this.freeModelsEnabled()) {
            const choice = await vscode.window.showWarningMessage(
                'Router Models: free-models detection is turned off.',
                'Enable'
            );

            if (choice === 'Enable') {
                await this.setFreeModelsEnabled(true);
            }

            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Router Models: detecting free models…'
            },
            async () => {
                try {
                    const index = await this.refreshFreeModels();

                    vscode.window.showInformationMessage(
                        'Router Models: free-models list updated — ' +
                            `${index.modelCount} free model(s) across ` +
                            `${index.providerCount} provider(s).`
                    );
                } catch (error) {
                    vscode.window.showErrorMessage(
                        'Router Models: could not download the ' +
                            `free-models list. ${toErrorMessage(error)}`
                    );
                }
            }
        );
    }

    /** Downloads quietly in the background; failures never block. */
    private async backgroundRefreshFreeModels(): Promise<void> {
        if (this.refreshingFreeModels) {
            return;
        }

        this.refreshingFreeModels = true;

        try {
            await this.refreshFreeModels();
        } catch {
            // Background failures are non-fatal; the cached index
            // keeps working and the next interval retries.
        } finally {
            this.refreshingFreeModels = false;
        }
    }

    private clearFreeModelsTimer(): void {
        if (this.freeModelsTimer) {
            clearInterval(this.freeModelsTimer);
            this.freeModelsTimer = undefined;
        }
    }

    /**
     * (Re)starts the automatic free-models download on the configured
     * interval. Called on activation and whenever the related
     * settings change.
     */
    private scheduleFreeModelsRefresh(): void {
        this.clearFreeModelsTimer();

        const config = vscode.workspace.getConfiguration('routerModels');

        if (!this.freeModelsEnabled()) {
            return;
        }

        const hours = config.get<number>('freeModelsRefreshHours', 24);
        const intervalMs =
            Math.max(1, Math.round(hours)) * 60 * 60 * 1000;

        this.freeModelsTimer = setInterval(
            () => void this.backgroundRefreshFreeModels(),
            intervalMs
        );
    }

    /**
     * Refreshes the registry shortly after activation when the cached
     * copy is older than the configured interval (or missing), so a
     * machine that was asleep / off for days still catches up.
     */
    private maybeRefreshStaleFreeModels(): void {
        if (!this.freeModelsEnabled()) {
            return;
        }

        const hours = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('freeModelsRefreshHours', 24);

        const limitMs = Math.max(1, Math.round(hours)) * 60 * 60 * 1000;
        const fetched = this.freeIndex.fetchedAt
            ? Date.parse(this.freeIndex.fetchedAt)
            : NaN;

        const stale =
            !Number.isFinite(fetched) || Date.now() - fetched > limitMs;

        if (stale) {
            setTimeout(
                () => void this.backgroundRefreshFreeModels(),
                5000
            );
        }
    }

    /** Status shown in the sidebar footer. */
    freeModelsStatus(): {
        enabled: boolean;
        intervalHours: number;
        updatedAt: string | undefined;
        fetchedAt: string | undefined;
        providers: number;
        models: number;
    } {
        const config = vscode.workspace.getConfiguration('routerModels');

        return {
            enabled: this.freeModelsEnabled(),
            intervalHours: config.get<number>(
                'freeModelsRefreshHours',
                24
            ),
            updatedAt: this.freeIndex.updatedAt,
            fetchedAt: this.freeIndex.fetchedAt,
            providers: this.freeIndex.providerCount,
            models: this.freeIndex.modelCount
        };
    }

    // ---------------------------------------------------------------
    // Settings Sync (work ↔ home machines)
    // ---------------------------------------------------------------

    private syncApiKeysEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('routerModels')
            .get<boolean>('syncApiKeys', false);
    }

    /**
     * Declares which globalState keys participate in VS Code Settings
     * Sync. `setKeysForSync` replaces the whole set, so it is rebuilt
     * from the current setting on every call. The API-key mirror only
     * joins the set when the user opted in.
     */
    private applySyncKeys(): void {
        const keys = [
            RouterProvider.PROVIDERS_KEY,
            RouterProvider.CACHE_KEY
        ];

        if (this.syncKeysApplied) {
            keys.push(RouterProvider.SYNC_KEYS_KEY);
        }

        this.context.globalState.setKeysForSync(keys);
    }

    /** Handles the user toggling `routerModels.syncApiKeys`. */
    private async onSyncSettingChanged(): Promise<void> {
        const enabled = this.syncApiKeysEnabled();

        if (enabled === this.syncKeysApplied) {
            return;
        }

        this.syncKeysApplied = enabled;
        this.applySyncKeys();

        if (enabled) {
            // Backfill the synced mirror from the local secure
            // storage; entries already mirrored from another machine
            // (for providers without local keys) are preserved.
            const mirror = this.readSyncMirror();

            for (const provider of this.providers) {
                const keys = await this.secretKeysFor(provider);

                if (keys.length > 0) {
                    mirror[provider.id] = keys;
                }
            }

            await this.context.globalState.update(
                RouterProvider.SYNC_KEYS_KEY,
                mirror
            );

            vscode.window.setStatusBarMessage(
                'Router Models: API keys will now sync through ' +
                    'Settings Sync.',
                6000
            );
        } else {
            // Opt-out: drop the mirrored keys from the synced state.
            // Local SecretStorage copies are kept untouched.
            await this.context.globalState.update(
                RouterProvider.SYNC_KEYS_KEY,
                undefined
            );

            vscode.window.setStatusBarMessage(
                'Router Models: the synced API-key mirror was removed.',
                6000
            );
        }
    }

    /** Reads the synced key mirror (validated, never undefined). */
    private readSyncMirror(): Record<string, NamedKey[]> {
        const raw = this.context.globalState.get<
            Record<string, unknown>
        >(RouterProvider.SYNC_KEYS_KEY);

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return {};
        }

        const clean: Record<string, NamedKey[]> = {};

        for (const [id, value] of Object.entries(raw)) {
            // Accepts the current `{ name, key }` entries as well as
            // the plain `string[]` mirrors written by older versions.
            const named = coerceNamedKeys(value);

            if (named.length > 0) {
                clean[id] = named;
            }
        }

        return clean;
    }

    /**
     * Re-reads the persisted (and Settings-Sync-arrived) globalState
     * into memory. VS Code does not fire an event when synced global
     * state changes, so this is called on activation, when the
     * sidebar becomes visible and by the reload command.
     *
     * @returns true when anything changed compared to memory.
     */
    async reloadFromSync(): Promise<boolean> {
        const before = JSON.stringify({
            providers: this.providers,
            cache: Object.fromEntries(this.cache)
        });

        this.load();
        this.syncKeysApplied = this.syncApiKeysEnabled();
        this.applySyncKeys();

        const after = JSON.stringify({
            providers: this.providers,
            cache: Object.fromEntries(this.cache)
        });

        if (before !== after) {
            this.fireChanged();
            return true;
        }

        return false;
    }

    /** Command flow around `reloadFromSync` with user feedback. */
    async reloadFromSyncFlow(): Promise<void> {
        const changed = await this.reloadFromSync();

        if (changed) {
            vscode.window.showInformationMessage(
                'Router Models: providers reloaded from Settings Sync.'
            );
        } else {
            vscode.window.showInformationMessage(
                'Router Models: already up to date.'
            );
        }
    }

    private fireChanged(): void {
        this.onDidChangeStateEmitter.fire();
        this.onDidChangeEmitter.fire();
    }

    private async migrateLegacyData(): Promise<void> {
        let changed = false;

        const used = new Set(
            this.providers.map(provider => provider.id)
        );

        for (const provider of this.providers) {
            if (!provider.id) {
                let id = slugify(provider.name);

                while (used.has(id)) {
                    id += '-x';
                }

                provider.id = id;
                used.add(id);
                changed = true;
            }
        }

        if (changed) {
            await this.saveProviders();
        }

        for (const provider of this.providers) {
            const legacyKey =
                RouterProvider.SECRET_PREFIX + provider.name;

            try {
                const legacy = await this.secrets.get(legacyKey);

                if (
                    legacy &&
                    !(await this.secrets.get(
                        this.secretKey(provider.id)
                    ))
                ) {
                    await this.secrets.store(
                        this.secretKey(provider.id),
                        legacy
                    );

                    await this.secrets.delete(legacyKey);
                }
            } catch {
                // Secret migration is best-effort.
            }
        }

        const saved = this.context.globalState.get<
            Record<string, unknown>
        >(RouterProvider.CACHE_KEY, {});

        const hasLegacyEntries = Object.values(saved).some(
            value =>
                typeof value === 'object' &&
                value !== null &&
                !Array.isArray(value)
        );

        if (!hasLegacyEntries) {
            return;
        }

        const migrated: Record<string, ModelEntry[]> = {};

        for (const [key, value] of Object.entries(saved)) {
            if (Array.isArray(value)) {
                migrated[key] = value as ModelEntry[];
                continue;
            }

            const entry = value as {
                provider?: { id?: string; name?: string };
                model?: ModelEntry;
            };

            if (!entry?.model) {
                continue;
            }

            const providerId =
                entry.provider?.id ??
                this.providers.find(
                    candidate =>
                        candidate.name === entry.provider?.name
                )?.id ??
                slugify(key.split(':')[0] ?? 'provider');

            migrated[providerId] = [
                ...(migrated[providerId] ?? []),
                entry.model
            ];
        }

        this.cache = new Map(Object.entries(migrated));

        await this.saveCache();
        this.fireChanged();
    }

    // ---------------------------------------------------------------
    // Management API (sidebar + commands)
    // ---------------------------------------------------------------

    listProviders(): ProviderConfig[] {
        return this.providers;
    }

    private getProvider(id: string): ProviderConfig {
        const provider = this.providers.find(p => p.id === id);

        if (!provider) {
            throw new Error(`Provider not found: ${id}`);
        }

        return provider;
    }

    private normalizeBaseUrl(value: string): string {
        const trimmed = value.trim().replace(/\/+$/, '');

        if (!trimmed) {
            throw new Error('Base URL is required.');
        }

        if (!/^https?:\/\//i.test(trimmed)) {
            throw new Error('Base URL must start with http:// or https://');
        }

        return trimmed;
    }

    private uniqueId(requested: string, name: string): string {
        const base = slugify(requested || name);
        let id = base;
        let suffix = 2;

        while (this.providers.some(p => p.id === id)) {
            id = `${base}-${suffix++}`;
        }

        return id;
    }

    async addProvider(input: {
        name: string;
        id?: string;
        baseUrl: string;
        /** Raw input: one `name | key` entry per line. */
        apiKey?: string;
        /** Explicit named key list (programmatic use). */
        apiKeys?: NamedKey[];
        iconUrl?: string;
        cooldownSeconds?: number | null;
    }): Promise<ProviderConfig> {
        const name = input.name.trim();

        if (!name) {
            throw new Error('Provider name is required.');
        }

        if (
            this.providers.some(
                p => p.name.toLowerCase() === name.toLowerCase()
            )
        ) {
            throw new Error(`Provider "${name}" already exists.`);
        }

        const baseUrl = this.normalizeBaseUrl(input.baseUrl);
        const id = this.uniqueId(input.id ?? '', name);

        const provider: ProviderConfig = { id, name, baseUrl };
        const iconUrl = input.iconUrl?.trim();

        if (iconUrl) {
            provider.iconUrl = iconUrl;
        }

        const cooldown = input.cooldownSeconds;

        if (typeof cooldown === 'number' && cooldown >= 0) {
            provider.cooldownSeconds = Math.floor(cooldown);
        }

        this.providers.push(provider);
        await this.saveProviders();

        const keys =
            input.apiKeys && input.apiKeys.length > 0
                ? coerceNamedKeys(input.apiKeys)
                : parseNamedKeys(input.apiKey);

        if (keys.length > 0) {
            await this.storeKeys(id, keys);
        }

        if (iconUrl) {
            await this.updateIcon(provider).catch(error => {
                vscode.window.showWarningMessage(
                    `Could not download icon for ${name}: ` +
                        toErrorMessage(error)
                );
            });
        } else {
            // No manual icon: try to pick up the site's favicon.
            void this.tryAutoFavicon(provider);
        }

        void this.refreshProvider(id).catch(() => {
            // Errors are recorded on the provider.
        });

        this.fireChanged();
        return provider;
    }

    /**
     * Adds API keys to an existing provider without ever touching the
     * stored ones: new key values are appended, a label on an incoming
     * key renames the stored key with the same value.
     *
     * Input: one `name | key` entry per line (a bare key also works).
     */
    async addKeys(providerId: string, rawInput: string): Promise<void> {
        const provider = this.getProvider(providerId);
        const incoming = parseNamedKeys(rawInput);

        if (incoming.length === 0) {
            return;
        }

        await this.storeKeys(
            providerId,
            mergeNamedKeys(
                await this.secretKeysFor(provider),
                incoming
            )
        );
    }

    /** Removes the key at `index` (the order shown in the sidebar). */
    async removeKeyAt(providerId: string, index: number): Promise<void> {
        const provider = this.getProvider(providerId);
        const keys = await this.secretKeysFor(provider);

        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= keys.length
        ) {
            throw new Error('That key no longer exists.');
        }

        keys.splice(index, 1);

        await this.storeKeys(providerId, keys);
    }

    async updateProvider(
        id: string,
        patch: {
            name?: string;
            baseUrl?: string;
            /** Raw input — added to the existing keys, never replaces them. */
            apiKey?: string | null;
            /** Explicit key list — added to the existing keys, never replaces them. */
            apiKeys?: (string | NamedKey)[] | null;
            iconUrl?: string | null;
            cooldownSeconds?: number | null;
        }
    ): Promise<void> {
        const provider = this.getProvider(id);
        let baseUrlChanged = false;
        let iconChanged = false;

        if (patch.name !== undefined) {
            const name = patch.name.trim();

            if (!name) {
                throw new Error('Provider name is required.');
            }

            if (
                this.providers.some(
                    p =>
                        p.id !== id &&
                        p.name.toLowerCase() === name.toLowerCase()
                )
            ) {
                throw new Error(`Provider "${name}" already exists.`);
            }

            provider.name = name;
        }

        if (patch.baseUrl !== undefined) {
            const baseUrl = this.normalizeBaseUrl(patch.baseUrl);

            if (baseUrl !== provider.baseUrl) {
                provider.baseUrl = baseUrl;
                baseUrlChanged = true;
            }
        }

        if (patch.apiKey !== undefined) {
            const incoming = parseNamedKeys(patch.apiKey ?? '');

            if (incoming.length > 0) {
                await this.storeKeys(
                    id,
                    mergeNamedKeys(
                        await this.secretKeysFor(provider),
                        incoming
                    )
                );
            }
        }

        if (patch.apiKeys !== undefined) {
            const incoming = coerceNamedKeys(patch.apiKeys ?? []);

            if (incoming.length > 0) {
                await this.storeKeys(
                    id,
                    mergeNamedKeys(
                        await this.secretKeysFor(provider),
                        incoming
                    )
                );
            }
        }

        if (patch.cooldownSeconds !== undefined) {
            const seconds = patch.cooldownSeconds;

            provider.cooldownSeconds =
                typeof seconds === 'number' && seconds >= 0
                    ? Math.floor(seconds)
                    : undefined;
        }

        if (patch.iconUrl !== undefined) {
            const iconUrl = patch.iconUrl?.trim() ?? '';

            if (iconUrl) {
                provider.iconUrl = iconUrl;
                // A manually entered URL always takes precedence over auto.
                provider.iconAuto = undefined;
                iconChanged = true;
            } else if (provider.iconUrl || provider.iconAuto) {
                provider.iconUrl = undefined;
                provider.iconAuto = undefined;
                iconChanged = true;
            }
        }

        await this.saveProviders();

        if (iconChanged) {
            if (provider.iconUrl) {
                await this.updateIcon(provider).catch(error => {
                    vscode.window.showWarningMessage(
                        `Could not download icon for ${provider.name}: ` +
                            toErrorMessage(error)
                    );
                });
            } else {
                provider.iconFile = undefined;
                provider.iconAuto = undefined;
                await this.deleteIconFiles(id);
                await this.saveProviders();
            }
        }

        this.fireChanged();

        if (baseUrlChanged) {
            // An auto-detected icon now points at the old host: refresh it.
            // A manual icon URL is left untouched.
            if (provider.iconAuto) {
                provider.iconUrl = undefined;
                provider.iconAuto = undefined;
                provider.iconFile = undefined;
                await this.deleteIconFiles(id);
                await this.saveProviders();
            }

            if (!provider.iconUrl) {
                // New host: look for its favicon in the background.
                void this.tryAutoFavicon(provider);
            }

            void this.refreshProvider(id).catch(() => {
                // Errors are recorded on the provider.
            });
        }
    }

    async removeProvider(id: string): Promise<void> {
        const provider = this.getProvider(id);

        this.providers = this.providers.filter(p => p.id !== id);
        await this.saveProviders();

        try {
            await this.secrets.delete(this.secretKey(id));
            await this.secrets.delete(
                RouterProvider.KEYS_SECRET_PREFIX + id
            );
        } catch {
            // Best-effort cleanup.
        }

        // Remove the provider's entry from the synced mirror too.
        if (this.syncKeysApplied) {
            const mirror = this.readSyncMirror();

            if (mirror[id]) {
                delete mirror[id];

                await this.context.globalState.update(
                    RouterProvider.SYNC_KEYS_KEY,
                    mirror
                );
            }
        }

        this.keys.clearStates(id);

        this.cache.delete(id);
        this.errors.delete(id);
        await this.saveCache();

        await this.deleteIconFiles(id).catch(() => {
            // Best-effort cleanup.
        });

        this.fireChanged();
        vscode.window.showInformationMessage(
            `${provider.name} removed.`
        );
    }

    async toggleDisabled(id: string): Promise<void> {
        const provider = this.getProvider(id);

        provider.disabled = !provider.disabled;
        await this.saveProviders();
        this.fireChanged();
    }

    async addManualModel(
        providerId: string,
        modelId: string,
        name?: string,
        free?: boolean
    ): Promise<void> {
        const provider = this.getProvider(providerId);
        const trimmedId = modelId.trim();

        if (!trimmedId) {
            throw new Error('Model id is required.');
        }

        const entries = this.cache.get(providerId) ?? [];
        const existing = entries.find(entry => entry.id === trimmedId);

        if (existing) {
            existing.manual = true;

            if (name?.trim()) {
                existing.name = name.trim();
            }

            if (free !== undefined) {
                if (free) {
                    existing.free = true;
                } else {
                    delete existing.free;
                }
            }
        } else {
            const entry: ModelEntry = { id: trimmedId, manual: true };

            if (name?.trim()) {
                entry.name = name.trim();
            }

            if (free) {
                entry.free = true;
            }

            entries.push(entry);
        }

        this.cache.set(providerId, entries);
        await this.saveCache();
        this.fireChanged();

        vscode.window.showInformationMessage(
            `Model "${trimmedId}" added to ${provider.name}.`
        );
    }

    async removeManualModel(
        providerId: string,
        modelId: string
    ): Promise<void> {
        this.getProvider(providerId);

        const entries = this.cache.get(providerId) ?? [];
        const entry = entries.find(e => e.id === modelId);

        if (!entry?.manual) {
            throw new Error(
                `"${modelId}" was discovered automatically. Use ` +
                    'exclude patterns in settings to hide it.'
            );
        }

        this.cache.set(
            providerId,
            entries.filter(e => e.id !== modelId)
        );
        await this.saveCache();
        this.fireChanged();
    }

    /**
     * Tags / untags a model as free. Works for discovered and manual
     * models alike; the flag survives model refreshes.
     */
    async setModelFree(
        providerId: string,
        modelId: string,
        free: boolean
    ): Promise<void> {
        const provider = this.getProvider(providerId);
        const entries = this.cache.get(providerId) ?? [];
        const entry = entries.find(e => e.id === modelId);

        if (!entry) {
            throw new Error(
                `"${modelId}" is not a model of ${provider.name}.`
            );
        }

        if (free) {
            entry.free = true;
        } else {
            delete entry.free;
        }

        this.cache.set(providerId, entries);
        await this.saveCache();
        this.fireChanged();

        vscode.window.setStatusBarMessage(
            `Router Models: "${modelId}" is now ` +
                (free ? 'tagged as free.' : 'no longer tagged as free.'),
            4000
        );
    }

    // ---------------------------------------------------------------
    // Icon caching
    // ---------------------------------------------------------------

    private async updateIcon(provider: ProviderConfig): Promise<void> {
        if (!provider.iconUrl) {
            return;
        }

        const response = await fetch(provider.iconUrl, {
            signal: this.timeoutSignal(15000)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        if (!buffer.length) {
            throw new Error('Empty response.');
        }

        if (buffer.length > RouterProvider.MAX_ICON_BYTES) {
            throw new Error('Image is larger than 2 MB.');
        }

        const ext =
            extFromContentType(
                response.headers.get('content-type') ?? ''
            ) ?? 'png';

        await fs.mkdir(this.iconsDir.fsPath, { recursive: true });
        await this.deleteIconFiles(provider.id);

        const file = `${provider.id}.${ext}`;

        await fs.writeFile(
            path.join(this.iconsDir.fsPath, file),
            buffer
        );

        provider.iconFile = file;
        await this.saveProviders();
        this.onDidChangeStateEmitter.fire();
    }

    private async deleteIconFiles(providerId: string): Promise<void> {
        let files: string[] = [];

        try {
            files = await fs.readdir(this.iconsDir.fsPath);
        } catch {
            return;
        }

        for (const file of files) {
            if (file.startsWith(`${providerId}.`)) {
                await fs.rm(
                    path.join(this.iconsDir.fsPath, file),
                    { force: true }
                );
            }
        }
    }

    /**
     * Downloads and stores the favicon of the provider's host when no
     * manual icon URL is set. Failures stay silent: the user can always
     * enter an icon URL manually in the sidebar.
     */
    private async tryAutoFavicon(
        provider: ProviderConfig
    ): Promise<void> {
        const enabled = vscode.workspace
            .getConfiguration('routerModels')
            .get<boolean>('autoFavicon', true);

        // A manually entered icon always wins — never overwrite it.
        if (!enabled || provider.iconUrl && !provider.iconAuto) {
            return;
        }

        try {
            const iconUrl = await discoverFavicon(provider.baseUrl);

            if (!iconUrl || (provider.iconUrl && !provider.iconAuto)) {
                return;
            }

            provider.iconUrl = iconUrl;
            provider.iconAuto = true;
            await this.saveProviders();
            this.onDidChangeStateEmitter.fire();

            await this.updateIcon(provider);
        } catch {
            // Blocked / not found: manual URL remains an option.
        }
    }

    // ---------------------------------------------------------------
    // Networking
    // ---------------------------------------------------------------

    private timeoutSignal(timeoutMs: number): AbortSignal {
        const controller = new AbortController();

        setTimeout(() => controller.abort(), timeoutMs);

        return controller.signal;
    }

    /** Keys stored in this machine's SecretStorage only. */
    private async secretKeysFor(
        provider: ProviderConfig
    ): Promise<NamedKey[]> {
        const raw = await this.secrets.get(
            RouterProvider.KEYS_SECRET_PREFIX + provider.id
        );

        if (raw) {
            try {
                // Accepts the current `{ name, key }` format as well
                // as the old plain `string[]` entries.
                const named = coerceNamedKeys(JSON.parse(raw));

                if (named.length > 0) {
                    return named;
                }
            } catch {
                // Corrupt entry: fall back to the legacy key.
            }
        }

        // Legacy single-key format (pre-multi-key versions).
        const legacy = await this.secrets.get(
            this.secretKey(provider.id)
        );

        return legacy ? [{ key: legacy }] : [];
    }

    /**
     * Raw key values for requests (round-robin selection). Use
     * `resolveNamedKeys` when the labels matter too.
     */
    private async getKeys(
        provider: ProviderConfig
    ): Promise<string[]> {
        return namedKeyValues(await this.resolveNamedKeys(provider));
    }

    /** Named keys with the secret-storage + sync-mirror fallback. */
    private async resolveNamedKeys(
        provider: ProviderConfig
    ): Promise<NamedKey[]> {
        const named = await this.secretKeysFor(provider);

        if (named.length > 0) {
            return named;
        }

        // Synced-mirror fallback: this machine has not stored the
        // keys yet, but Settings Sync has delivered them from
        // another machine. Heal the local secure storage so future
        // reads do not depend on the mirror.
        if (this.syncKeysApplied) {
            const mirrored = this.readSyncMirror()[provider.id];

            if (mirrored && mirrored.length > 0) {
                await this.healFromMirror(provider.id, mirrored);
                return mirrored;
            }
        }

        return [];
    }

    /** Writes keys delivered by Settings Sync into SecretStorage. */
    private async healFromMirror(
        providerId: string,
        keys: NamedKey[]
    ): Promise<void> {
        try {
            await this.secrets.store(
                RouterProvider.KEYS_SECRET_PREFIX + providerId,
                JSON.stringify(keys)
            );

            await this.secrets.delete(this.secretKey(providerId));
        } catch {
            // Best-effort: the mirror remains the fallback.
        }
    }

    private async storeKeys(
        providerId: string,
        keys: NamedKey[]
    ): Promise<void> {
        if (keys.length > 0) {
            await this.secrets.store(
                RouterProvider.KEYS_SECRET_PREFIX + providerId,
                JSON.stringify(keys)
            );
        } else {
            await this.secrets.delete(
                RouterProvider.KEYS_SECRET_PREFIX + providerId
            );
        }

        // The legacy single-key entry is superseded by the list.
        try {
            await this.secrets.delete(this.secretKey(providerId));
        } catch {
            // Best-effort cleanup.
        }

        // Keep the synced mirror in step with the secret storage
        // (only written while the user opted into key syncing).
        if (this.syncKeysApplied) {
            const mirror = this.readSyncMirror();

            if (keys.length > 0) {
                mirror[providerId] = keys;
            } else {
                delete mirror[providerId];
            }

            await this.context.globalState.update(
                RouterProvider.SYNC_KEYS_KEY,
                mirror
            );
        }

        // The user re-saved the keys: give them a fresh start
        // (clears cooldowns and burn marks).
        this.keys.clearStates(providerId);
    }

    private cooldownSecondsFor(provider: ProviderConfig): number {
        const configured =
            typeof provider.cooldownSeconds === 'number'
                ? provider.cooldownSeconds
                : vscode.workspace
                      .getConfiguration('routerModels')
                      .get<number>('defaultCooldownSeconds', 60);

        return Math.max(0, configured);
    }

    private async fetch(
        provider: ProviderConfig,
        apiPath: string,
        init: RequestInit = {},
        apiKey?: string
    ): Promise<Response> {
        const timeoutMs = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('requestTimeoutMs', 30000);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(`${provider.baseUrl}${apiPath}`, {
                ...init,
                signal: init.signal ?? controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey
                        ? { Authorization: `Bearer ${apiKey}` }
                        : {}),
                    ...(init.headers ?? {})
                }
            });
        } finally {
            clearTimeout(timer);
        }
    }

    /** Classifies an HTTP failure and updates the key's runtime state. */
    private markKeyFailure(
        provider: ProviderConfig,
        key: string,
        status: number,
        retryAfterSeconds?: number,
        message?: string
    ): void {
        const summary = message
            ? truncate(message, 200)
            : `HTTP ${status}`;

        if (isAuthFailure(status)) {
            this.keys.markAuthFailure(
                provider.id,
                key,
                `${status}: ${summary}`
            );

            return;
        }

        if (status === 429) {
            const seconds = this.keys.markRateLimited(
                provider.id,
                key,
                this.cooldownSecondsFor(provider),
                retryAfterSeconds
            );

            vscode.window.setStatusBarMessage(
                `Router Models: a key of ${provider.name} is resting for ${seconds}s (429).`,
                5000
            );

            return;
        }

        if (isServerFallback(status)) {
            this.keys.markServerUnavailable(
                provider.id,
                key,
                `${status}: ${summary}`
            );
        }
    }

    /**
     * Fetches the model list, retrying with the next key on rate
     * limits, server errors and authentication failures.
     */
    private async fetchModels(
        provider: ProviderConfig
    ): Promise<ModelEntry[]> {
        const keys = await this.getKeys(provider);
        const attempts = Math.max(1, keys.length);
        let lastError: unknown;

        for (let attempt = 0; attempt < attempts; attempt++) {
            const picked = this.keys.pickKey(provider.id, keys);

            try {
                const response = await this.fetch(
                    provider,
                    '/models',
                    {},
                    picked.key
                );

                if (!response.ok) {
                    const retryAfter = parseRetryAfter(
                        response.headers.get('retry-after')
                    );

                    const text = await response
                        .text()
                        .catch(() => '');

                    this.markKeyFailure(
                        provider,
                        picked.key,
                        response.status,
                        retryAfter,
                        text
                    );

                    throw new ProviderHttpError(
                        response.status,
                        retryAfter,
                        text
                    );
                }

                return await this.parseModelList(response);
            } catch (error) {
                lastError = error;

                const retryable =
                    error instanceof ProviderHttpError &&
                    (error.status === 429 ||
                        isAuthFailure(error.status) ||
                        isServerFallback(error.status));

                if (!retryable) {
                    throw error;
                }
            }
        }

        throw lastError ?? new Error('Failed to fetch models.');
    }

    private async parseModelList(
        response: Response
    ): Promise<ModelEntry[]> {
        const json = (await response.json()) as {
            data?: ModelEntry[];
        };

        const models: ModelEntry[] = [];

        for (const model of json.data ?? []) {
            if (!model?.id) {
                continue;
            }

            models.push({
                id: model.id,
                name: model.name,
                context_length: model.context_length,
                max_input_tokens: model.max_input_tokens,
                max_output_tokens: model.max_output_tokens
            });
        }

        return models.sort((a, b) => a.id.localeCompare(b.id));
    }

    async refreshProvider(id: string): Promise<number> {
        const provider = this.getProvider(id);

        if (this.refreshing.has(id)) {
            return this.cache.get(id)?.length ?? 0;
        }

        this.refreshing.add(id);

        try {
            const fetched = await this.fetchModels(provider);
            const previous = this.cache.get(id) ?? [];
            const manual = previous.filter(entry => entry.manual);

            // Free tags the user set on discovered models survive a
            // refresh (discovered entries are rebuilt from scratch).
            const freeIds = new Set(
                previous
                    .filter(entry => entry.free && !entry.manual)
                    .map(entry => entry.id)
            );

            this.cache.set(
                id,
                fetched
                    .map(entry =>
                        freeIds.has(entry.id)
                            ? { ...entry, free: true }
                            : entry
                    )
                    .concat(manual)
            );
            this.errors.delete(id);
            await this.saveCache();
            this.fireChanged();

            return fetched.length;
        } catch (error) {
            this.errors.set(id, toErrorMessage(error));
            this.onDidChangeStateEmitter.fire();
            throw error;
        } finally {
            this.refreshing.delete(id);
        }
    }

    async refreshAll(): Promise<void> {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Router Models: refreshing models…'
            },
            async () => {
                const results = await Promise.allSettled(
                    this.providers.map(provider =>
                        this.refreshProvider(provider.id)
                    )
                );

                const failed = results.filter(
                    result => result.status === 'rejected'
                );

                if (failed.length > 0) {
                    vscode.window.showWarningMessage(
                        `Router Models: ${failed.length} provider(s) ` +
                            'failed to refresh. Check the sidebar for details.'
                    );
                } else if (this.providers.length > 0) {
                    vscode.window.showInformationMessage(
                        'Router Models: all providers refreshed.'
                    );
                }
            }
        );
    }

    private triggerRefresh(id: string): void {
        if (this.refreshing.has(id)) {
            return;
        }

        void this.refreshProvider(id).catch(() => {
            // Errors are recorded on the provider.
        });
    }

    // ---------------------------------------------------------------
    // Model filtering
    // ---------------------------------------------------------------

    /**
     * A model counts as free when the user tagged it, when its id /
     * display name already contains "free" (e.g. OpenRouter's `:free`
     * variants), or when the remote free-models registry lists it for
     * this provider's domain — free models get a "(free)" label in
     * the model picker so they are easy to find.
     */
    private isFreeModel(
        provider: ProviderConfig,
        model: ModelEntry
    ): boolean {
        if (model.free) {
            return true;
        }

        if (
            /\bfree\b/i.test(model.id) ||
            /\bfree\b/i.test(model.name ?? '')
        ) {
            return true;
        }

        return this.freeIndex.isFreeModel(provider.baseUrl, model.id);
    }

    isVisible(modelId: string): boolean {
        const config =
            vscode.workspace.getConfiguration('routerModels');

        const exclude = config.get<string[]>('excludePatterns', []);

        if (
            exclude.some(
                pattern =>
                    pattern.trim() &&
                    globToRegExp(pattern).test(modelId)
            )
        ) {
            return false;
        }

        const activeInclude = config
            .get<string[]>('includePatterns', [])
            .filter(pattern => pattern.trim());

        if (
            activeInclude.length > 0 &&
            !activeInclude.some(pattern =>
                globToRegExp(pattern).test(modelId)
            )
        ) {
            return false;
        }

        return true;
    }

    private maxInputTokens(model: ModelEntry): number {
        return (
            model.max_input_tokens ??
            model.context_length ??
            128000
        );
    }

    private maxOutputTokens(model: ModelEntry): number {
        return model.max_output_tokens ?? 16000;
    }

    private modelsFor(provider: ProviderConfig): ModelEntry[] {
        return this.cache.get(provider.id) ?? [];
    }

    private rebuildResolved(): void {
        this.resolved.clear();

        for (const provider of this.providers) {
            if (provider.disabled) {
                continue;
            }

            for (const model of this.modelsFor(provider)) {
                this.resolved.set(`${provider.id}:${model.id}`, {
                    provider,
                    model
                });
            }
        }
    }

    // ---------------------------------------------------------------
    // Snapshot for the sidebar
    // ---------------------------------------------------------------

    async getSnapshot(): Promise<{
        providers: ProviderSnapshot[];
        freeModels: ReturnType<RouterProvider['freeModelsStatus']>;
        offersBannerHidden: boolean;
    }> {
        const providers: ProviderSnapshot[] = [];

        for (const provider of this.providers) {
            const namedKeys = await this.resolveNamedKeys(provider);
            const keyDetails: NamedKeyDetail[] = this.keys
                .snapshot(provider.id, namedKeyValues(namedKeys))
                .map((detail, index) => ({
                    ...detail,
                    name: namedKeys[index]?.name
                }));

            let iconFile = provider.iconFile;
            let iconData: string | undefined;

            if (iconFile) {
                try {
                    const buffer = await fs.readFile(
                        path.join(this.iconsDir.fsPath, iconFile)
                    );

                    iconData =
                        `data:${extMime(
                            path.extname(iconFile).slice(1)
                        )};base64,` +
                        buffer.toString('base64');
                } catch {
                    iconFile = undefined;
                }
            }

            const models = this.modelsFor(provider).map(model => ({
                id: model.id,
                name: model.name,
                manual: Boolean(model.manual),
                free: this.isFreeModel(provider, model),
                hidden: !this.isVisible(model.id),
                maxInputTokens: this.maxInputTokens(model),
                maxOutputTokens: this.maxOutputTokens(model)
            }));

            models.sort((a, b) => a.id.localeCompare(b.id));

            providers.push({
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl,
                iconUrl: provider.iconUrl,
                iconFile,
                iconData,
                hasKey: namedKeys.length > 0,
                error: this.errors.get(provider.id),
                disabled: Boolean(provider.disabled),
                models,
                keys: aggregateKeyStats(keyDetails),
                keyList: keyDetails,
                cooldownSeconds: this.cooldownSecondsFor(provider)
            });
        }

        return {
            providers,
            freeModels: this.freeModelsStatus(),
            offersBannerHidden: this.offersBannerHidden
        };
    }

    // ---------------------------------------------------------------
    // Key monitoring API (status bar + commands)
    // ---------------------------------------------------------------

    /** Model of the most recent chat request, if any. */
    get lastUsedModel(): { name: string; providerId: string } | undefined {
        if (!this.lastUsedModelName || !this.lastUsedProviderId) {
            return undefined;
        }

        return {
            name: this.lastUsedModelName,
            providerId: this.lastUsedProviderId
        };
    }

    /**
     * Detailed key status per provider, for the status bar menu and the
     * key monitor.
     */
    async getKeyDetails(): Promise<
        {
            providerId: string;
            providerName: string;
            cooldownSeconds: number;
            ready: number;
            cooldown: number;
            burned: number;
            keys: NamedKeyDetail[];
        }[]
    > {
        const details = [];

        for (const provider of this.providers) {
            const namedKeys = await this.resolveNamedKeys(provider);
            const snapshots: NamedKeyDetail[] = this.keys
                .snapshot(provider.id, namedKeyValues(namedKeys))
                .map((detail, index) => ({
                    ...detail,
                    name: namedKeys[index]?.name
                }));

            details.push({
                providerId: provider.id,
                providerName: provider.name,
                cooldownSeconds: this.cooldownSecondsFor(provider),
                ready: snapshots.filter(k => k.status === 'ready')
                    .length,
                cooldown: snapshots.filter(
                    k => k.status === 'cooldown'
                ).length,
                burned: snapshots.filter(k => k.status === 'burned')
                    .length,
                keys: snapshots
            });
        }

        return details;
    }

    resetCooldowns(providerId?: string): void {
        this.keys.resetCooldowns(providerId);

        vscode.window.setStatusBarMessage(
            'Router Models: cooldowns reset.',
            4000
        );
    }

    // ---------------------------------------------------------------
    // Command palette flows
    // ---------------------------------------------------------------

    private async pickProvider(
        placeHolder: string
    ): Promise<ProviderConfig | undefined> {
        if (this.providers.length === 0) {
            vscode.window.showInformationMessage(
                'No providers configured. Use ' +
                    '"Router Models: Add Provider" first.'
            );

            return undefined;
        }

        const picked = await vscode.window.showQuickPick(
            this.providers.map(provider => ({
                label: provider.name,
                description: provider.id,
                detail: provider.baseUrl,
                provider
            })),
            { placeHolder, ignoreFocusOut: true }
        );

        return picked?.provider;
    }

    // ---------------------------------------------------------------
    // JSON import
    // ---------------------------------------------------------------

    /**
     * Lets the user pick a JSON file, searches it (up to 4 object
     * levels deep) for `providerConnections` lists, groups the
     * connections by their `providerSpecificData.prefix` — one
     * provider receives all of its API keys — and imports them with
     * the keys stored securely.
     */
    async importFromJsonFile(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: false,
            openLabel: 'Import',
            title: 'Router Models: Import providers from JSON',
            filters: {
                'JSON files': ['json'],
                'All files': ['*']
            }
        });

        if (!uris || uris.length === 0) {
            return;
        }

        const fileUri = uris[0];
        const fileName = path.basename(fileUri.fsPath);

        let buffer: Buffer;

        try {
            buffer = await fs.readFile(fileUri.fsPath);
        } catch (error) {
            vscode.window.showErrorMessage(
                `Router Models: could not read ${fileName} — ` +
                    toErrorMessage(error)
            );

            return;
        }

        const content = decodeTextFile(buffer);

        let parsed: unknown;

        try {
            parsed = JSON.parse(content);
        } catch (error) {
            vscode.window.showErrorMessage(
                `Router Models: ${fileName} ` +
                    `(${(buffer.length / 1024).toFixed(1)} KB, fully ` +
                    'read) is not valid JSON — ' +
                    toErrorMessage(error)
            );

            return;
        }

        // The extension's own export format is handled first: the
        // generic `providerConnections` search below would find
        // nothing in it.
        if (isRouterModelsExport(parsed)) {
            await this.importOwnExport(parsed, fileName);

            return;
        }

        const candidates = parseConnections(parsed);

        if (candidates.length === 0) {
            vscode.window.showWarningMessage(
                `Router Models: no "providerConnections" list was ` +
                    `found in ${fileName} ` +
                    `(${(buffer.length / 1024).toFixed(1)} KB, searched ` +
                    `${MAX_SEARCH_DEPTH} levels deep).`
            );

            return;
        }

        // API keys that are already stored, for de-duplication.
        const knownKeys = new Map<string, string>();

        for (const provider of this.providers) {
            for (const key of await this.getKeys(provider)) {
                if (!knownKeys.has(key)) {
                    knownKeys.set(key, provider.name);
                }
            }
        }

        const imported: string[] = [];
        const skipped: { label: string; reason: string }[] = [];
        const noKey: string[] = [];
        const alreadyKnown: string[] = [];
        const failed: { label: string; reason: string }[] = [];

        await this.importCandidates(candidates, knownKeys,
            imported, skipped, noKey, alreadyKnown, failed
        );

        this.reportImportResult(
            fileName,
            imported,
            skipped,
            noKey,
            alreadyKnown,
            failed
        );
    }

    /**
     * Imports the parsed connections: those sharing a
     * `providerSpecificData.prefix` belong to one upstream provider,
     * so they are merged into a single provider that receives all of
     * their API keys. Individual failures are collected, not fatal.
     */
    private async importCandidates(
        candidates: ParsedConnection[],
        knownKeys: Map<string, string>,
        imported: string[],
        skipped: { label: string; reason: string }[],
        noKey: string[],
        alreadyKnown: string[],
        failed: { label: string; reason: string }[]
    ): Promise<void> {
        const groups = groupConnections(candidates);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title:
                    `Router Models: importing ${groups.length} ` +
                    'provider(s) from JSON…',
                cancellable: false
            },
            async progress => {
                const step = 100 / groups.length;

                for (const [index, group] of groups.entries()) {
                    progress.report({
                        increment: step,
                        message:
                            `(${index + 1}/${groups.length}) ` +
                            group.name
                    });

                    if (group.apiKeys.length === 0) {
                        noKey.push(group.name);
                        skipped.push({
                            label: group.name,
                            reason:
                                'no API key in the JSON ' +
                                `(${group.connections} connection(s))`
                        });

                        continue;
                    }

                    // Drop keys that are already stored somewhere.
                    const freshKeys = group.apiKeys.filter(
                        key => !knownKeys.has(key)
                    );

                    if (freshKeys.length === 0) {
                        alreadyKnown.push(group.name);
                        skipped.push({
                            label: group.name,
                            reason:
                                `all ${group.apiKeys.length} key(s) ` +
                                'already imported as ' +
                                `"${knownKeys.get(group.apiKeys[0])}"`
                        });

                        continue;
                    }

                    if (!group.baseUrl) {
                        skipped.push({
                            label: group.name,
                            reason:
                                'no base URL in the JSON ' +
                                `(${group.connections} connection(s))`
                        });
                        failed.push({
                            label: group.name,
                            reason:
                                'no base URL in the JSON ' +
                                `(${group.connections} connection(s))`
                        });

                        continue;
                    }

                    try {
                        const target = this.mergeTarget(
                            group.id,
                            group.name,
                            group.baseUrl
                        );

                        if (target) {
                            // Known provider: append the new keys
                            // (updateProvider merges into the stored
                            // keys, nothing is replaced).
                            await this.updateProvider(target.id, {
                                apiKeys: freshKeys
                            });

                            imported.push(
                                `${group.name}: ` +
                                    `+${freshKeys.length} new key(s)`
                            );
                        } else {
                            const provider = await this.addProvider({
                                name: this.uniqueImportName(group.name),
                                id: group.id,
                                baseUrl: group.baseUrl,
                                apiKeys: coerceNamedKeys(freshKeys)
                            });

                            imported.push(
                                `${provider.name} ` +
                                    `(${freshKeys.length} key(s))`
                            );
                        }

                        for (const key of freshKeys) {
                            knownKeys.set(key, group.name);
                        }
                    } catch (error) {
                        const reason = toErrorMessage(error);
                        skipped.push({
                            label: group.name,
                            reason
                        });
                        failed.push({
                            label: group.name,
                            reason
                        });
                    }
                }
            }
        );
    }

    /**
     * Reports the import outcome in a category-aware way:
     *
     * - Something was imported → success info message.
     * - Only "no key" and "already known" → informational message that
     *   tells the user WHY (exported without keys / nothing new to add).
     * - Real failures → warning with the first failure detail.
     */
    private reportImportResult(
        fileName: string,
        imported: string[],
        skipped: { label: string; reason: string }[],
        noKey: string[],
        alreadyKnown: string[],
        failed: { label: string; reason: string }[]
    ): void {
        // Build a short "first few" helper for any list.
        const showFew = (list: string[], max = 4): string => {
            const shown = list.slice(0, max).join(', ');
            return list.length > max
                ? `${shown} … +${list.length - max} more`
                : shown;
        };

        // Collect real failure messages (exclude the alreadyKnown /
        // noKey cases, which are expected, not errors).
        const firstFailure = failed[0];

        if (imported.length > 0) {
            const shown = showFew(imported);
            const more =
                imported.length > 4
                    ? ` … +${imported.length - 4} more`
                    : '';
            const parts: string[] = [
                `imported ${imported.length} provider(s) from ${fileName} ` +
                    `(${shown}${more})`
            ];
            if (skipped.length > 0) {
                parts.push(`${skipped.length} skipped`);
            }
            if (failed.length > 0) {
                parts.push(
                    `${failed.length} failed ` +
                        `(first: ${firstFailure.label} — ` +
                        `${firstFailure.reason})`
                );
            }
            vscode.window.showInformationMessage(
                `Router Models: ${parts.join(', ')}.`
            );
            return;
        }

        // Nothing was imported — explain why, per category.
        if (noKey.length > 0 || alreadyKnown.length > 0) {
            const parts: string[] = [];

            if (noKey.length > 0) {
                parts.push(
                    `${noKey.length} provider(s) have no API key in this ` +
                        `backup (${showFew(noKey)}) — export WITH keys ` +
                        `to import them`
                );
            }
            if (alreadyKnown.length > 0) {
                parts.push(
                    `${alreadyKnown.length} provider(s) already exist with ` +
                        `the same keys (${showFew(alreadyKnown)})`
                );
            }
            if (failed.length > 0) {
                parts.push(
                    `${failed.length} failed (first: ${firstFailure.label} ` +
                        `— ${firstFailure.reason})`
                );
            }

            vscode.window.showInformationMessage(
                `Router Models: ${parts.join('; ')}.`
            );
            return;
        }

        // Only real failures (or empty file) → warning.
        vscode.window.showWarningMessage(
            `Router Models: nothing was imported from ${fileName} — ` +
                `${skipped.length} connection(s) skipped` +
                (failed.length > 0
                    ? ` (first: ${failed[0].label} — ${failed[0].reason})`
                    : '') +
                '.'
        );
    }

    /**
     * Existing provider a group should be merged into: same slug /
     * id or same name AND the same endpoint — otherwise it is a
     * different service that merely shares a name.
     */
    private mergeTarget(
        id: string,
        name: string,
        baseUrl: string
    ): ProviderConfig | undefined {
        const requested = slugify(id);
        const endpoint = this.normalizeBaseUrl(baseUrl);

        return this.providers.find(
            provider =>
                (provider.id === requested ||
                    provider.name.toLowerCase() ===
                        name.toLowerCase()) &&
                provider.baseUrl === endpoint
        );
    }

    /** Import-time name that never clashes with existing providers. */
    private uniqueImportName(base?: string): string {
        const name = base?.trim() || 'Imported Provider';

        const taken = (candidate: string): boolean =>
            this.providers.some(
                p => p.name.toLowerCase() === candidate.toLowerCase()
            );

        if (!taken(name)) {
            return name;
        }

        let suffix = 2;

        while (taken(`${name} ${suffix}`)) {
            suffix++;
        }

        return `${name} ${suffix}`;
    }

    // ---------------------------------------------------------------
    // JSON export
    // ---------------------------------------------------------------

    /**
     * Writes every provider (endpoint, icon, cooldown, models and —
     * optionally — the API keys) into a JSON file that
     * `Router Models: Import Providers from JSON` understands, so the
     * setup can be moved to another machine or kept as a backup.
     */
    async exportToJsonFile(): Promise<void> {
        if (this.providers.length === 0) {
            vscode.window.showInformationMessage(
                'No providers to export. Use ' +
                    '"Router Models: Add Provider" first.'
            );

            return;
        }

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: 'Export WITHOUT API keys',
                    description:
                        'Providers and models only — safe to share',
                    includeKeys: false
                },
                {
                    label: 'Export WITH API keys',
                    description:
                        'Keys are written as plain text — keep the ' +
                        'file private',
                    includeKeys: true
                }
            ],
            {
                placeHolder:
                    'Router Models: include the API keys in the export?',
                ignoreFocusOut: true
            }
        );

        if (!choice) {
            return;
        }

        const exportFile = await this.buildExport(choice.includeKeys);
        const stamp = new Date().toISOString().slice(0, 10);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(
                `router-models-export-${stamp}.json`
            ),
            title: 'Router Models: Export providers to JSON',
            saveLabel: 'Export',
            filters: {
                'JSON files': ['json'],
                'All files': ['*']
            }
        });

        if (!uri) {
            return;
        }

        try {
            await fs.writeFile(
                uri.fsPath,
                JSON.stringify(exportFile, null, 2),
                'utf8'
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                'Router Models: could not write the export file — ' +
                    toErrorMessage(error)
            );

            return;
        }

        vscode.window.showInformationMessage(
            `Router Models: exported ${this.providers.length} ` +
                `provider(s) to ${path.basename(uri.fsPath)} ` +
                (choice.includeKeys
                    ? 'including the API keys — keep the file private!'
                    : 'without API keys.')
        );
    }

    /** Collects everything worth exporting into the export format. */
    private async buildExport(
        includeKeys: boolean
    ): Promise<ExportFile> {
        const config =
            vscode.workspace.getConfiguration('routerModels');
        const providers: ExportedProvider[] = [];

        for (const provider of this.providers) {
            const entry: ExportedProvider = {
                id: provider.id,
                name: provider.name,
                baseUrl: provider.baseUrl
            };

            if (provider.iconUrl) {
                entry.iconUrl = provider.iconUrl;
            }

            if (typeof provider.cooldownSeconds === 'number') {
                entry.cooldownSeconds = provider.cooldownSeconds;
            }

            if (includeKeys) {
                const named = await this.resolveNamedKeys(provider);

                if (named.length > 0) {
                    entry.apiKeys = named.map(item =>
                        item.name
                            ? { name: item.name, key: item.key }
                            : item.key
                    );
                }
            }

            const models = this.cache.get(provider.id);

            if (models && models.length > 0) {
                entry.models = models.map(model => ({ ...model }));
            }

            providers.push(entry);
        }

        return {
            kind: RouterProvider.EXPORT_KIND,
            version: RouterProvider.EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            settings: {
                includePatterns: config.get<string[]>(
                    'includePatterns',
                    []
                ),
                excludePatterns: config.get<string[]>(
                    'excludePatterns',
                    []
                )
            },
            providers
        };
    }

    // ---------------------------------------------------------------
    // Import of the extension's own export format
    // ---------------------------------------------------------------

    /**
     * Imports a file written by this extension's export command. The
     * user chooses between merging into the existing setup or
     * replacing it entirely.
     */
    private async importOwnExport(
        file: ExportFile,
        fileName: string
    ): Promise<void> {
        if (
            typeof file.version === 'number' &&
            file.version > RouterProvider.EXPORT_VERSION
        ) {
            vscode.window.showWarningMessage(
                `Router Models: ${fileName} was written by a newer ` +
                    `export version (${file.version}) — importing ` +
                    'best-effort.'
            );
        }

        const valid = file.providers.filter(
            entry =>
                entry &&
                typeof entry === 'object' &&
                typeof entry.name === 'string' &&
                entry.name.trim().length > 0 &&
                typeof entry.baseUrl === 'string' &&
                entry.baseUrl.trim().length > 0
        );

        const invalid = file.providers.length - valid.length;

        if (valid.length === 0) {
            vscode.window.showWarningMessage(
                `Router Models: ${fileName} contains no importable ` +
                    'providers (every entry needs a name and a base ' +
                    'URL).'
            );

            return;
        }

        const mode = await vscode.window.showQuickPick(
            [
                {
                    label: 'Merge with existing providers',
                    description:
                        'Adds new providers, merges keys and models, ' +
                        'keeps everything already configured',
                    value: 'merge'
                },
                {
                    label: 'Replace all providers',
                    description:
                        'Removes every existing provider first — ' +
                        'full restore',
                    value: 'replace'
                }
            ],
            {
                placeHolder:
                    `Router Models: import ${valid.length} ` +
                    `provider(s) from ${fileName}`,
                ignoreFocusOut: true
            }
        );

        if (!mode) {
            return;
        }

        const replace = mode.value === 'replace';

        if (replace) {
            const confirmed = await vscode.window.showWarningMessage(
                `Replace ALL existing providers with the ` +
                    `${valid.length} provider(s) from ${fileName}?`,
                { modal: true },
                'Replace'
            );

            if (confirmed !== 'Replace') {
                return;
            }

            await this.clearAllProviders();

            if (file.settings) {
                await this.applyExportedSettings(file.settings);
            }
        }

        let added = 0;
        let updated = 0;
        const skipped: { label: string; reason: string }[] = [];

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title:
                    `Router Models: importing ${valid.length} ` +
                    'provider(s)…',
                cancellable: false
            },
            async progress => {
                const step = 100 / valid.length;

                for (const [index, entry] of valid.entries()) {
                    progress.report({
                        increment: step,
                        message:
                            `(${index + 1}/${valid.length}) ` +
                            entry.name
                    });

                    try {
                        const result = await this.importOneExported(
                            entry,
                            !replace
                        );

                        if (result === 'added') {
                            added++;
                        } else {
                            updated++;
                        }
                    } catch (error) {
                        skipped.push({
                            label: entry.name,
                            reason: toErrorMessage(error)
                        });
                    }
                }
            }
        );

        this.reportOwnImportResult(
            fileName,
            added,
            updated,
            skipped,
            invalid
        );
    }

    /**
     * Imports one exported provider: adds it when new, otherwise
     * merges endpoint, icon, cooldown, keys and models into the
     * existing provider.
     */
    private async importOneExported(
        entry: ExportedProvider,
        merge: boolean
    ): Promise<'added' | 'updated'> {
        const name = entry.name.trim();
        const baseUrl = this.normalizeBaseUrl(entry.baseUrl);
        const keys = coerceNamedKeys(entry.apiKeys ?? []);

        const target = merge
            ? this.ownMergeTarget(entry.id, name)
            : undefined;

        if (target) {
            // Merge into the stored keys — nothing is replaced.
            await this.updateProvider(target.id, {
                baseUrl,
                apiKeys: keys,
                ...(entry.iconUrl
                    ? { iconUrl: entry.iconUrl }
                    : {}),
                ...(typeof entry.cooldownSeconds === 'number'
                    ? { cooldownSeconds: entry.cooldownSeconds }
                    : {})
            });

            if (entry.models?.length) {
                await this.mergeExportedModels(
                    target.id,
                    entry.models
                );
            }

            return 'updated';
        }

        const provider = await this.addProvider({
            name: this.uniqueImportName(name),
            id: entry.id,
            baseUrl,
            apiKeys: keys,
            iconUrl: entry.iconUrl,
            cooldownSeconds:
                typeof entry.cooldownSeconds === 'number'
                    ? entry.cooldownSeconds
                    : null
        });

        if (entry.models?.length) {
            await this.mergeExportedModels(provider.id, entry.models);
        }

        return 'added';
    }

    /**
     * Existing provider an exported provider should merge into: the
     * exact id wins, otherwise a case-insensitive name match.
     */
    private ownMergeTarget(
        id: string | undefined,
        name: string
    ): ProviderConfig | undefined {
        const requested = id ? slugify(id) : '';

        if (requested) {
            const byId = this.providers.find(
                provider => provider.id === requested
            );

            if (byId) {
                return byId;
            }
        }

        const lower = name.toLowerCase();

        return this.providers.find(
            provider => provider.name.toLowerCase() === lower
        );
    }

    /**
     * Merges exported model entries into the cache: missing models
     * are added, existing ones only gain missing flags (manual / free
     * / names) — nothing the user configured locally is removed.
     */
    private async mergeExportedModels(
        providerId: string,
        models: ModelEntry[]
    ): Promise<void> {
        const entries = this.cache.get(providerId) ?? [];
        let changed = false;

        for (const model of models) {
            if (!model || typeof model.id !== 'string') {
                continue;
            }

            const id = model.id.trim();

            if (!id) {
                continue;
            }

            const existing = entries.find(entry => entry.id === id);

            if (!existing) {
                const copy: ModelEntry = { id };

                if (
                    typeof model.name === 'string' &&
                    model.name.trim()
                ) {
                    copy.name = model.name.trim();
                }

                if (typeof model.context_length === 'number') {
                    copy.context_length = model.context_length;
                }

                if (typeof model.max_input_tokens === 'number') {
                    copy.max_input_tokens = model.max_input_tokens;
                }

                if (typeof model.max_output_tokens === 'number') {
                    copy.max_output_tokens = model.max_output_tokens;
                }

                if (model.manual) {
                    copy.manual = true;
                }

                if (model.free) {
                    copy.free = true;
                }

                entries.push(copy);
                changed = true;

                continue;
            }

            if (model.manual && !existing.manual) {
                existing.manual = true;
                changed = true;
            }

            if (model.free && !existing.free) {
                existing.free = true;
                changed = true;
            }

            if (
                !existing.name &&
                typeof model.name === 'string' &&
                model.name.trim()
            ) {
                existing.name = model.name.trim();
                changed = true;
            }

            if (
                !existing.context_length &&
                typeof model.context_length === 'number'
            ) {
                existing.context_length = model.context_length;
                changed = true;
            }

            if (
                !existing.max_input_tokens &&
                typeof model.max_input_tokens === 'number'
            ) {
                existing.max_input_tokens = model.max_input_tokens;
                changed = true;
            }

            if (
                !existing.max_output_tokens &&
                typeof model.max_output_tokens === 'number'
            ) {
                existing.max_output_tokens = model.max_output_tokens;
                changed = true;
            }
        }

        if (changed) {
            this.cache.set(providerId, entries);
            await this.saveCache();
            this.fireChanged();
        }
    }

    /** Removes every provider (secrets, icons, cache included). */
    private async clearAllProviders(): Promise<void> {
        for (const provider of this.providers) {
            try {
                await this.secrets.delete(this.secretKey(provider.id));
                await this.secrets.delete(
                    RouterProvider.KEYS_SECRET_PREFIX + provider.id
                );
            } catch {
                // Best-effort cleanup.
            }

            this.keys.clearStates(provider.id);

            await this.deleteIconFiles(provider.id).catch(() => {
                // Best-effort cleanup.
            });
        }

        this.providers = [];
        this.cache.clear();
        this.errors.clear();

        if (this.syncKeysApplied) {
            await this.context.globalState.update(
                RouterProvider.SYNC_KEYS_KEY,
                {}
            );
        }

        await this.saveProviders();
        await this.saveCache();
        this.fireChanged();
    }

    /** Applies the include/exclude patterns from an export file. */
    private async applyExportedSettings(
        settings: NonNullable<ExportFile['settings']>
    ): Promise<void> {
        const config =
            vscode.workspace.getConfiguration('routerModels');

        if (Array.isArray(settings.includePatterns)) {
            await config.update(
                'includePatterns',
                settings.includePatterns.filter(
                    pattern => typeof pattern === 'string'
                ),
                vscode.ConfigurationTarget.Global
            );
        }

        if (Array.isArray(settings.excludePatterns)) {
            await config.update(
                'excludePatterns',
                settings.excludePatterns.filter(
                    pattern => typeof pattern === 'string'
                ),
                vscode.ConfigurationTarget.Global
            );
        }
    }

    private reportOwnImportResult(
        fileName: string,
        added: number,
        updated: number,
        skipped: { label: string; reason: string }[],
        invalid: number
    ): void {
        const parts: string[] = [];

        if (added > 0) {
            parts.push(`${added} added`);
        }

        if (updated > 0) {
            parts.push(`${updated} updated`);
        }

        const summary =
            parts.length > 0 ? parts.join(', ') : 'nothing changed';
        const first = skipped[0];

        vscode.window.showInformationMessage(
            `Router Models: import from ${fileName} finished — ` +
                `${summary}` +
                (skipped.length > 0
                    ? `, ${skipped.length} skipped (first: ` +
                      `${first.label} — ${first.reason})`
                    : '') +
                (invalid > 0
                    ? `, ${invalid} invalid entries ignored`
                    : '') +
                '.'
        );
    }

    async addProviderFlow(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Provider name',
            placeHolder: 'OpenRouter',
            ignoreFocusOut: true
        });

        if (!name) {
            return;
        }

        const id = await vscode.window.showInputBox({
            prompt: 'Provider id (unique, used internally)',
            value: slugify(name),
            ignoreFocusOut: true,
            validateInput: value =>
                /^[a-z0-9-]*$/i.test(value.trim())
                    ? undefined
                    : 'Use letters, numbers and dashes only.'
        });

        if (id === undefined) {
            return;
        }

        const baseUrl = await vscode.window.showInputBox({
            prompt: 'OpenAI-compatible base URL',
            placeHolder: 'https://api.openai.com/v1',
            value: 'https://api.openai.com/v1',
            ignoreFocusOut: true
        });

        if (!baseUrl) {
            return;
        }

        const apiKey = await vscode.window.showInputBox({
            prompt: 'API key (leave empty for local endpoints)',
            password: true,
            ignoreFocusOut: true
        });

        if (apiKey === undefined) {
            return;
        }

        const iconUrl = await vscode.window.showInputBox({
            prompt: 'Icon image URL (optional)',
            placeHolder: 'https://example.com/logo.png',
            ignoreFocusOut: true
        });

        if (iconUrl === undefined) {
            return;
        }

        try {
            const provider = await this.addProvider({
                name,
                id,
                baseUrl,
                apiKey: apiKey || undefined,
                iconUrl: iconUrl || undefined
            });

            vscode.window.showInformationMessage(
                `${provider.name} added successfully.`
            );
        } catch (error) {
            vscode.window.showErrorMessage(toErrorMessage(error));
        }
    }

    async editProviderFlow(): Promise<void> {
        const provider = await this.pickProvider(
            'Select a provider to edit'
        );

        if (!provider) {
            return;
        }

        const field = await vscode.window.showQuickPick(
            [
                {
                    label: '$(pencil) Name',
                    description: provider.name,
                    action: 'name' as const
                },
                {
                    label: '$(link) Base URL',
                    description: provider.baseUrl,
                    action: 'baseUrl' as const
                },
                {
                    label: '$(key) API keys',
                    description: 'Set, replace or remove',
                    action: 'apiKey' as const
                },
                {
                    label: '$(clock) Cooldown (seconds)',
                    description: String(
                        provider.cooldownSeconds ??
                            vscode.workspace
                                .getConfiguration('routerModels')
                                .get<number>(
                                    'defaultCooldownSeconds',
                                    60
                                )
                    ),
                    action: 'cooldownSeconds' as const
                },
                {
                    label: '$(file-media) Icon URL',
                    description: provider.iconUrl ?? 'Not set',
                    action: 'iconUrl' as const
                }
            ],
            {
                placeHolder: `Edit ${provider.name}`,
                ignoreFocusOut: true
            }
        );

        if (!field) {
            return;
        }

        try {
            if (field.action === 'apiKey') {
                const choice =
                    await vscode.window.showQuickPick(
                        ['Set API key', 'Remove API key'],
                        {
                            placeHolder: 'Update API key',
                            ignoreFocusOut: true
                        }
                    );

                if (!choice) {
                    return;
                }

                if (choice === 'Remove API key') {
                    await this.updateProvider(provider.id, {
                        apiKey: null
                    });
                } else {
                    const apiKey =
                        await vscode.window.showInputBox({
                            prompt: 'API key (leave empty to cancel)',
                            password: true,
                            ignoreFocusOut: true
                        });

                    if (!apiKey) {
                        return;
                    }

                    await this.updateProvider(provider.id, {
                        apiKey
                    });
                }
            } else {
                const prompts: Record<string, vscode.InputBoxOptions> =
                    {
                        name: {
                            prompt: 'Provider name',
                            value: provider.name
                        },
                        baseUrl: {
                            prompt: 'OpenAI-compatible base URL',
                            value: provider.baseUrl
                        },
                        iconUrl: {
                            prompt:
                                'Icon image URL (leave empty to keep current)',
                            value: provider.iconUrl
                        },
                        cooldownSeconds: {
                            prompt:
                                'Cooldown in seconds for keys after a 429 (empty keeps current)',
                            value: String(
                                provider.cooldownSeconds ??
                                    vscode.workspace
                                        .getConfiguration(
                                            'routerModels'
                                        )
                                        .get<number>(
                                            'defaultCooldownSeconds',
                                            60
                                        )
                            )
                        }
                    };

                const options = prompts[field.action];

                if (!options) {
                    return;
                }

                const value = await vscode.window.showInputBox({
                    ...options,
                    ignoreFocusOut: true
                });

                if (value === undefined) {
                    return;
                }

                if (field.action === 'cooldownSeconds') {
                    const seconds = Number(value.trim());

                    if (
                        !value.trim() ||
                        !Number.isFinite(seconds) ||
                        seconds < 0
                    ) {
                        return;
                    }

                    await this.updateProvider(provider.id, {
                        cooldownSeconds: seconds
                    });
                } else {
                    const current =
                        field.action === 'name'
                            ? provider.name
                            : field.action === 'baseUrl'
                              ? provider.baseUrl
                              : provider.iconUrl ?? '';

                    if (value === current) {
                        return;
                    }

                    await this.updateProvider(provider.id, {
                        [field.action]: value
                    } as {
                        name?: string;
                        baseUrl?: string;
                        iconUrl?: string;
                    });
                }
            }

            vscode.window.showInformationMessage(
                `${provider.name} updated.`
            );
        } catch (error) {
            vscode.window.showErrorMessage(toErrorMessage(error));
        }
    }

    async removeProviderFlow(): Promise<void> {
        const provider = await this.pickProvider(
            'Select a provider to remove'
        );

        if (!provider) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Remove provider "${provider.name}"?`,
            { modal: true },
            'Remove'
        );

        if (confirm !== 'Remove') {
            return;
        }

        await this.removeProvider(provider.id);
    }

    async addModelFlow(): Promise<void> {
        const provider = await this.pickProvider(
            'Select a provider for the model'
        );

        if (!provider) {
            return;
        }

        const modelId = await vscode.window.showInputBox({
            prompt: `Model id for ${provider.name}`,
            placeHolder: 'deepseek-chat',
            ignoreFocusOut: true
        });

        if (!modelId) {
            return;
        }

        const name = await vscode.window.showInputBox({
            prompt: 'Display name (optional)',
            ignoreFocusOut: true
        });

        if (name === undefined) {
            return;
        }

        const freePick = await vscode.window.showQuickPick(
            [
                {
                    label: 'No',
                    description: 'Regular model'
                },
                {
                    label: 'Yes',
                    description:
                        'Tag it "free" so typing "free" in the model ' +
                        'picker finds it'
                }
            ],
            {
                placeHolder: 'Is this a free model?',
                ignoreFocusOut: true
            }
        );

        if (!freePick) {
            return;
        }

        try {
            await this.addManualModel(
                provider.id,
                modelId,
                name || undefined,
                freePick.label === 'Yes'
            );
        } catch (error) {
            vscode.window.showErrorMessage(toErrorMessage(error));
        }
    }

    // ---------------------------------------------------------------
    // Language model provider
    // ---------------------------------------------------------------

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (this.providers.length === 0 && !options.silent) {
            await this.addProviderFlow();
        }

        this.rebuildResolved();

        if (!options.silent) {
            for (const provider of this.providers) {
                const hasModels =
                    this.modelsFor(provider).length > 0;

                if (!hasModels && !this.errors.has(provider.id)) {
                    this.triggerRefresh(provider.id);
                }
            }
        }

        const infos: vscode.LanguageModelChatInformation[] = [];

        for (const [key, value] of this.resolved) {
            if (!this.isVisible(value.model.id)) {
                continue;
            }

            const baseName = value.model.name || value.model.id;
            const free = this.isFreeModel(value.provider, value.model);

            infos.push({
                id: key,
                name: free && !/\bfree\b/i.test(baseName)
                    ? `${baseName} (free) - ${value.provider.name}`
                    : `${baseName} - ${value.provider.name}`,
                family: value.provider.name,
                version: '1.0',
                maxInputTokens: this.maxInputTokens(value.model),
                maxOutputTokens: this.maxOutputTokens(value.model),
                tooltip: free
                    ? `${value.provider.name} • ${value.model.id} • free`
                    : `${value.provider.name} • ${value.model.id}`,
                detail: value.provider.baseUrl,
                capabilities: {
                    imageInput: false,
                    toolCalling: true
                }
            });
        }

        return infos;
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const selected = this.resolved.get(model.id);

        if (!selected) {
            throw new Error(`Model not found: ${model.id}`);
        }

        this.lastUsedModelName = model.name || model.id;
        this.lastUsedProviderId = selected.provider.id;

        const config = vscode.workspace.getConfiguration(
            'routerModels'
        );

        const temperature = config.get<number>(
            'defaultTemperature',
            0.2
        );

        const maxRetries = Math.max(
            0,
            Math.min(20, config.get<number>('maxRetries', 5))
        );

        const retryBackoffMs = Math.max(
            0,
            Math.min(60000, config.get<number>('retryBackoffMs', 1000))
        );

        // A connection that drops after the model already started
        // answering is retried too (the retried text is appended),
        // because for long unattended runs a hard stop is worse than
        // a repeated line.
        const retryMidStream = config.get<boolean>(
            'retryMidStreamErrors',
            true
        );

        const showReasoning = config.get<boolean>(
            'showReasoning',
            true
        );

        const openAiMessages = convertMessages(messages);
        const tools = convertTools(options.tools);
        const toolChoice = convertToolChoice(
            options.toolMode,
            Boolean(tools?.length)
        );

        const maxAttempts = maxRetries + 1;
        let lastError: unknown;
        let attempt = 0;

        while (attempt < maxAttempts) {
            // Space retries out with a growing delay so a transient
            // outage (the usual cause of "terminated") has time to
            // clear instead of burning every retry within a second.
            if (attempt > 0) {
                await this.backoff(attempt, retryBackoffMs, token);
            }

            const keys = await this.getKeys(selected.provider);

            // Throws a descriptive error when no key is configured.
            const picked = this.keys.pickKey(
                selected.provider.id,
                keys
            );

            attempt++;

            try {
                const result = await this.attemptChatResponse(
                    selected,
                    picked.key,
                    {
                        model: selected.model.id,
                        messages: openAiMessages,
                        stream: true,
                        temperature,
                        ...(tools ? { tools } : {}),
                        ...(toolChoice
                            ? { tool_choice: toolChoice }
                            : {})
                    },
                    progress,
                    token,
                    showReasoning
                );

                if (result.producedOutput) {
                    return;
                }

                // Empty stream (e.g. Gemini's `delta: {}` ending or a
                // dropped connection): retry with the same/next key.
                lastError = new Error(
                    'The model returned an empty response.'
                );
            } catch (error) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                // A failure after output was already streamed would
                // duplicate the delivered content if retried. Only a
                // dropped connection is retried (opt-in), and never
                // once a tool call was delivered (the agent would run
                // it twice); everything else is final.
                if (error instanceof MidStreamFailureError) {
                    const cause = error.cause;

                    if (
                        !retryMidStream ||
                        error.deliveredToolCall ||
                        !isNetworkError(cause) ||
                        attempt >= maxAttempts
                    ) {
                        throw this.wrapFinalError(
                            cause,
                            selected,
                            attempt
                        );
                    }

                    lastError = cause;
                } else {
                    // Key-independent failures (bad request, unknown
                    // model, invalid auth of the request itself) fail
                    // fast instead of burning through the other keys.
                    const status =
                        error instanceof ProviderHttpError
                            ? error.status
                            : undefined;

                    if (
                        status !== undefined &&
                        status !== 429 &&
                        status !== 402 &&
                        status !== 408 &&
                        !isAuthFailure(status) &&
                        !isServerFallback(status)
                    ) {
                        throw this.wrapFinalError(
                            error,
                            selected,
                            attempt
                        );
                    }

                    lastError = error;
                }
            }
        }

        throw this.wrapFinalError(lastError, selected, attempt);
    }

    /**
     * Wraps the last error from all retry attempts into a clean,
     * user-friendly message that includes the provider name, model id,
     * and a parsed version of the HTTP error body.
     */
    private wrapFinalError(
        error: unknown,
        selected: ResolvedModel,
        attempts = 0
    ): Error {
        const providerName = selected.provider.name;
        const modelId = selected.model.id;
        const prefix = `[${providerName}] ${modelId}: `;

        const retried =
            attempts > 1 ? ` (retried ${attempts - 1} times)` : '';

        let body: string;

        if (error instanceof ProviderHttpError) {
            body = error.message + retried;
        } else if (isNetworkError(error)) {
            body =
                'The connection to the provider was dropped before the ' +
                'response finished' +
                retried +
                '. This is usually a transient network or provider ' +
                'outage; the request was retried automatically and ' +
                'still failed, so it needs a manual retry.';
        } else if (error instanceof Error) {
            body = error.message + retried;
        } else {
            body = 'The chat request failed: ' + String(error);
        }

        return new Error(prefix + body);
    }

    /**
     * Waits an exponentially growing delay before the next retry:
     * `base * 2^(attempt-1)`, capped at 30 s. Returns immediately when
     * the request is cancelled, so a user cancel never hangs.
     */
    private async backoff(
        attempt: number,
        baseMs: number,
        token: vscode.CancellationToken
    ): Promise<void> {
        if (baseMs <= 0 || token.isCancellationRequested) {
            return;
        }

        const delayMs = Math.min(baseMs * 2 ** (attempt - 1), 30000);

        await new Promise<void>(resolve => {
            let disposable: vscode.Disposable | undefined;

            const done = () => {
                clearTimeout(timer);
                disposable?.dispose();
                resolve();
            };

            const timer = setTimeout(done, delayMs);

            disposable = token.onCancellationRequested(done);
        });
    }

    /**
     * Runs one chat request attempt with a specific API key and streams
     * the response to the chat. Tool calls and reasoning text are
     * forwarded to Copilot Chat without being dropped.
     */
    private async attemptChatResponse(
        selected: ResolvedModel,
        apiKey: string,
        body: Record<string, unknown>,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken,
        showReasoning: boolean
    ): Promise<{ producedOutput: boolean; producedToolCalls: boolean }> {
        const controller = new AbortController();

        token.onCancellationRequested(() => controller.abort());

        const timeoutMs = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('requestTimeoutMs', 30000);

        // The timeout only guards the handshake: once the response
        // headers arrive it is cleared, so long generations are never
        // cut off mid-stream.
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response: Response;

        try {
            response = await this.fetch(
                selected.provider,
                '/chat/completions',
                {
                    method: 'POST',
                    signal: controller.signal,
                    body: JSON.stringify(body)
                },
                apiKey
            );
        } catch (error) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            // Connection-level failure: hand over to the next key.
            throw error;
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const retryAfter = parseRetryAfter(
                response.headers.get('retry-after')
            );

            const text = await response.text().catch(() => '');

            this.markKeyFailure(
                selected.provider,
                apiKey,
                response.status,
                retryAfter,
                text
            );

            throw new ProviderHttpError(
                response.status,
                retryAfter,
                text
            );
        }

        const tools = new ToolCallAccumulator();
        let producedOutput = false;
        let producedToolCalls = false;

        const report = (part: vscode.LanguageModelResponsePart) => {
            producedOutput = true;
            progress.report(part);
        };

        const reportCompletedCall = (call: CompletedToolCall) => {
            producedToolCalls = true;
            report(
                new vscode.LanguageModelToolCallPart(
                    call.id,
                    call.name,
                    parseToolArguments(call.arguments)
                )
            );
        };

        const handleEvents = (events: StreamEvent[]): void => {
            for (const event of events) {
                if (event.type === 'text') {
                    report(
                        new vscode.LanguageModelTextPart(event.text)
                    );
                } else if (event.type === 'reasoning') {
                    // Reasoning / thinking text is never dropped: it is
                    // surfaced to the user as visible text.
                    if (showReasoning) {
                        report(
                            new vscode.LanguageModelTextPart(
                                event.text
                            )
                        );
                    }
                } else if (event.type === 'toolCall') {
                    for (const call of tools.add(event)) {
                        reportCompletedCall(call);
                    }
                } else if (event.type === 'error') {
                    throw new Error(event.message);
                }
                // `finish` is tracked implicitly by the accumulators.
            }
        };

        try {
            const contentType = (
                response.headers.get('content-type') ?? ''
            ).toLowerCase();

            if (
                contentType.includes('text/event-stream') ||
                contentType.includes('event-stream')
            ) {
                const reader = response.body?.getReader();

                if (!reader) {
                    throw new Error(
                        'Provider returned an empty body.'
                    );
                }

                const decoder = new TextDecoder();
                const parser = new OpenAiSseParser();

                while (true) {
                    if (token.isCancellationRequested) {
                        throw new vscode.CancellationError();
                    }

                    const result = await reader.read();

                    if (result.done) {
                        handleEvents(parser.end());
                        break;
                    }

                    handleEvents(
                        parser.feed(
                            decoder.decode(result.value, {
                                stream: true
                            })
                        )
                    );
                }
            } else {
                // Some routers ignore `stream: true` and answer with a
                // regular JSON completion.
                const json: unknown = await response.json();

                handleEvents(eventsFromChunk(json));
            }
        } catch (error) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            if (producedOutput) {
                throw new MidStreamFailureError(
                    error,
                    producedToolCalls
                );
            }

            throw error;
        }

        // Surface any tool call that was still pending when the stream
        // ended (arguments may have arrived fragmented).
        for (const call of tools.finish()) {
            reportCompletedCall(call);
        }

        return { producedOutput, producedToolCalls };
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }

        return Math.ceil(
            text.content
                .map(part =>
                    part instanceof
                        vscode.LanguageModelTextPart
                        ? part.value
                        : ''
                )
                .join('')
                .length / 4
        );
    }
}

