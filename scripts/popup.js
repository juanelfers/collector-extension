const table = document.querySelector('table tbody');

chrome.storage.local.get(['collections']).then(({ collections }) => {
    if (!collections) return;
    
    Object.values(collections).forEach(collection => {

        const collectionRow = document.createElement('tr');
        collectionRow.innerHTML = `
            <td>${collection.name}</td>
            <td>${collection.cardCount} / ${collection.cardQuantity}</td>
        `;
        table.appendChild(collectionRow);
    });
});

// ─── Marcas en las tiendas ───────────────────────────────────────────────────

(() => {
    const core = globalThis.PAShopCore;
    const section = document.getElementById('shop-section');
    if (!section) return;
    if (!core) {
        section.hidden = true;
        return;
    }

    const enabled = document.getElementById('shop-enabled');
    const dimOwned = document.getElementById('shop-dim-owned');
    const variants = [...document.querySelectorAll('input[name="shop-variant"]')];
    const age = document.getElementById('shop-age');
    const session = document.getElementById('shop-session');
    const login = document.getElementById('shop-login');
    const warnings = document.getElementById('shop-warnings');
    const refresh = document.getElementById('shop-refresh');

    const REFRESH_LABEL = refresh.textContent;

    function renderSettings(saved) {
        const settings = core.normalizeSettings(saved);
        enabled.checked = settings.enabled;
        dimOwned.checked = settings.dimOwned;
        variants.forEach((input) => {
            input.checked = input.value === settings.variant;
        });
    }

    // Read and merge: the content script keeps its own fields in the same key.
    async function saveSettings(patch) {
        const got = await chrome.storage.local.get(core.SETTINGS_KEY);
        const next = core.normalizeSettings({ ...got[core.SETTINGS_KEY], ...patch });
        await chrome.storage.local.set({ [core.SETTINGS_KEY]: next });
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

    enabled.addEventListener('change', () => saveSettings({ enabled: enabled.checked }));
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

    chrome.storage.local.get(core.SETTINGS_KEY).then((got) => renderSettings(got[core.SETTINGS_KEY]));
    ask('shop-status');
})();
