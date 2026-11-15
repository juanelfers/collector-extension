// The options page. Every control saves the moment it changes, read-merge-write on
// `shop:settings` like the popup and the content script, and then the SW tells the open store
// tabs. `adminBase` is its own key, shared with ml-admin-link.js.

(() => {
    const core = globalThis.PAShopCore;
    if (!core) return;

    const $ = (id) => document.getElementById(id);
    const radios = (name) => [...document.querySelectorAll(`input[name="${name}"]`)];

    const ADMIN_PROD = core.DEFAULT_ADMIN_BASE;
    let settings = core.normalizeSettings(null);

    // ─── saving ───────────────────────────────────────────────────────────

    let savedTimer = null;
    function flashSaved() {
        const node = $('opt-saved');
        node.classList.add('on');
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => node.classList.remove('on'), 1400);
    }

    async function tellSw(type) {
        try {
            return await chrome.runtime.sendMessage({ type });
        } catch (err) {
            console.warn('[options]', type, err);
            return null;
        }
    }

    /** `patch` is an object or a function of what is saved now. */
    async function save(patch) {
        const got = await chrome.storage.local.get(core.SETTINGS_KEY);
        const saved = core.normalizeSettings(got[core.SETTINGS_KEY]);
        const next = core.normalizeSettings({ ...got[core.SETTINGS_KEY], ...(typeof patch === 'function' ? patch(saved) : patch) });
        await chrome.storage.local.set({ [core.SETTINGS_KEY]: next });
        settings = next;
        render();
        flashSaved();
        await tellSw('shop-settings-changed');
    }

    // ─── painting ─────────────────────────────────────────────────────────

    function setRadio(name, value) {
        for (const input of radios(name)) input.checked = input.value === value;
    }

    function renderStores() {
        const box = $('opt-stores');
        if (!box.children.length) {
            for (const store of core.STORES) {
                const label = document.createElement('label');
                label.className = 'switch';
                const name = document.createElement('span');
                name.textContent = store.label;
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.dataset.store = store.key;
                input.addEventListener('change', () => {
                    const on = input.checked;
                    save((saved) => ({
                        disabledStores: on ? saved.disabledStores.filter((key) => key !== store.key) : [...saved.disabledStores, store.key],
                    }));
                });
                label.append(name, input);
                box.append(label);
            }
        }
        for (const input of box.querySelectorAll('input[data-store]')) {
            input.checked = !settings.disabledStores.includes(input.dataset.store);
            input.disabled = !settings.enabled;
        }
    }

    function render() {
        $('opt-enabled').checked = settings.enabled;
        setRadio('opt-variant', settings.variant);
        $('opt-dim').checked = settings.dimOwned;
        renderStores();

        $('opt-panel-enabled').checked = settings.panelEnabled;
        $('opt-panel-start').value = typeof settings.panelCollapsed === 'boolean' ? (settings.panelCollapsed ? 'collapsed' : 'open') : 'auto';
        setRadio('opt-corner', settings.panelCorner);
        setRadio('opt-size', settings.panelSize);
        const moved = Object.keys(settings.panelPositions).map((key) => core.STORES.find((s) => s.key === key)?.label).filter(Boolean);
        $('opt-positions').textContent = moved.length ? `Movido en ${moved.join(', ')}` : 'En ninguna tienda lo moviste.';
        $('opt-reset-positions').disabled = !moved.length;

        $('opt-badge').checked = settings.badge;
    }

    function renderStatus(status, failure) {
        const age = $('opt-age');
        const session = $('opt-session');
        const login = $('opt-login');
        const warnings = $('opt-warnings');
        if (!status) {
            age.textContent = failure ? 'sin respuesta' : '...';
            session.textContent = 'sin chequear';
            login.hidden = true;
            warnings.hidden = true;
            return;
        }
        const ageText = status.snapshotAgeMs === null ? 'todavía no' : core.formatAge(status.snapshotAgeMs);
        age.textContent = status.refreshing ? `${ageText}, actualizando` : ageText;
        session.textContent = status.auth === true ? 'Iniciada' : status.auth === false ? 'Sin sesión' : 'Sin chequear';
        login.hidden = status.auth === true;
        if (status.loginUrl) login.href = status.loginUrl;
        const lines = [...(status.warnings || [])];
        if (status.ownTooOld) lines.unshift('Tus datos tienen más de 2 días: las marcas no los usan.');
        if (status.error) lines.unshift(`No se pudo actualizar: ${status.error}`);
        warnings.replaceChildren(
            ...lines.map((text) => {
                const item = document.createElement('li');
                item.textContent = text;
                return item;
            }),
        );
        warnings.hidden = !lines.length;
    }

    async function renderAdmin() {
        const { adminBase } = await chrome.storage.local.get('adminBase');
        const base = String(adminBase || ADMIN_PROD).replace(/\/+$/, '');
        setRadio('opt-admin', base);
        const warn = $('opt-admin-warn');
        const known = radios('opt-admin').some((input) => input.value === base);
        warn.hidden = base === ADMIN_PROD;
        warn.textContent = known ? `Ahora mismo los datos salen de ${base.replace(/^https?:\/\//, '')}` : `Ahora mismo los datos salen de ${base}`;
    }

    async function loadStatus(type = 'shop-status') {
        const answer = await tellSw(type);
        renderStatus(answer?.status, !answer);
    }

    // ─── wiring ───────────────────────────────────────────────────────────

    $('opt-enabled').addEventListener('change', (event) => save({ enabled: event.target.checked }));
    $('opt-dim').addEventListener('change', (event) => save({ dimOwned: event.target.checked }));
    for (const input of radios('opt-variant')) input.addEventListener('change', () => input.checked && save({ variant: input.value }));

    $('opt-panel-enabled').addEventListener('change', (event) => save({ panelEnabled: event.target.checked }));
    $('opt-panel-start').addEventListener('change', (event) => {
        const value = event.target.value;
        // "Según la ventana" is no choice at all: normalizeSettings drops a panelCollapsed that is not a boolean.
        save({ panelCollapsed: value === 'auto' ? null : value === 'collapsed' });
    });
    for (const input of radios('opt-corner')) input.addEventListener('change', () => input.checked && save({ panelCorner: input.value }));
    for (const input of radios('opt-size')) input.addEventListener('change', () => input.checked && save({ panelSize: input.value }));
    $('opt-reset-positions').addEventListener('click', () => save({ panelPositions: {} }));
    $('opt-badge').addEventListener('change', (event) => save({ badge: event.target.checked }));

    $('opt-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

    const refresh = $('opt-refresh');
    const refreshLabel = refresh.textContent;
    refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = 'Actualizando...';
        await loadStatus('shop-refresh');
        refresh.disabled = false;
        refresh.textContent = refreshLabel;
    });

    for (const input of radios('opt-admin')) {
        input.addEventListener('change', async () => {
            if (!input.checked) return;
            await chrome.storage.local.set({ adminBase: input.value });
            await renderAdmin();
            flashSaved();
            // The SW drops what came from the other admin on its next message; this one also refetches.
            await loadStatus('shop-refresh');
        });
    }

    // ─── start ────────────────────────────────────────────────────────────

    try {
        $('opt-version').textContent = `Extensión · versión ${chrome.runtime.getManifest().version}`;
    } catch {
        // no manifest here
    }
    chrome.commands?.getAll?.().then((commands) => {
        const keys = commands.find((command) => command.name === 'toggle-panel')?.shortcut;
        $('opt-shortcut').textContent = keys || 'Sin atajo';
    });

    chrome.storage.local.get(core.SETTINGS_KEY).then((got) => {
        settings = core.normalizeSettings(got[core.SETTINGS_KEY]);
        render();
    });
    renderAdmin();
    loadStatus();

    // Another tab, the popup or a drag can change the settings while this page is open.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        chrome.storage.local.get(core.SETTINGS_KEY).then((got) => {
            settings = core.normalizeSettings(got[core.SETTINGS_KEY]);
            render();
        });
        loadStatus();
    });
})();
