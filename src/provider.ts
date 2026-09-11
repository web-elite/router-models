import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
    aggregateKeyStats,
    isAuthFailure,
    isServerFallback,
    parseKeys,
    parseRetryAfter,
    truncate,
    KeyDetail,
    KeyManager,
    KeyStats,
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
    /** Cooldown time in seconds a key rests after a 429. */
    cooldownSeconds?: number;
};

export type ModelEntry = {
    id: string;
    name?: string;
    context_length?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
    manual?: boolean;
};

export type ModelSnapshot = {
    id: string;
    name?: string;
    manual: boolean;
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
    models: ModelSnapshot[];
    /** Multi-key statistics for this provider. */
    keys: KeyStats;
    /** Configured cooldown time in seconds. */
    cooldownSeconds: number;
};

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

    constructor(cause: unknown) {
        super('Stream failed after output was already delivered.');

        this.name = 'MidStreamFailureError';
        this.cause = cause;
    }
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
    private static readonly SECRET_PREFIX = 'router-models.apiKey.';
    /**
     * SecretStorage key holding the JSON array of API keys
     * (`SECRET_PREFIX` holds the legacy single-key format).
     */
    private static readonly KEYS_SECRET_PREFIX =
        'router-models.apiKeys.';
    private static readonly MAX_ICON_BYTES = 2 * 1024 * 1024;

    private providers: ProviderConfig[] = [];
    private cache: Map<string, ModelEntry[]> = new Map();
    private errors: Map<string, string> = new Map();
    private resolved: Map<string, ResolvedModel> = new Map();
    private refreshing: Set<string> = new Set();

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
        });

    constructor(private readonly context: vscode.ExtensionContext) {
        this.load();
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
            this.onDidChangeEmitter,
            this.onDidChangeStateEmitter
        );
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
        apiKey?: string;
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

        const keys = parseKeys(input.apiKey);

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

    async updateProvider(
        id: string,
        patch: {
            name?: string;
            baseUrl?: string;
            /** Raw input: one key per line, or comma separated. */
            apiKey?: string | null;
            /** Explicit key list (programmatic use). */
            apiKeys?: string[] | null;
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
            const keys = parseKeys(patch.apiKey ?? '');

            await this.storeKeys(id, keys);
        }

        if (patch.apiKeys !== undefined) {
            const keys = parseKeys(
                (patch.apiKeys ?? []).join('\n')
            );

            await this.storeKeys(id, keys);
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
                iconChanged = true;
            } else if (provider.iconUrl) {
                provider.iconUrl = undefined;
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
                await this.deleteIconFiles(id);
                await this.saveProviders();
            }
        }

        this.fireChanged();

        if (baseUrlChanged) {
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

    async addManualModel(
        providerId: string,
        modelId: string,
        name?: string
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
        } else {
            const entry: ModelEntry = { id: trimmedId, manual: true };

            if (name?.trim()) {
                entry.name = name.trim();
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

        if (!enabled || provider.iconUrl) {
            return;
        }

        try {
            const iconUrl = await discoverFavicon(provider.baseUrl);

            if (!iconUrl || provider.iconUrl) {
                return;
            }

            provider.iconUrl = iconUrl;
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

    private async getKeys(
        provider: ProviderConfig
    ): Promise<string[]> {
        const raw = await this.secrets.get(
            RouterProvider.KEYS_SECRET_PREFIX + provider.id
        );

        if (raw) {
            try {
                const parsed: unknown = JSON.parse(raw);

                if (Array.isArray(parsed)) {
                    const keys = parsed.filter(
                        (key): key is string =>
                            typeof key === 'string' &&
                            key.trim().length > 0
                    );

                    if (keys.length > 0) {
                        return keys;
                    }
                }
            } catch {
                // Corrupt entry: fall back to the legacy key.
            }
        }

        // Legacy single-key format (pre-multi-key versions).
        const legacy = await this.secrets.get(
            this.secretKey(provider.id)
        );

        return legacy ? [legacy] : [];
    }

    private async storeKeys(
        providerId: string,
        keys: string[]
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
            const manual = (this.cache.get(id) ?? []).filter(
                entry => entry.manual
            );

            this.cache.set(id, [...fetched, ...manual]);
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

    async getSnapshot(): Promise<{ providers: ProviderSnapshot[] }> {
        const providers: ProviderSnapshot[] = [];

        for (const provider of this.providers) {
            const keys = await this.getKeys(provider);

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
                hasKey: keys.length > 0,
                error: this.errors.get(provider.id),
                models,
                keys: aggregateKeyStats(
                    this.keys.snapshot(provider.id, keys)
                ),
                cooldownSeconds: this.cooldownSecondsFor(provider)
            });
        }

        return { providers };
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
            keys: KeyDetail[];
        }[]
    > {
        const details = [];

        for (const provider of this.providers) {
            const keys = await this.getKeys(provider);
            const snapshots = this.keys.snapshot(
                provider.id,
                keys
            );

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

        await this.importCandidates(candidates, knownKeys,
            imported, skipped
        );

        this.reportImportResult(fileName, imported, skipped);
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
        skipped: { label: string; reason: string }[]
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

                        continue;
                    }

                    try {
                        const target = this.mergeTarget(
                            group.id,
                            group.name,
                            group.baseUrl
                        );

                        if (target) {
                            // Known provider: append the new keys.
                            const existing =
                                await this.getKeys(target);

                            await this.updateProvider(target.id, {
                                apiKeys: [...existing, ...freshKeys]
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
                                apiKey: freshKeys.join('\n')
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
                        skipped.push({
                            label: group.name,
                            reason: toErrorMessage(error)
                        });
                    }
                }
            }
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

    private reportImportResult(
        fileName: string,
        imported: string[],
        skipped: { label: string; reason: string }[]
    ): void {
        if (imported.length === 0) {
            const first = skipped[0];

            vscode.window.showWarningMessage(
                `Router Models: nothing was imported from ${fileName} — ` +
                    `${skipped.length} connection(s) skipped` +
                    (first
                        ? ` (first: ${first.label} — ${first.reason})`
                        : '') +
                    '.'
            );

            return;
        }

        const shown = imported.slice(0, 5).join(', ');
        const more =
            imported.length > 5
                ? ` … +${imported.length - 5} more`
                : '';

        vscode.window.showInformationMessage(
            `Router Models: imported ${imported.length} provider(s) ` +
                `from ${fileName} (${shown}${more})` +
                (skipped.length > 0
                    ? `, ${skipped.length} skipped`
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

        try {
            await this.addManualModel(
                provider.id,
                modelId,
                name || undefined
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

            infos.push({
                id: key,
                name: value.model.name || value.model.id,
                family: value.provider.name,
                version: '1.0',
                maxInputTokens: this.maxInputTokens(value.model),
                maxOutputTokens: this.maxOutputTokens(value.model),
                tooltip: `${value.provider.name} • ${value.model.id}`,
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
            Math.min(10, config.get<number>('maxRetries', 3))
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

                // A failure after output was already streamed cannot be
                // retried (it would duplicate the delivered content).
                if (error instanceof MidStreamFailureError) {
                    throw error.cause instanceof Error
                        ? error.cause
                        : error;
                }

                // Key-independent failures (bad request, unknown model,
                // invalid auth of the request itself) fail fast instead
                // of burning through the other keys.
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
                    throw error;
                }

                lastError = error;
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(
                  'The chat request failed: ' + String(lastError)
              );
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
    ): Promise<{ producedOutput: boolean }> {
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

        const report = (part: vscode.LanguageModelResponsePart) => {
            producedOutput = true;
            progress.report(part);
        };

        const reportCompletedCall = (call: CompletedToolCall) => {
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
                throw new MidStreamFailureError(error);
            }

            throw error;
        }

        // Surface any tool call that was still pending when the stream
        // ended (arguments may have arrived fragmented).
        for (const call of tools.finish()) {
            reportCompletedCall(call);
        }

        return { producedOutput };
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

