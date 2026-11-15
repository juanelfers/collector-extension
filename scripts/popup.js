// The toolbar popup: this tab first (which store, what is on it), then the marks' switches and
// the state of the data. Everything else lives in the options page.

// Legacy: collections saved by the old Pokellector reader. Shown only when there are any.
(() => {
    const table = document.querySelector('table tbody');
    const section = document.getElementById('collections-section');
    chrome.storage.local.get(['collections']).then(({ collections }) => {
        if (!collections || !table) return;
        for (const collection of Object.values(collections)) {
            const row = document.createElement('tr');
            const name = document.createElement('td');
            const count = document.createElement('td');
            name.textContent = collection.name;
            count.textContent = `${collection.cardCount} / ${collection.cardQuantity}`;
            row.appendChild(name);
            row.appendChild(count);
            table.appendChild(row);
        }
        if (section && Object.keys(collections).length) section.hidden = false;
    });
})();

// ─── Marcas en las tiendas ───────────────────────────────────────────────────

(() => {
    const core = globalThis.PAShopCore;
    const section = document.getElementById('shop-section');
    if (!section) return;
    if (!core) {
        section.hidden = true;
        return;
    }

    const $ = (id) => document.getElementById(id);
    const enabled = $('shop-enabled');
    const dimOwned = $('shop-dim-owned');
    const variants = [...document.querySelectorAll('input[name="shop-variant"]')];
    const age = $('shop-age');
    const session = $('shop-session');
    const login = $('shop-login');
    const warnings = $('shop-warnings');
    const refresh = $('shop-refresh');

    const REFRESH_LABEL = refresh.textContent;

    let settings = core.normalizeSettings(null);
    let activeTab = null; // { id, store } when the active tab is a store

    function renderSettings(saved) {
        settings = core.normalizeSettings(saved);
        enabled.checked = settings.enabled;
        dimOwned.checked = settings.dimOwned;
        variants.forEach((input) => {
            input.checked = input.value === settings.variant;
        });
    }

    // Read and merge: the content script keeps its own fields in the same key.
    async function saveSettings(patch) {
        const got = await chrome.storage.local.get(core.SETTINGS_KEY);
        const saved = got[core.SETTINGS_KEY];
        const next = core.normalizeSettings({ ...saved, ...(typeof patch === 'function' ? patch(core.normalizeSettings(saved)) : patch) });
        await chrome.storage.local.set({ [core.SETTINGS_KEY]: next });
        settings = next;
        // Tabs do not listen to storage: the SW tells them. The setting is saved either way.
        try {
            await chrome.runtime.sendMessage({ type: 'shop-settings-changed' });
        } catch (err) {
            console.warn('[popup] shop-settings-changed', err);
        }
    }

    function renderStatus(status, failure) {
        if (!status) {
            age.textContent = failure || 'no se pudo leer el estado';
            session.textContent = 'sin chequear';
            login.hidden = true;
            warnings.hidden = true;
            return;
        }

        const ageText = status.snapshotAgeMs === null ? 'todavía no hay datos' : core.formatAge(status.snapshotAgeMs);
        age.textContent = status.refreshing ? `${ageText} (actualizando)` : ageText;

        session.textContent = status.auth === true ? 'iniciada' : status.auth === false ? 'sin sesión' : 'sin chequear';
        login.hidden = status.auth === true;
        login.href = status.loginUrl;

        const lines = [...(status.warnings || [])];
        if (status.error) lines.unshift(`No se pudo actualizar: ${status.error}`);
        warnings.replaceChildren(
            ...lines.map((line) => {
                const item = document.createElement('li');
                item.textContent = line;
                return item;
            }),
        );
        warnings.hidden = lines.length === 0;
    }

    async function ask(type) {
        try {
            const answer = await chrome.runtime.sendMessage({ type });
            renderStatus(answer?.status);
        } catch (err) {
            renderStatus(null, String(err?.message || err));
        }
    }

    // ─── this tab ─────────────────────────────────────────────────────────

    const tabSection = $('tab-section');
    const tabStore = $('tab-store');
    const tabStoreOn = $('tab-store-on');
    const tabNumbers = $('tab-numbers');
    const tabPanel = $('tab-panel');
    const tabHint = $('tab-hint');

    function hint(text) {
        if (!tabHint) return;
        tabHint.textContent = text || '';
        tabHint.hidden = !text;
    }

    function renderTab(stats) {
        if (!tabSection || !activeTab) return;
        tabSection.hidden = false;
        tabStore.textContent = activeTab.store.label;
        tabStoreOn.checked = core.isStoreOn(settings, activeTab.store.key);
        tabStoreOn.disabled = !settings.enabled;
        if (!stats) {
            tabNumbers.hidden = true;
            tabPanel.hidden = true;
            hint(settings.enabled ? 'Recargá la pestaña para ver las marcas.' : 'Las marcas están apagadas.');
            return;
        }
        tabNumbers.hidden = !stats.on;
        $('tab-buy').textContent = String(stats.buy);
        $('tab-have').textContent = String(stats.have);
        $('tab-cards').textContent = String(stats.cards);
        tabPanel.hidden = !(stats.on && stats.productPage && stats.productKnown);
        tabPanel.textContent = stats.panelShown ? 'Ocultar el panel de la carta' : 'Mostrar el panel de la carta';
        if (!stats.on) hint(settings.enabled ? 'Las marcas están apagadas en esta tienda.' : 'Las marcas están apagadas.');
        else if (stats.auth === false) hint('Sin sesión del admin: no se ven tus datos.');
        else hint('');
    }

    async function askTab() {
        if (!activeTab) return null;
        try {
            return (await chrome.tabs.sendMessage(activeTab.id, { type: 'shop:tab-stats' })) || null;
        } catch {
            return null; // opened before the extension loaded, or still loading
        }
    }

    async function loadTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const store = tab?.url ? core.storeFromHost(new URL(tab.url).hostname) : null;
            if (!store) return;
            activeTab = { id: tab.id, store };
            renderTab(await askTab());
        } catch {
            // no tabs API here, or an url that does not parse: no tab section
        }
    }

    const refreshTab = async () => renderTab(await askTab());

    tabStoreOn?.addEventListener('change', async () => {
        if (!activeTab) return;
        const key = activeTab.store.key;
        const on = tabStoreOn.checked;
        await saveSettings((saved) => ({
            disabledStores: on ? saved.disabledStores.filter((k) => k !== key) : [...saved.disabledStores, key],
        }));
        setTimeout(refreshTab, 400);
    });

    tabPanel?.addEventListener('click', async () => {
        if (!activeTab) return;
        try {
            await chrome.tabs.sendMessage(activeTab.id, { type: 'shop:toggle-panel' });
        } catch {
            // the tab went away
        }
        setTimeout(refreshTab, 150);
    });

    // ─── the rest ─────────────────────────────────────────────────────────

    enabled.addEventListener('change', async () => {
        await saveSettings({ enabled: enabled.checked });
        if (activeTab) setTimeout(refreshTab, 400);
    });
    dimOwned.addEventListener('change', () => saveSettings({ dimOwned: dimOwned.checked }));
    variants.forEach((input) => {
        input.addEventListener('change', () => {
            if (input.checked) saveSettings({ variant: input.value });
        });
    });

    refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = 'Actualizando...';
        await ask('shop-refresh');
        refresh.disabled = false;
        refresh.textContent = REFRESH_LABEL;
    });

    $('shortcut-set')?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        globalThis.close?.();
    });

    $('open-options')?.addEventListener('click', () => {
        try {
            chrome.runtime.openOptionsPage();
        } catch (err) {
            console.warn('[popup] openOptionsPage', err);
        }
        globalThis.close?.();
    });

    try {
        const version = $('version');
        if (version) version.textContent = `Versión ${chrome.runtime.getManifest().version}`;
    } catch {
        // no manifest here
    }

    // The shortcut as Chrome has it now: it can be changed in chrome://extensions/shortcuts.
    try {
        chrome.commands?.getAll?.().then((commands) => {
            const keys = commands.find((command) => command.name === 'toggle-panel')?.shortcut;
            const node = $('shortcut-keys');
            if (node) node.textContent = keys || 'sin atajo';
            // Chrome does not always give the suggested keys to an extension that was already installed.
            const set = $('shortcut-set');
            if (set && !keys) set.hidden = false;
        });
    } catch {
        // no commands API here
    }

    chrome.storage.local.get(core.SETTINGS_KEY).then((got) => {
        renderSettings(got[core.SETTINGS_KEY]);
        loadTab();
    });
    ask('shop-status');
})();
