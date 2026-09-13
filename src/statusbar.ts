// ------------------------------------------------------------------
// Live key monitor in the status bar + its quick menu.
// ------------------------------------------------------------------

import * as vscode from 'vscode';
import { RouterProvider } from './provider';
import type { NamedKeyDetail } from './keys';

type ProviderKeySummary = {
    providerId: string;
    providerName: string;
    cooldownSeconds: number;
    ready: number;
    cooldown: number;
    burned: number;
    keys: NamedKeyDetail[];
};

type MenuAction =
    | 'resetAll'
    | 'resetProvider'
    | 'manage'
    | 'refresh';

type MenuEntry = vscode.QuickPickItem & {
    action?: MenuAction;
    providerId?: string;
};

const SEPARATOR = ' ∣ ';

export class RouterStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setInterval> | undefined;
    private updating = false;

    constructor(private readonly provider: RouterProvider) {
        this.item = vscode.window.createStatusBarItem(
            'router-models.status',
            vscode.StatusBarAlignment.Left,
            100
        );

        this.item.name = 'Router Models';
        this.item.command = 'router-models.statusMenu';
        this.item.show();

        this.disposables.push(
            this.item,
            provider.onDidChangeState(() => void this.update()),
            vscode.commands.registerCommand(
                'router-models.statusMenu',
                () => void this.showMenu()
            )
        );

        void this.update();
    }

    dispose(): void {
        this.stopTimer();

        for (const disposable of this.disposables.splice(0)) {
            disposable.dispose();
        }
    }

    // ---------------------------------------------------------------
    // Live text
    // ---------------------------------------------------------------

    private async update(): Promise<void> {
        if (this.updating) {
            return;
        }

        this.updating = true;

        try {
            const details = await this.provider.getKeyDetails();
            const totals = this.totals(details);

            const lastUsed = this.provider.lastUsedModel;
            const usedProvider = lastUsed
                ? details.find(
                      d => d.providerId === lastUsed.providerId
                  )
                : undefined;

            const segments: string[] = [];

            if (details.length === 0) {
                segments.push('Router: no providers');
            } else {
                segments.push(`Router: ${lastUsed?.name ?? 'idle'}`);

                if (usedProvider) {
                    segments.push(
                        `Keys: ${usedProvider.ready} active`
                    );
                }

                segments.push(
                    `Total: ${totals.total} ✓${totals.ready} ` +
                        `429:${totals.cooldown} ×${totals.burned}`
                );
            }

            this.item.text = `$(hub) ${segments.join(SEPARATOR)}`;

            this.item.tooltip = [
                'Router Models — key monitor',
                lastUsed
                    ? `Last model: ${lastUsed.name}`
                    : 'No chat request yet.',
                ...details.map(
                    d =>
                        `${d.providerName}: ✓${d.ready} ` +
                        `429:${d.cooldown} ×${d.burned} ` +
                        `(cooldown ${d.cooldownSeconds}s)`
                ),
                'Click to manage keys & cooldowns.'
            ].join('\n');

            // Tick once per second only while a cooldown is running.
            if (totals.cooldown > 0) {
                this.startTimer();
            } else {
                this.stopTimer();
            }
        } catch {
            // Secret reads can fail transiently; keep the last text.
        } finally {
            this.updating = false;
        }
    }

    private totals(details: ProviderKeySummary[]): {
        total: number;
        ready: number;
        cooldown: number;
        burned: number;
    } {
        let total = 0;
        let ready = 0;
        let cooldown = 0;
        let burned = 0;

        for (const detail of details) {
            total += detail.keys.length;
            ready += detail.ready;
            cooldown += detail.cooldown;
            burned += detail.burned;
        }

        return { total, ready, cooldown, burned };
    }

    private startTimer(): void {
        if (this.timer) {
            return;
        }

        this.timer = setInterval(() => void this.update(), 1000);
    }

    private stopTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    // ---------------------------------------------------------------
    // Quick menu
    // ---------------------------------------------------------------

    private formatRemaining(ms: number): string {
        const seconds = Math.ceil(ms / 1000);

        if (seconds >= 60) {
            const minutes = Math.floor(seconds / 60);

            return `${minutes}m ${seconds % 60}s`;
        }

        return `${seconds}s`;
    }

    private async showMenu(): Promise<void> {
        const details = await this.provider.getKeyDetails();
        const entries: MenuEntry[] = [];

        entries.push({
            label: '$(sync) Reset All Cooldowns',
            action: 'resetAll'
        });

        entries.push({
            label: '$(refresh) Refresh Models',
            action: 'refresh'
        });

        entries.push({
            label: '$(gear) Manage Providers…',
            action: 'manage'
        });

        for (const detail of details) {
            entries.push({
                label: '',
                kind: vscode.QuickPickItemKind.Separator
            });

            entries.push({
                label: `$(hub) ${detail.providerName}`,
                description: `✓${detail.ready} 429:${detail.cooldown} ×${detail.burned}`,
                detail:
                    `Cooldown after 429: ${detail.cooldownSeconds}s ` +
                    '— click to reset this provider\'s cooldowns',
                action: 'resetProvider',
                providerId: detail.providerId
            });

            if (detail.keys.length === 0) {
                entries.push({
                    label: '$(unlock) No API keys',
                    detail:
                        'Add keys in the Router Models sidebar.'
                });
            }

            for (const key of detail.keys) {
                const base = key.name
                    ? `$(key) ${key.name} (${key.preview})`
                    : `$(key) ${key.preview}`;

                if (key.status === 'ready') {
                    entries.push({
                        label: `${base}  ✓ ready`,
                        detail: key.lastError
                    });
                } else if (key.status === 'cooldown') {
                    entries.push({
                        label:
                            `${base}  429 · ` +
                            `${this.formatRemaining(
                                key.cooldownRemainingMs
                            )} left`,
                        detail: key.lastError
                    });
                } else {
                    entries.push({
                        label: `${base}  × ${
                            key.lastError ??
                            'authentication error'
                        }`
                    });
                }
            }
        }

        const pick = await vscode.window.showQuickPick<MenuEntry>(
            entries,
            {
                title: 'Router Models — Keys & Cooldowns',
                placeHolder: 'Keys, cooldowns and quick actions',
                matchOnDescription: true,
                matchOnDetail: true
            }
        );

        if (!pick?.action) {
            return;
        }

        switch (pick.action) {
            case 'resetAll':
                this.provider.resetCooldowns();
                break;

            case 'resetProvider':
                this.provider.resetCooldowns(pick.providerId);
                break;

            case 'refresh':
                await vscode.commands.executeCommand(
                    'router-models.refresh'
                );
                break;

            case 'manage':
                await vscode.commands.executeCommand(
                    'router-models.manage'
                );
                break;
        }
    }
}
