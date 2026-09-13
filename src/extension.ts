import * as vscode from 'vscode';
import { RouterProvider } from './provider';
import { RouterSidebar } from './sidebar';
import { RouterStatusBar } from './statusbar';

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
            'router-models.resetCooldowns',
            () => provider.resetCooldowns()
        )
    );
}

export function deactivate() {
    // Nothing to clean up.
}
