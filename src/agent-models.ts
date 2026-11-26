import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * One model entry as it appears in the user's
 * `User/chatLanguageModels.json` registry — the file VS Code's
 * Agent Mode model picker reads to learn which third-party models are
 * available.
 *
 * The shape mirrors what VS Code writes when a user adds a custom
 * endpoint through the "Manage Models" dialog: a top-level provider
 * block with a `vendor` of `customendpoint`, a chat-completions API
 * type, and a list of models. We tag each block we generate with a
 * sentinel field so a later merge can tell our managed entries apart
 * from ones the user typed by hand.
 */
export type AgentModelEntry = {
    id: string;
    name?: string;
    url: string;
    toolCalling: boolean;
    vision?: boolean;
    maxInputTokens?: number;
    maxOutputTokens?: number;
};

export type AgentProviderBlock = {
    /** Human label, shown in the agent model picker. */
    name: string;
    vendor: string;
    apiType?: string;
    models: AgentModelEntry[];
    /** Marker for blocks managed by Router Models (never user-typed). */
    __routerModels?: boolean;
};

export type AgentRegistry = AgentProviderBlock[];

/**
 * The marker we stamp on managed blocks. VS Code ignores unknown
 * fields when reading the file, so this never affects behavior — it
 * only lets us recognize and replace our own entries during a merge.
 */
export const MANAGED_MARKER = '__routerModels' as const;

/**
 * Builds the full registry content from a set of providers. Each
 * provider becomes one block; every visible model in that provider's
 * cache becomes one entry, pointing at the provider's own base URL so
 * VS Code talks directly to it (bypassing this extension's router —
 * which is exactly how the built-in custom endpoints work, and what
 * the agent picker expects).
 */
export function buildAgentRegistry(
    providers: {
        name: string;
        baseUrl: string;
        /** Models to include; `visible` is pre-filtered by the caller. */
        models: {
            id: string;
            name?: string;
            maxInputTokens?: number;
            maxOutputTokens?: number;
        }[];
    }[]
): AgentRegistry {
    const blocks: AgentRegistry = [];

    for (const provider of providers) {
        const models = provider.models
            .filter(model => model.id.trim().length > 0)
            .map<AgentModelEntry>(model => ({
                id: model.id,
                ...(model.name ? { name: model.name } : {}),
                url: provider.baseUrl,
                toolCalling: true,
                ...(model.maxInputTokens
                    ? { maxInputTokens: model.maxInputTokens }
                    : {}),
                ...(model.maxOutputTokens
                    ? { maxOutputTokens: model.maxOutputTokens }
                    : {})
            }));

        // Skip providers with no models to list.
        if (models.length === 0) {
            continue;
        }

        blocks.push({
            name: provider.name,
            vendor: 'customendpoint',
            apiType: 'chat-completions',
            models,
            [MANAGED_MARKER]: true
        });
    }

    return blocks;
}

/**
 * Merges managed blocks into a registry that may already contain
 * user-typed entries. Our blocks (identified by the marker) are
 * replaced wholesale; everything else is kept untouched, so a
 * hand-added OpenRouter entry and the like survive the merge.
 */
export function mergeManagedRegistry(
    existing: AgentRegistry | undefined,
    managed: AgentRegistry
): AgentRegistry {
    const kept = (existing ?? []).filter(
        block => block[MANAGED_MARKER] !== true
    );

    return [...kept, ...managed];
}

/** Reads the registry file, returning `[]` when it does not exist. */
export async function readAgentRegistry(
    filePath: string
): Promise<AgentRegistry> {
    let raw: string;

    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch {
        return [];
    }

    try {
        const parsed: unknown = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? (parsed as AgentRegistry) : [];
    } catch {
        // A corrupt file is treated as empty; the next write
        // regenerates it from managed entries.
        return [];
    }
}

/**
 * Writes the merged registry back to disk, keeping the file as a
 * pretty-printed JSON array so it stays diff- and hand-edit-friendly.
 */
export async function writeAgentRegistry(
    filePath: string,
    registry: AgentRegistry
): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
        filePath,
        JSON.stringify(registry, null, '\t') + '\n',
        'utf8'
    );
}

/** Resolves the absolute path of the user's `chatLanguageModels.json`. */
export function resolveRegistryPath(
    userHome: string
): string {
    return path.join(userHome, 'chatLanguageModels.json');
}
