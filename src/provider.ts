import * as vscode from 'vscode';

type ProviderConfig = {
    name: string;
    baseUrl: string;
};

type OpenAIModel = {
    id: string;
    name?: string;
    context_length?: number;
    max_input_tokens?: number;
    max_output_tokens?: number;
};

type ResolvedModel = {
    provider: ProviderConfig;
    model: OpenAIModel;
};

export class RouterProvider
    implements vscode.LanguageModelChatProvider {

    private static readonly PROVIDERS_KEY =
        'router-models.providers';
    private static readonly CACHE_KEY =
        'router-models.models-cache';

    private providers: ProviderConfig[] = [];
    private models: Map<string, ResolvedModel> = new Map();

    private readonly onDidChangeEmitter =
        new vscode.EventEmitter<void>();

    readonly onDidChangeLanguageModelChatInformation =
        this.onDidChangeEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext
    ) {
        this.loadProviders();
        this.loadModelCache();
    }

    private get secrets(): vscode.SecretStorage {
        return this.context.secrets;
    }

    private secretKey(providerName: string): string {
        return `router-models.apiKey.${providerName}`;
    }

    private loadProviders() {
        const saved = this.context.globalState.get<
            ProviderConfig[]
        >(RouterProvider.PROVIDERS_KEY, []);

        this.providers = saved;
    }

    private loadModelCache() {
        const saved = this.context.globalState.get<
            Record<string, ResolvedModel>
        >(RouterProvider.CACHE_KEY, {});

        this.models = new Map(Object.entries(saved));
    }

    private async persistModelCache() {
        await this.context.globalState.update(
            RouterProvider.CACHE_KEY,
            Object.fromEntries(this.models)
        );
    }

    private async saveProviders() {
        await this.context.globalState.update(
            RouterProvider.PROVIDERS_KEY,
            this.providers
        );
    }

    async addProvider(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Provider name',
            placeHolder: 'OpenAI',
            ignoreFocusOut: true
        });

        if (!name) {
            return;
        }

        if (
            this.providers.some(
                p => p.name.toLowerCase() ===
                    name.trim().toLowerCase()
            )
        ) {
            vscode.window.showErrorMessage(
                `Provider "${name}" already exists.`
            );
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
            prompt: 'API key',
            password: true,
            ignoreFocusOut: true
        });

        if (!apiKey) {
            return;
        }

        const provider: ProviderConfig = {
            name: name.trim(),
            baseUrl: baseUrl.trim().replace(/\/+$/, '')
        };

        this.providers.push(provider);
        await this.saveProviders();
        await this.secrets.store(
            this.secretKey(provider.name),
            apiKey
        );

        try {
            await this.fetchModels(provider);
            vscode.window.showInformationMessage(
                `${provider.name} added successfully.`
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to load models from ${provider.name}: ` +
                (error instanceof Error
                    ? error.message
                    : String(error))
            );
        }
    }

    async removeProvider(): Promise<void> {
        if (this.providers.length === 0) {
            vscode.window.showInformationMessage(
                'No providers configured.'
            );
            return;
        }

        const picked = await vscode.window.showQuickPick(
            this.providers.map(p => ({
                label: p.name,
                description: p.baseUrl,
                provider: p
            })),
            {
                placeHolder: 'Select a provider to remove',
                ignoreFocusOut: true
            }
        );

        if (!picked) {
            return;
        }

        const confirm =
            await vscode.window.showWarningMessage(
                `Remove provider "${picked.provider.name}"?`,
                { modal: true },
                'Remove'
            );

        if (confirm !== 'Remove') {
            return;
        }

        this.providers = this.providers.filter(
            p => p.name !== picked.provider.name
        );
        await this.saveProviders();
        await this.secrets.delete(
            this.secretKey(picked.provider.name)
        );

        for (const key of [...this.models.keys()]) {
            if (
                this.models.get(key)!.provider.name ===
                picked.provider.name
            ) {
                this.models.delete(key);
            }
        }

        await this.persistModelCache();
        this.onDidChangeEmitter.fire();

        vscode.window.showInformationMessage(
            `${picked.provider.name} removed.`
        );
    }

    private async getApiKey(
        provider: ProviderConfig
    ): Promise<string> {
        const apiKey = await this.secrets.get(
            this.secretKey(provider.name)
        );

        if (!apiKey) {
            throw new Error(
                `API key for "${provider.name}" is missing. ` +
                'Re-add the provider.'
            );
        }

        return apiKey;
    }

    private async fetch(
        provider: ProviderConfig,
        path: string,
        init: RequestInit = {}
    ): Promise<Response> {
        const apiKey = await this.getApiKey(provider);
        const timeoutMs = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('requestTimeoutMs', 30000);

        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            timeoutMs
        );

        try {
            return await fetch(
                `${provider.baseUrl}${path}`,
                {
                    ...init,
                    signal: init.signal ?? controller.signal,
                    headers: {
                        'Authorization':
                            `Bearer ${apiKey}`,
                        'Content-Type':
                            'application/json',
                        ...(init.headers ?? {})
                    }
                }
            );
        } finally {
            clearTimeout(timer);
        }
    }

    private async fetchModels(
        provider: ProviderConfig
    ): Promise<void> {
        const response = await this.fetch(
            provider,
            '/models'
        );

        if (!response.ok) {
            throw new Error(
                `${provider.name}: HTTP ${response.status}`
            );
        }

        const json = await response.json() as {
            data?: OpenAIModel[];
        };

        for (const model of json.data ?? []) {
            const key =
                `${provider.name}:${model.id}`;

            this.models.set(key, { provider, model });
        }

        await this.persistModelCache();
        this.onDidChangeEmitter.fire();
    }

    refresh(): void {
        this.models.clear();
        this.persistModelCache().then(() =>
            this.onDidChangeEmitter.fire()
        );

        for (const provider of this.providers) {
            this.fetchModels(provider).catch(error => {
                vscode.window.showErrorMessage(
                    `Failed to load ${provider.name}: ` +
                    (error instanceof Error
                        ? error.message
                        : String(error))
                );
            });
        }
    }

    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (
            this.providers.length === 0 &&
            !options.silent
        ) {
            await this.addProvider();
        }

        if (this.models.size === 0) {
            this.refresh();
        }

        return Array.from(this.models.entries()).map(
            ([key, value]) => {
                const model = value.model;

                return {
                    id: key,
                    name: model.name || model.id,
                    family: value.provider.name,
                    version: '1.0',
                    maxInputTokens:
                        model.max_input_tokens ??
                        model.context_length ??
                        128000,
                    maxOutputTokens:
                        model.max_output_tokens ?? 16000,
                    tooltip:
                        `${value.provider.name} • ${model.id}`,
                    detail: value.provider.baseUrl,
                    capabilities: {
                        imageInput: false,
                        toolCalling: true
                    }
                };
            }
        );
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        _options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelTextPart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const selected = this.models.get(model.id);

        if (!selected) {
            throw new Error(
                `Model not found: ${model.id}`
            );
        }

        const openAiMessages = messages.map(
            (
                message: vscode.LanguageModelChatRequestMessage
            ) => {
                const role =
                    message.role ===
                        vscode.LanguageModelChatMessageRole.User
                        ? 'user'
                        : 'assistant';

                const content = message.content
                    .map((part: any) => {
                        if (
                            part instanceof
                            vscode.LanguageModelTextPart
                        ) {
                            return part.value;
                        }

                        return '';
                    })
                    .join('');

                return {
                    role,
                    content
                };
            }
        );

        const temperature = vscode.workspace
            .getConfiguration('routerModels')
            .get<number>('defaultTemperature', 0.2);

        const controller = new AbortController();

        token.onCancellationRequested(() => {
            controller.abort();
        });

        const response = await this.fetch(
            selected.provider,
            '/chat/completions',
            {
                method: 'POST',
                signal: controller.signal,
                body: JSON.stringify({
                    model: selected.model.id,
                    messages: openAiMessages,
                    stream: true,
                    temperature
                })
            }
        );

        if (!response.ok || !response.body) {
            const errorText = await response.text();

            throw new Error(
                `${response.status}: ${errorText}`
            );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = '';

        while (true) {
            const result = await reader.read();

            if (result.done) {
                break;
            }

            buffer += decoder.decode(result.value, {
                stream: true
            });

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();

                if (!trimmed.startsWith('data:')) {
                    continue;
                }

                const payload = trimmed
                    .slice('data:'.length)
                    .trim();

                if (payload === '[DONE]') {
                    return;
                }

                try {
                    const chunk = JSON.parse(payload);

                    const text =
                        chunk.choices?.[0]?.delta?.content;

                    if (text) {
                        progress.report(
                            new vscode.LanguageModelTextPart(
                                text
                            )
                        );
                    }
                } catch {
                    // Ignore invalid SSE chunks
                }
            }
        }
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