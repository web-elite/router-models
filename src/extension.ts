import * as vscode from 'vscode';
import { RouterProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new RouterProvider(context);

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(
            'router-models',
            provider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'router-models.manage',
            () => provider.addProvider()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'router-models.remove',
            () => provider.removeProvider()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'router-models.refresh',
            () => {
                provider.refresh();
                vscode.window.showInformationMessage(
                    'Router models refreshed.'
                );
            }
        )
    );
}

export function deactivate() {
    // Nothing to clean up.
}