import * as vscode from 'vscode';
import { RouterProvider } from './provider';

type SidebarMessage = { type: string; [key: string]: unknown };

export class RouterSidebar
    implements vscode.WebviewViewProvider {

    public static readonly viewType = 'router-models.sidebar';

    private view?: vscode.WebviewView;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly provider: RouterProvider
    ) {
        this.disposables.push(
            provider.onDidChangeState(() => {
                void this.pushState();
            })
        );
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;

        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri]
        };

        view.webview.html = this.getHtml(view.webview);

        view.webview.onDidReceiveMessage(
            message => void this.onMessage(message as SidebarMessage),
            null,
            this.disposables
        );

        view.onDidChangeVisibility(
            () => {
                if (view.visible) {
                    // Pick up anything that arrived through VS Code
                    // Settings Sync since the last check, then show
                    // the (possibly changed) state.
                    void this.reloadAndPush();
                }
            },
            null,
            this.disposables
        );

        void this.pushState();
    }

    dispose(): void {
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    // ---------------------------------------------------------------
    // State sync
    // ---------------------------------------------------------------

    private async pushState(): Promise<void> {
        const view = this.view;

        if (!view) {
            return;
        }

        const snapshot = await this.provider.getSnapshot();

        await view.webview.postMessage({
            type: 'state',
            snapshot
        });
    }

    /** Reloads persisted / synced state, then pushes it to the view. */
    private async reloadAndPush(): Promise<void> {
        await this.provider.reloadFromSync();
        await this.pushState();
    }

    /**
     * Shows a transient feedback toast in the webview so the user can
     * see that an action (refresh / edit / …) actually happened.
     */
    private async postFeedback(
        kind: 'success' | 'error' | 'info',
        title: string,
        detail?: string
    ): Promise<void> {
        await this.view?.webview.postMessage({
            type: 'feedback',
            kind,
            title,
            detail
        });
    }

    /**
     * Resolves a provider's display name for feedback messages.
     */
    private async providerName(id: string): Promise<string> {
        const snapshot = await this.provider.getSnapshot();

        for (const provider of snapshot.providers) {
            if (provider.id === id) {
                return provider.name;
            }
        }

        return '';
    }

    // ---------------------------------------------------------------
    // Messages from the webview
    // ---------------------------------------------------------------

    private str(value: unknown): string | undefined {
        if (typeof value !== 'string') {
            return undefined;
        }

        const trimmed = value.trim();

        return trimmed ? trimmed : undefined;
    }

    /**
     * Normalizes the cooldown input from the webview:
     * `undefined` keeps the current value, an empty value clears the
     * override (null), a number sets the cooldown in seconds.
     */
    private cooldownInput(
        value: unknown
    ): number | null | undefined {
        if (value === undefined) {
            return undefined;
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        if (typeof value === 'string' && value.trim()) {
            const parsed = Number(value.trim());

            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        return null;
    }

    private async onMessage(
        message: SidebarMessage
    ): Promise<void> {
        try {
            switch (message.type) {
                case 'ready':
                case 'refresh':
                    await this.pushState();
                    break;

                case 'refreshAll':
                    await this.provider.refreshAll();
                    await this.pushState();
                    await this.postFeedback(
                        'success',
                        'Refreshed all providers',
                        'Model lists are up to date.'
                    );
                    break;

                case 'refreshFreeModels':
                    await this.provider.refreshFreeModelsFlow();
                    await this.pushState();
                    break;

                case 'refreshProvider': {
                    const providerId = String(message.providerId);
                    const name = await this.providerName(providerId);

                    try {
                        const count =
                            await this.provider.refreshProvider(providerId);
                        await this.pushState();
                        await this.postFeedback(
                            'success',
                            'Refreshed',
                            `${name || 'provider'} — ${count} model(s) found.`
                        );
                    } catch (error) {
                        await this.pushState();
                        await this.postFeedback(
                            'error',
                            'Refresh failed',
                            `${name || 'provider'}: ` +
                                (error instanceof Error
                                    ? error.message
                                    : String(error))
                        );
                    }
                    break;
                }

                case 'addProvider': {
                    const name = String(message.name ?? '');

                    try {
                        await this.provider.addProvider({
                            name,
                            id: this.str(message.id),
                            baseUrl: String(message.baseUrl ?? ''),
                            apiKey: this.str(message.apiKey),
                            iconUrl: this.str(message.iconUrl),
                            cooldownSeconds: this.cooldownInput(
                                message.cooldownSeconds
                            )
                        });
                        await this.pushState();
                        await this.postFeedback(
                            'success',
                            'Provider added',
                            `${name} is now in the model picker.`
                        );
                    } catch (error) {
                        await this.pushState();
                        await this.postFeedback(
                            'error',
                            'Could not add provider',
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );
                    }
                    break;
                }

                case 'updateProvider': {
                    const patch = (message.patch ?? {}) as {
                        name?: unknown;
                        baseUrl?: unknown;
                        apiKey?: unknown;
                        iconUrl?: unknown;
                        cooldownSeconds?: unknown;
                    };

                    const providerId = String(message.providerId);
                    const providerName =
                        this.str(patch.name) ??
                        (await this.providerName(providerId));

                    try {
                        await this.provider.updateProvider(providerId, {
                            name: this.str(patch.name),
                            baseUrl: this.str(patch.baseUrl),
                            apiKey: patch.apiKey !== undefined
                                ? this.str(patch.apiKey) ?? null
                                : undefined,
                            iconUrl: patch.iconUrl !== undefined
                                ? this.str(patch.iconUrl) ?? null
                                : undefined,
                            cooldownSeconds:
                                patch.cooldownSeconds !== undefined
                                    ? this.cooldownInput(
                                          patch.cooldownSeconds
                                      )
                                    : undefined
                        });
                        await this.pushState();
                        await this.postFeedback(
                            'success',
                            'Provider updated',
                            `${providerName || 'Provider'} saved.`
                        );
                    } catch (error) {
                        await this.pushState();
                        await this.postFeedback(
                            'error',
                            'Update failed',
                            `${providerName || 'Provider'}: ` +
                                (error instanceof Error
                                    ? error.message
                                    : String(error))
                        );
                    }
                    break;
                }

                case 'addKeys':
                    await this.provider.addKeys(
                        String(message.providerId),
                        String(message.keys ?? '')
                    );
                    await this.pushState();
                    break;

                case 'removeKey':
                    await this.provider.removeKeyAt(
                        String(message.providerId),
                        Number(message.index)
                    );
                    await this.pushState();
                    break;

                case 'removeProvider':
                    await this.provider.removeProvider(
                        String(message.providerId)
                    );
                    await this.pushState();
                    break;

                case 'importJson':
                    await this.provider.importFromJsonFile();
                    await this.pushState();
                    break;

                case 'exportJson':
                    await this.provider.exportToJsonFile();
                    break;

                case 'resetCooldowns':
                    this.provider.resetCooldowns(
                        this.str(message.providerId)
                    );
                    await this.pushState();
                    break;

                case 'addModel':
                    await this.provider.addManualModel(
                        String(message.providerId),
                        String(message.modelId ?? ''),
                        this.str(message.modelName),
                        message.free === true
                    );
                    await this.pushState();
                    break;

                case 'toggleModelFree':
                    await this.provider.setModelFree(
                        String(message.providerId),
                        String(message.modelId ?? ''),
                        message.free === true
                    );
                    await this.pushState();
                    break;

                case 'removeModel':
                    await this.provider.removeManualModel(
                        String(message.providerId),
                        String(message.modelId ?? '')
                    );
                    await this.pushState();
                    break;

                case 'toggleDisabled':
                    await this.provider.toggleDisabled(
                        String(message.providerId)
                    );
                    await this.pushState();
                    break;

                case 'togglePinned':
                    await this.provider.togglePinned(
                        String(message.providerId)
                    );
                    await this.pushState();
                    break;

                case 'openSettings':
                    await vscode.commands.executeCommand(
                        'workbench.action.openSettings',
                        'routerModels.'
                    );
                    break;

                case 'enableFreeModels':
                    await this.provider.setFreeModelsEnabled(true);
                    await this.pushState();
                    break;

                case 'hideOffersBanner':
                    await this.provider.setOffersBannerHidden(true);
                    await this.pushState();
                    break;

                case 'showOffersBanner':
                    await this.provider.setOffersBannerHidden(false);
                    await this.pushState();
                    break;

                case 'openOffersSite':
                    await vscode.env.openExternal(
                        vscode.Uri.parse(RouterProvider.OFFERS_URL)
                    );
                    break;

                default:
                    break;
            }
        } catch (error) {
            await this.view?.webview.postMessage({
                type: 'error',
                message:
                    error instanceof Error
                        ? error.message
                        : String(error)
            });
        }
    }

    // ---------------------------------------------------------------
    // HTML shell (markup + styles + script live in /media)
    // ---------------------------------------------------------------

    private getHtml(webview: vscode.Webview): string {
        const media = (name: string): string =>
            webview.asWebviewUri(
                vscode.Uri.joinPath(
                    this.context.extensionUri,
                    'media',
                    name
                )
            ).toString();

        const nonce = Math.random()
            .toString(36)
            .slice(2);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${webview.cspSource};
                   img-src ${webview.cspSource} https: data:;
                   script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${media('sidebar.css')}">
</head>
<body>
    <header class="header">
        <img class="logo" src="${media('logo.svg')}" alt="">
        <span class="title">Router Models</span>
        <button id="btn-add" class="icon-btn" title="Add provider">+</button>
        <button id="btn-import" class="icon-btn" title="Import providers from JSON">&#10515;</button>
        <button id="btn-export" class="icon-btn" title="Export providers to JSON">&#10514;</button>
        <button id="btn-refresh" class="icon-btn" title="Refresh all providers">&#8635;</button>
        <button id="btn-free" class="icon-btn" title="Detect free models">&#127379;</button>
        <button id="btn-settings" class="icon-btn" title="Include / exclude settings">&#9881;</button>
    </header>

    <div id="error" class="error hidden"></div>
    <main id="root"></main>
    <div id="free-status" class="free-status hidden"></div>
    <div id="toast-wrap" class="toast-wrap"></div>

    <script nonce="${nonce}" src="${media('sidebar.js')}"></script>
</body>
</html>`;
    }
}

