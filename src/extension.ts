import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { RouterProvider } from './provider';
import { RouterSidebar } from './sidebar';
import { RouterStatusBar } from './statusbar';

/**
 * Resolves the VS Code *user* home directory — the folder that holds
 * `settings.json` and `chatLanguageModels.json`. The Agent Mode model
 * picker reads that user-level file, so this is not the extension's
 * own storage; it is the editor profile's data folder.
 *
 * The editor's own data directory (not the install location) is the
 * reliable place: on Windows `%APPDATA%\Code\User` (or the
 * `%USERPROFILE%\.vscode` family), on macOS
 * `~/Library/Application Support/Code/User`, on Linux
 * `~/.config/Code/User`. The registry file only exists there when
 * the user has a local profile; a remote session keeps its own copy.
 */
async function resolveUserHome(): Promise<string> {
    const candidates: string[] = [];

    switch (process.platform) {
        case 'win32': {
            const appData = process.env['APPDATA'];
            const home = process.env['USERPROFILE'];

            if (appData) {
                candidates.push(path.join(appData, 'Code', 'User'));
            }

            if (home) {
                candidates.push(path.join(home, '.vscode', 'User'));
            }

            break;
        }

        case 'darwin': {
            candidates.push(
                path.join(
                    os.homedir(),
                    'Library',
                    'Application Support',
                    'Code',
                    'User'
                )
            );
            break;
        }

        default: {
            const config = process.env['XDG_CONFIG_HOME'];
            const base = config ?? path.join(os.homedir(), '.config');

            candidates.push(path.join(base, 'Code', 'User'));
            break;
        }
    }

    // Pick the first candidate that actually contains a VS Code user
    // directory; fall back to the first candidate when none exists yet
    // (the file will be created on the next sync).
    for (const candidate of candidates) {
        try {
            await fs.access(path.join(candidate, 'settings.json'));
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    return candidates[0];
}

/**
 * Runs the Agent Mode registry sync when it is enabled. Called on
 * activation and after any provider / model list change; safe to call
 * repeatedly — it merges managed blocks with any user-typed entries
 * in the file and rewrites only when something changed.
 */
async function maybeSyncAgentModels(
    provider: RouterProvider
): Promise<void> {
    if (!provider.agentModelsEnabled()) {
        return;
    }

    try {
        const userHome = await resolveUserHome();

        await provider.syncAgentModels(userHome);
    } catch {
        // Sync failures never break activation; the user can force a
        // refresh with the command at any time.
    }
}

export function activate(context: vscode.ExtensionContext) {
    const provider = new RouterProvider(context);
    const sidebar = new RouterSidebar(context, provider);
    const statusBar = new RouterStatusBar(provider);

    context.subscriptions.push(
        statusBar,
        vscode.lm.registerLanguageModelChatProvider(
            'router-models',
            provider
        ),
        vscode.window.registerWebviewViewProvider(
            RouterSidebar.viewType,
            sidebar
        ),
        vscode.commands.registerCommand(
            'router-models.manage',
            async () => {
                await vscode.commands.executeCommand(
                    `${RouterSidebar.viewType}.focus`
                );
            }
        ),
        vscode.commands.registerCommand(
            'router-models.addProvider',
            () => provider.addProviderFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.importJson',
            () => provider.importFromJsonFile()
        ),
        vscode.commands.registerCommand(
            'router-models.exportJson',
            () => provider.exportToJsonFile()
        ),
        vscode.commands.registerCommand(
            'router-models.reloadFromSync',
            () => provider.reloadFromSyncFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.editProvider',
            () => provider.editProviderFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.remove',
            () => provider.removeProviderFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.addModel',
            () => provider.addModelFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.refresh',
            () => provider.refreshAll()
        ),
        vscode.commands.registerCommand(
            'router-models.refreshFreeModels',
            () => provider.refreshFreeModelsFlow()
        ),
        vscode.commands.registerCommand(
            'router-models.resetCooldowns',
            () => provider.resetCooldowns()
        ),
        vscode.commands.registerCommand(
            'router-models.syncAgentModels',
            async () => {
                await provider.syncAgentModelsFlow(
                    await resolveUserHome()
                );
            }
        )
    );

    // Keep the Agent Mode registry in step with the provider / model
    // list: on activation and whenever the provider list changes.
    void maybeSyncAgentModels(provider);
    context.subscriptions.push(
        provider.onDidChangeState(() => {
            void maybeSyncAgentModels(provider);
        })
    );
}

export function deactivate() {
    // Nothing to clean up.
}
