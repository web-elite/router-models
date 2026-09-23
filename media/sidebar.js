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

    /**
     * Transient success/failure toast that floats over the list so the
     * user can see that a click actually did something.
     *
     * @param {string} kind  'success' | 'error' | 'info'
     * @param {string} title  Short human-readable heading.
     * @param {string} detail Optional second line (e.g. the provider
     *                       name, the model count, or an error text).
     */
    function showToast(kind, title, detail) {
        var wrap = document.getElementById('toast-wrap');

        if (!wrap) {
            return;
        }

        var toast = document.createElement('div');
        toast.className = 'toast ' + kind;

        var icons = { success: '&#9989;', error: '&#9888;', info: '&#9432;' };

        var icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.innerHTML = icons[kind] || icons.info;
        toast.appendChild(icon);

        var body = document.createElement('div');

        var line1 = document.createElement('div');
        line1.className = 'toast-title';
        line1.textContent = title;
        body.appendChild(line1);

        if (detail) {
            var line2 = document.createElement('div');
            line2.className = 'toast-detail';
            line2.textContent = detail;
            body.appendChild(line2);
        }

        toast.appendChild(body);
        wrap.appendChild(toast);

        // Force reflow so the transition plays from the initial state.
        void toast.offsetWidth;
        toast.classList.add('show');

        var dismiss = function () {
            toast.classList.remove('show');

            setTimeout(function () {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 200);
        };

        setTimeout(dismiss, 3500);
    }

    /**
     * Turns a raw provider error into a short, human-readable line.
     * Extracts the meaningful message from JSON error bodies and
     * strips request-id noise.
     */
    function formatError(raw) {
        if (!raw) {
            return 'Unknown error';
        }

        // Try to pull the message out of a JSON body like
        // HTTP 503: {"error":{"message":"…","code":"…"}}
        var msg = raw;

        var jsonStart = raw.indexOf('{');

        if (jsonStart !== -1) {
            try {
                var obj = JSON.parse(raw.slice(jsonStart));
                var errObj = obj && typeof obj === 'object'
                    ? (obj.error && typeof obj.error === 'object'
                        ? obj.error : obj)
                    : null;

                if (errObj && errObj.message) {
                    msg = errObj.message;
                }
            } catch (_) {
                // not JSON — keep raw
            }
        }

        // Strip trailing request-id noise like (request id: abc123)
        msg = msg.replace(/\s*\(request\s*id:[^)]*\)\s*/gi, '');

        // Keep it short
        if (msg.length > 120) {
            msg = msg.slice(0, 117) + '…';
        }

        return msg;
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

            if (field.checkbox) {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'checkbox';
                input.checked = Boolean(field.value);
            } else {
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
            }

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
                var fieldInput = inputs[key];

                values[key] = fieldInput.type === 'checkbox'
                    ? fieldInput.checked
                    : fieldInput.value.trim();
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
                    label: 'API keys (optional — one per line: name | key)',
                    multiline: true,
                    rows: 4,
                    placeholder: 'Main | sk-…\nBackup | sk-…\n… or a bare sk-…'
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
                    key: 'freeAll',
                    label: 'All models free — every model in this provider is treated as free, including ones discovered later',
                    checkbox: true,
                    value: Boolean(provider.freeAll)
                },
                {
                    key: 'disabled',
                    label: 'Disabled — provider is hidden from the model picker',
                    checkbox: true,
                    value: Boolean(provider.disabled)
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

                patch.freeAll = values.freeAll === true;
                patch.disabled = values.disabled === true;

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

    /**
     * Add-keys dialog: appends keys to the provider without ever
     * touching the stored ones. One `name | key` entry per line.
     */
    function openAddKeysForm(provider) {
        openModal({
            title: 'Add API Keys to ' + provider.name,
            submitLabel: 'Add Keys',
            fields: [
                {
                    key: 'keys',
                    label: 'One per line: name | key' + (
                        provider.keys && provider.keys.total > 0
                            ? ' — existing keys are kept'
                            : ''
                    ),
                    multiline: true,
                    rows: 6,
                    placeholder: 'Main | sk-…\nBackup | sk-…\n… or a bare sk-…'
                }
            ],
            onSubmit: function (values) {
                if (values.keys) {
                    post({
                        type: 'addKeys',
                        providerId: provider.id,
                        keys: values.keys
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
                },
                {
                    key: 'free',
                    label: 'Free model — gets a "(free)" label in the model picker',
                    checkbox: true
                }
            ],
            onSubmit: function (values) {
                post({
                    type: 'addModel',
                    providerId: provider.id,
                    modelId: values.modelId,
                    modelName: values.modelName,
                    free: values.free === true
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

    /**
     * Human-readable "how long ago" for an ISO timestamp, e.g.
     * "3h ago", "2d ago", "just now".
     */
    function timeAgo(iso) {
        if (!iso) {
            return '';
        }

        var parsed = Date.parse(iso);

        if (!isFinite(parsed)) {
            return '';
        }

        var seconds = Math.round((Date.now() - parsed) / 1000);

        if (seconds < 60) {
            return 'just now';
        }

        var minutes = Math.round(seconds / 60);

        if (minutes < 60) {
            return minutes + 'm ago';
        }

        var hours = Math.round(minutes / 60);

        if (hours < 48) {
            return hours + 'h ago';
        }

        return Math.round(hours / 24) + 'd ago';
    }

    /** Footer line describing the free-models registry state. */
    function renderFreeStatus() {
        var box = document.getElementById('free-status');

        if (!box) {
            return;
        }

        var info = snapshot.freeModels;

        if (!info) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }

        // Feature is turned off — keep the footer out of the way.
        if (!info.enabled) {
            box.classList.remove('hidden');
            box.innerHTML =
                '<span class="fs-text">Free-models detection is off.</span> ' +
                '<button class="fs-link" data-action="enable-free" ' +
                'title="Turn on automatic free-models detection">' +
                'Enable</button>';
            return;
        }

        var when = timeAgo(info.fetchedAt) || timeAgo(info.updatedAt);

        var text = '&#127873; ' + info.models + ' free model' +
            (info.models === 1 ? '' : 's') +
            ' \u2022 ' + info.providers + ' provider' +
            (info.providers === 1 ? '' : 's');

        if (when) {
            text += ' \u2022 updated ' + when;
        }

        text += ' \u2022 auto ' + info.intervalHours + 'h';

        box.classList.remove('hidden');
        box.innerHTML =
            '<span class="fs-text">' + text + '</span> ' +
            '<button class="fs-link" data-action="refresh-free" ' +
            'title="Download the latest free-models list">Update</button>';
    }

    /**
     * Banner at the end of the provider list pointing at the site
     * that curates free AI providers. The user can hide it; a small
     * link stays available to bring it back.
     */
    function renderOffersBanner() {
        if (snapshot.offersBannerHidden) {
            return '<div class="offers-restore">' +
                '<button class="offers-restore-btn" ' +
                'data-action="offers-show" ' +
                'title="Show the free-providers banner again">' +
                '&#127873; Free providers</button>' +
                '</div>';
        }

        return '<div class="offers-banner">' +
            '<span class="offers-emoji">&#127873;</span>' +
            '<span class="offers-text">Looking for free AI providers? ' +
            'Browse the curated list of free endpoints and models.' +
            '</span>' +
            '<button class="offers-link" data-action="offers-visit" ' +
            'title="Open offers.webelitee.ir">offers.webelitee.ir</button>' +
            '<button class="offers-close" data-action="offers-hide" ' +
            'title="Hide this banner">&#10005;</button>' +
            '</div>';
    }

    function render() {
        renderFreeStatus();

        // Capture scroll before the DOM rebuild so the list stays in
        // place when the user rapidly toggles model "free" buttons.
        var savedScroll = window.scrollY;

        if (!snapshot.providers.length) {
            root.innerHTML =
                '<div class="empty">' +
                'No providers configured yet.' +
                '<p class="hint">Add an OpenAI-compatible endpoint — ' +
                'its models will appear in the Copilot model picker.</p>' +
                '<button class="btn" data-action="add-provider">' +
                '+ Add Provider</button> ' +
                '<button class="btn secondary" data-action="import-json">' +
                '&#10515; Import JSON</button></div>' +
                renderOffersBanner();
            window.scrollTo(0, savedScroll);
            return;
        }

        var html =
            '<button class="btn block" data-action="add-provider">' +
            '+ Add Provider</button>';

        for (var i = 0; i < snapshot.providers.length; i++) {
            html += renderProvider(snapshot.providers[i]);
        }

        html += renderOffersBanner();

        root.innerHTML = html;
        window.scrollTo(0, savedScroll);
    }

    function renderProvider(provider) {
        var expanded = expandedId === provider.id;
        var disabled = provider.disabled;
        var pinned = Boolean(provider.pinned);

        var html = '<div class="card' +
            (disabled ? ' disabled' : '') +
            (pinned ? ' pinned' : '') + '">';

        html += '<div class="card-head" data-action="toggle" ' +
            'data-pid="' + esc(provider.id) + '">';

        if (provider.iconData) {
            html += '<img class="avatar" src="' +
                esc(provider.iconData) + '" alt="">';
        }

        html += '<span class="name">' + esc(provider.name) + '</span>';

        if (pinned) {
            html += '<span class="tag pinned-tag">pinned</span>';
        }

        if (disabled) {
            html += '<span class="tag disabled-tag">off</span>';
        }

        // Pin / unpin button
        html += '<button class="pin-btn' + (pinned ? ' on' : '') +
            '" data-action="pin" data-pid="' + esc(provider.id) + '" ' +
            'title="' + (pinned ? 'Unpin provider' : 'Pin to top') +
            '" tabindex="0" aria-pressed="' + (pinned ? 'true' : 'false') +
            '">' + (pinned ? '📌' : 'Pin') + '</button>';

        // Free-all indicator — toggle via Edit popup
        if (Boolean(provider.freeAll)) {
            html += '<span class="tag freeall-tag" '
                + 'title="All models in this provider are treated as free. Toggle in Edit."'
                + '>&#10003; free-all</span>';
        }

        html += '<span class="badge">' +
            provider.models.length + 'Models</span>';

        if (provider.error && !disabled) {
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

        if (provider.error && !disabled) {
            var friendlyError = formatError(provider.error);
            html += '<div class="card-error" title="' +
                esc(provider.error) + '">' +
                '<span class="card-error-icon">⚠</span>' +
                '<span class="card-error-text">' +
                esc(friendlyError) + '</span></div>';
        }

        if (expanded) {
            if (provider.keyList && provider.keyList.length) {
                html += '<div class="keys-list">';

                for (var k = 0; k < provider.keyList.length; k++) {
                    html += renderKey(
                        provider,
                        provider.keyList[k],
                        k
                    );
                }

                html += '</div>';
            }

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
        // Primary group
        html += '<button class="tool-btn" data-action="edit" ' +
            'data-pid="' + esc(provider.id) + '" title="Edit name, base URL, icon">Edit</button>';
        html += '<button class="tool-btn" data-action="add-keys" ' +
            'data-pid="' + esc(provider.id) + '" title="Add API keys">+ Keys</button>';
        html += '<button class="tool-btn" data-action="add-model" ' +
            'data-pid="' + esc(provider.id) + '" title="Add a manual model">+ Model</button>';
        html += '<button class="tool-btn" data-action="refresh" ' +
            'data-pid="' + esc(provider.id) + '" title="Re-discover models">&#8635; Refresh</button>';

        if (provider.keys && provider.keys.cooldown > 0) {
            html += '<button class="tool-btn warn" ' +
                'data-action="reset-cooldowns" ' +
                'data-pid="' + esc(provider.id) +
                '" title="Clear all 429 cooldowns">Reset 429</button>';
        }

        // Danger group
        html += '<button class="tool-btn danger" data-action="delete" ' +
            'data-pid="' + esc(provider.id) +
            '" title="Remove this provider">&#10005;</button>';
        html += '</div></div>';

        return html;
    }

    /** One stored key with its status and a delete button. */
    function renderKey(provider, key, index) {
        var status = key.status || 'ready';
        var icon = status === 'burned' ? '&#10005;' : '&#9679;';
        var title = status === 'ready'
            ? 'ready'
            : status === 'cooldown'
                ? '429 — ' + Math.ceil(
                      (key.cooldownRemainingMs || 0) / 1000
                  ) + 's left'
                : (key.lastError || 'authentication error');

        var html = '<div class="key-row">';

        html += '<span class="key-status ' + esc(status) +
            '" title="' + esc(title) + '">' + icon + '</span>';

        if (key.name) {
            html += '<span class="key-name" title="' +
                esc(key.name) + '">' + esc(key.name) + '</span>';
        }

        html += '<span class="key-preview">' +
            esc(key.preview) + '</span>';

        html += '<button class="del" data-action="del-key" ' +
            'data-pid="' + esc(provider.id) + '" ' +
            'data-index="' + index + '" ' +
            'title="Remove this key">&#10005;</button>';

        html += '</div>';

        return html;
    }

    function renderModel(provider, model) {
        var html = '<div class="model' +
            (model.hidden ? ' hidden-model' : '') + '">';

        html += '<span class="mid" title="' + esc(model.id) + '">' +
            esc(model.name || model.id) + '</span>';

        html += '<button class="free-toggle' +
            (model.free ? ' active' : '') + '" ' +
            'data-action="toggle-free" ' +
            'data-pid="' + esc(provider.id) + '" ' +
            'data-mid="' + esc(model.id) + '" ' +
            'title="Mark or unmark as free — free models are easy to ' +
            'find by typing &quot;free&quot; in the model picker">' +
            (model.free ? '&#10003; free' : '+ free') + '</button>';

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

        if (action === 'import-json') {
            post({ type: 'importJson' });
            return;
        }

        if (action === 'offers-visit') {
            post({ type: 'openOffersSite' });
            return;
        }

        if (action === 'offers-hide') {
            post({ type: 'hideOffersBanner' });
            return;
        }

        if (action === 'offers-show') {
            post({ type: 'showOffersBanner' });
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

        if (action === 'pin') {
            event.preventDefault();
            event.stopPropagation();
            post({
                type: 'togglePinned',
                providerId: pid
            });
            return;
        }

        if (!provider) {
            return;
        }

        if (action === 'edit') {
            openEditProviderForm(provider);
        } else if (action === 'add-keys') {
            openAddKeysForm(provider);
        } else if (action === 'del-key') {
            post({
                type: 'removeKey',
                providerId: provider.id,
                index: Number(button.getAttribute('data-index'))
            });
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
        } else if (action === 'toggle-free') {
            var modelId = button.getAttribute('data-mid');
            var model = null;

            for (var i = 0; i < provider.models.length; i++) {
                if (provider.models[i].id === modelId) {
                    model = provider.models[i];
                    break;
                }
            }

            if (model) {
                post({
                    type: 'toggleModelFree',
                    providerId: provider.id,
                    modelId: modelId,
                    free: !model.free
                });
            }
        }
    });

    document.getElementById('btn-add')
        .addEventListener('click', openAddProviderForm);

    document.getElementById('btn-import')
        .addEventListener('click', function () {
            post({ type: 'importJson' });
        });

    document.getElementById('btn-export')
        .addEventListener('click', function () {
            post({ type: 'exportJson' });
        });

    document.getElementById('btn-refresh')
        .addEventListener('click', function () {
            post({ type: 'refreshAll' });
        });

    document.getElementById('btn-free')
        .addEventListener('click', function () {
            post({ type: 'refreshFreeModels' });
        });

    document.getElementById('free-status')
        .addEventListener('click', function (event) {
            var button = event.target.closest('[data-action]');

            if (!button) {
                return;
            }

            var action = button.getAttribute('data-action');

            if (action === 'refresh-free') {
                post({ type: 'refreshFreeModels' });
            } else if (action === 'enable-free') {
                post({ type: 'enableFreeModels' });
            }
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
        } else if (message.type === 'feedback') {
            showToast(
                message.kind || 'info',
                message.title || '',
                message.detail || undefined
            );
        }
    });

    post({ type: 'ready' });
})();

