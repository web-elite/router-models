(function () {
    'use strict';

    var vscode = acquireVsCodeApi();

    var snapshot = { providers: [] };
    var expandedId = null;

    var root = document.getElementById('root');
    var errorBox = document.getElementById('error');

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function post(message) {
        vscode.postMessage(message);
    }

    function showError(message) {
        errorBox.textContent = message;
        errorBox.classList.remove('hidden');

        setTimeout(function () {
            errorBox.classList.add('hidden');
        }, 8000);
    }

    function findProvider(id) {
        for (var i = 0; i < snapshot.providers.length; i++) {
            if (snapshot.providers[i].id === id) {
                return snapshot.providers[i];
            }
        }

        return null;
    }

    // ---------------------------------------------------------------
    // Modal
    // ---------------------------------------------------------------

    var modalState = null;

    function closeModal() {
        var existing = document.getElementById('rm-modal');

        if (existing) {
            existing.remove();
        }

        modalState = null;
    }

    function openModal(options) {
        closeModal();

        modalState = options;

        var overlay = document.createElement('div');
        overlay.id = 'rm-modal';
        overlay.className = 'modal-overlay';

        var form = document.createElement('form');
        form.className = 'modal';

        var heading = document.createElement('h2');
        heading.textContent = options.title;
        form.appendChild(heading);

        var inputs = {};

        for (var i = 0; i < options.fields.length; i++) {
            var field = options.fields[i];

            var group = document.createElement('label');
            group.className = 'field';

            var label = document.createElement('span');
            label.className = 'field-label';
            label.textContent = field.label;

            var input;

            if (field.multiline) {
                input = document.createElement('textarea');
                input.rows = field.rows || 4;
            } else {
                input = document.createElement('input');
                input.type = field.password ? 'password' : 'text';
            }

            input.value = field.value || '';
            input.placeholder = field.placeholder || '';
            input.autocomplete = 'off';
            input.required = Boolean(field.required);

            group.appendChild(label);
            group.appendChild(input);
            form.appendChild(group);

            inputs[field.key] = input;
        }

        if (options.text) {
            var text = document.createElement('p');
            text.className = 'confirm-text';
            text.textContent = options.text;
            form.insertBefore(text, form.querySelector('.field'));
        }

        var actions = document.createElement('div');
        actions.className = 'modal-actions';

        var save = document.createElement('button');
        save.type = 'submit';
        save.className = 'btn';
        save.textContent = options.submitLabel || 'Save';

        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'btn secondary';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', closeModal);

        actions.appendChild(save);
        actions.appendChild(cancel);
        form.appendChild(actions);

        form.addEventListener('submit', function (event) {
            event.preventDefault();

            var values = {};

            for (var key in inputs) {
                values[key] = inputs[key].value.trim();
            }

            var onSubmit = modalState && modalState.onSubmit;
            closeModal();

            if (onSubmit) {
                onSubmit(values);
            }
        });

        overlay.appendChild(form);

        overlay.addEventListener('mousedown', function (event) {
            if (event.target === overlay) {
                closeModal();
            }
        });

        document.body.appendChild(overlay);

        var first = form.querySelector('input');

        if (first) {
            first.focus();
        }
    }

    // ---------------------------------------------------------------
    // Forms
    // ---------------------------------------------------------------

    function openAddProviderForm() {
        openModal({
            title: 'Add OpenAI-Compatible Provider',
            submitLabel: 'Add',
            fields: [
                {
                    key: 'name',
                    label: 'Name',
                    required: true,
                    placeholder: 'OpenRouter'
                },
                {
                    key: 'id',
                    label: 'Id (optional)',
                    placeholder: 'openrouter'
                },
                {
                    key: 'baseUrl',
                    label: 'Base URL',
                    required: true,
                    placeholder: 'https://openrouter.ai/api/v1'
                },
                {
                    key: 'apiKey',
                    label: 'API keys (optional, one per line or comma separated)',
                    multiline: true,
                    rows: 4,
                    placeholder: 'sk-…'
                },
                {
                    key: 'cooldownSeconds',
                    label: 'Cooldown seconds after 429 (optional)',
                    placeholder: '60'
                },
                {
                    key: 'iconUrl',
                    label: 'Icon URL (optional; favicon auto-detected when empty)',
                    placeholder: 'https://…/logo.png'
                }
            ],
            onSubmit: function (values) {
                post({
                    type: 'addProvider',
                    name: values.name,
                    id: values.id,
                    baseUrl: values.baseUrl,
                    apiKey: values.apiKey,
                    cooldownSeconds: values.cooldownSeconds,
                    iconUrl: values.iconUrl
                });
            }
        });
    }

    function openEditProviderForm(provider) {
        openModal({
            title: 'Edit Provider: ' + provider.name,
            submitLabel: 'Save',
            fields: [
                {
                    key: 'name',
                    label: 'Name',
                    required: true,
                    value: provider.name
                },
                {
                    key: 'baseUrl',
                    label: 'Base URL',
                    required: true,
                    value: provider.baseUrl
                },
                {
                    key: 'apiKey',
                    label: 'API key' + (
                        provider.hasKey
                            ? ' (saved — type to replace)'
                            : ' (none)'
                    ),
                    multiline: true,
                    rows: 4
                },
                {
                    key: 'cooldownSeconds',
                    label: 'Cooldown seconds after 429 (empty = default)',
                    value: String(
                        provider.cooldownSeconds != null
                            ? provider.cooldownSeconds
                            : ''
                    ),
                    placeholder: '60'
                },
                {
                    key: 'iconUrl',
                    label: 'Icon image URL' + (
                        provider.iconUrl
                            ? ' (saved — type to replace)'
                            : ' (none)'
                    ),
                    value: provider.iconUrl
                }
            ],
            onSubmit: function (values) {
                var patch = {};

                if (values.name && values.name !== provider.name) {
                    patch.name = values.name;
                }

                if (values.baseUrl && values.baseUrl !== provider.baseUrl) {
                    patch.baseUrl = values.baseUrl;
                }

                if (values.apiKey) {
                    patch.apiKey = values.apiKey;
                }

                // Empty input clears the per-provider override.
                patch.cooldownSeconds =
                    values.cooldownSeconds === ''
                        ? null
                        : values.cooldownSeconds;

                if (values.iconUrl && values.iconUrl !== provider.iconUrl) {
                    patch.iconUrl = values.iconUrl;
                }

                if (Object.keys(patch).length) {
                    post({
                        type: 'updateProvider',
                        providerId: provider.id,
                        patch: patch
                    });
                }
            }
        });
    }

    function openAddModelForm(provider) {
        openModal({
            title: 'Add Model to ' + provider.name,
            submitLabel: 'Add',
            fields: [
                {
                    key: 'modelId',
                    label: 'Model id',
                    required: true,
                    placeholder: 'deepseek-chat'
                },
                {
                    key: 'modelName',
                    label: 'Display name (optional)',
                    placeholder: 'DeepSeek Chat'
                }
            ],
            onSubmit: function (values) {
                post({
                    type: 'addModel',
                    providerId: provider.id,
                    modelId: values.modelId,
                    modelName: values.modelName
                });
            }
        });
    }

    function openRemoveConfirm(provider) {
        openModal({
            title: 'Remove Provider',
            submitLabel: 'Remove',
            text: 'Remove "' + provider.name + '" and its models?',
            fields: [],
            onSubmit: function () {
                post({
                    type: 'removeProvider',
                    providerId: provider.id
                });
            }
        });
    }

    // ---------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------

    function render() {
        if (!snapshot.providers.length) {
            root.innerHTML =
                '<div class="empty">' +
                'No providers configured yet.' +
                '<p class="hint">Add an OpenAI-compatible endpoint — ' +
                'its models will appear in the Copilot model picker.</p>' +
                '<button class="btn" data-action="add-provider">' +
                '+ Add Provider</button></div>';
            return;
        }

        var html =
            '<button class="btn block" data-action="add-provider">' +
            '+ Add Provider</button>';

        for (var i = 0; i < snapshot.providers.length; i++) {
            html += renderProvider(snapshot.providers[i]);
        }

        root.innerHTML = html;
    }

    function renderProvider(provider) {
        var expanded = expandedId === provider.id;

        var html = '<div class="card">';

        html += '<div class="card-head" data-action="toggle" ' +
            'data-pid="' + esc(provider.id) + '">';

        if (provider.iconData) {
            html += '<img class="avatar" src="' +
                esc(provider.iconData) + '" alt="">';
        }

        html += '<span class="name">' + esc(provider.name) + '</span>';
        html += '<span class="badge">' +
            provider.models.length + '</span>';

        if (provider.error) {
            html += '<span class="badge err" title="' +
                esc(provider.error) + '">!</span>';
        }

        if (provider.keys && provider.keys.total > 0) {
            var parts = [];

            if (provider.keys.ready > 0) {
                parts.push('✓' + provider.keys.ready);
            }

            if (provider.keys.cooldown > 0) {
                parts.push('429:' + provider.keys.cooldown);
            }

            if (provider.keys.burned > 0) {
                parts.push('×' + provider.keys.burned);
            }

            html += '<span class="tag keys" title="API keys">' +
                esc(provider.keys.total + ' keys ' +
                    parts.join(' ')) + '</span>';
        } else {
            html += '<span class="tag">no key</span>';
        }

        html += '</div>';

        if (provider.error) {
            html += '<div class="card-error">' +
                esc(provider.error) + '</div>';
        }

        if (expanded) {
            html += '<div class="models">';

            if (!provider.models.length) {
                html += '<div class="model">' +
                    '<span class="mid">No models discovered yet.</span></div>';
            }

            for (var i = 0; i < provider.models.length; i++) {
                html += renderModel(provider, provider.models[i]);
            }

            html += '</div>';
        }

        html += '<div class="card-tools">';
        html += '<button class="btn secondary" data-action="edit" ' +
            'data-pid="' + esc(provider.id) + '">Edit</button>';
        html += '<button class="btn secondary" data-action="refresh" ' +
            'data-pid="' + esc(provider.id) + '">Refresh</button>';

        if (provider.keys && provider.keys.cooldown > 0) {
            html += '<button class="btn secondary" ' +
                'data-action="reset-cooldowns" ' +
                'data-pid="' + esc(provider.id) +
                '">Reset 429</button>';
        }
        html += '<button class="btn secondary" data-action="add-model" ' +
            'data-pid="' + esc(provider.id) + '">+ Model</button>';
        html += '<button class="btn secondary" data-action="delete" ' +
            'data-pid="' + esc(provider.id) + '">Delete</button>';
        html += '</div></div>';

        return html;
    }

    function renderModel(provider, model) {
        var html = '<div class="model' +
            (model.hidden ? ' hidden-model' : '') + '">';

        html += '<span class="mid" title="' + esc(model.id) + '">' +
            esc(model.name || model.id) + '</span>';

        if (model.manual) {
            html += '<span class="tag">manual</span>';
            html += '<button class="del" data-action="del-model" ' +
                'data-pid="' + esc(provider.id) + '" ' +
                'data-mid="' + esc(model.id) + '" ' +
                'title="Remove manual model">&#10005;</button>';
        }

        if (model.hidden) {
            html += '<span class="tag" title="Hidden by include / ' +
                'exclude patterns">hidden</span>';
        }

        html += '</div>';

        return html;
    }

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    root.addEventListener('click', function (event) {
        var target = event.target;

        var button = target.closest('[data-action]');

        if (!button) {
            return;
        }

        var action = button.getAttribute('data-action');

        if (action === 'add-provider') {
            openAddProviderForm();
            return;
        }

        var pid = button.getAttribute('data-pid');

        if (!pid) {
            return;
        }

        var provider = findProvider(pid);

        if (action === 'toggle') {
            expandedId = expandedId === pid ? null : pid;
            render();
            return;
        }

        if (!provider) {
            return;
        }

        if (action === 'edit') {
            openEditProviderForm(provider);
        } else if (action === 'refresh') {
            post({
                type: 'refreshProvider',
                providerId: provider.id
            });
        } else if (action === 'delete') {
            openRemoveConfirm(provider);
        } else if (action === 'add-model') {
            openAddModelForm(provider);
        } else if (action === 'reset-cooldowns') {
            post({
                type: 'resetCooldowns',
                providerId: provider.id
            });
        } else if (action === 'del-model') {
            post({
                type: 'removeModel',
                providerId: provider.id,
                modelId: button.getAttribute('data-mid')
            });
        }
    });

    document.getElementById('btn-add')
        .addEventListener('click', openAddProviderForm);

    document.getElementById('btn-refresh')
        .addEventListener('click', function () {
            post({ type: 'refreshAll' });
        });

    document.getElementById('btn-settings')
        .addEventListener('click', function () {
            post({ type: 'openSettings' });
        });

    // ---------------------------------------------------------------
    // Messages from the extension
    // ---------------------------------------------------------------

    window.addEventListener('message', function (event) {
        var message = event.data;

        if (message.type === 'state' && message.snapshot) {
            snapshot = message.snapshot;
            render();
        } else if (message.type === 'error') {
            showError(message.message || 'Unknown error.');
        }
    });

    post({ type: 'ready' });
})();



