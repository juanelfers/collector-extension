// Shop marks, service worker side: the snapshot of own data and the card lookups.
//
// Loaded with importScripts from service-worker.js, after shop-core.js. Its own
// onMessage listener only reacts to `shop-*`, so ARCA and BringIt never go through here.
//
// The SW can die at any moment and every module variable dies with it, so nothing that
// matters lives only in one and no "refresh running" flag is ever persisted: after a
// restart the next message reads storage and, if needed, simply asks again.
//
// What kills a SW is being idle: about 30 s with no pending event. A message whose answer
// has not been sent is pending; a fetch alone is not. So a refresh behind an answer already
// sent gets about 30 s of life, and SNAPSHOT_TIMEOUT_MS gives up just before that, while the
// SW can still write down why. If it dies anyway, the next lookup repeats the refresh.
//
// Tabs do not listen to chrome.storage.onChanged: that event hands every listener the full
// old and new value of every write in the extension, ARCA's PDFs and this snapshot included.
// The SW tells them with a `shop:changed` message instead.
//
// No tokens in here: the admin session cookie is the only credential.

(function () {
    'use strict';

    const core = globalThis.PAShopCore;

    const SNAPSHOT_KEY = 'shop:snapshot';
    const STATUS_KEY = 'shop:status';
    const LOOKUP_PREFIX = 'shop:lookup:';
    const PRUNED_AT_KEY = 'shop:lookupPrunedAt';
    const CACHE_BASE_KEY = 'shop:cacheBase';
    const FAILED_AT_KEY = 'shop:snapshotFailedAt';

    const CONTENT_SCRIPT = 'scripts/controllers/shop-marks.js';

    const SNAPSHOT_PATH = '/api/admin/compras/extension/snapshot';
    const LOOKUP_PATH = '/api/admin/compras/extension/lookup';
    const SIGN_IN_PATH = '/api/auth/signin';
    const SIGN_IN_REDIRECT = /\/(api\/auth\/signin|auth\/signin|signin|login)\b/i;

    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    const SNAPSHOT_STALE_MS = 15 * MINUTE;
    const NO_SNAPSHOT_WAIT_MS = 20 * 1000;
    const SNAPSHOT_TIMEOUT_MS = 28 * 1000;
    const LOOKUP_TIMEOUT_MS = 60 * 1000;
    const LOOKUP_TTL_RESOLVED_MS = 24 * HOUR;
    const LOOKUP_TTL_UNKNOWN_MS = 6 * HOUR;
    const PRUNE_EVERY_MS = 24 * HOUR;
    // After a failure or a 401/403, do not hit the admin again on every scan of the grid.
    // Saved in storage too: a SW that restarts between lookups must not start this over.
    const RETRY_AFTER_MS = 30 * 1000;
    // Own data unknown and nothing saved: each try costs KT a call to the PA feed, up to its
    // whole timeout. Counted from the saved snapshot's fetchedAt, so a SW restart keeps it.
    const OWN_NULL_RETRY_MS = 5 * MINUTE;
    const BATCH_SIZE = 60;
    const MAX_CONCURRENT = 2;
    // What a cache entry remembers having been asked with, and how many different values of
    // each field. Past that it stops asking until the entry expires: a title that changes on
    // every render must not become a POST per render.
    const ASKED_FIELDS = ['productId', 'setName', 'title'];
    const ASKED_KEEP = 6;

    let memSnapshot = null;
    let snapshotLoad = null;
    let refreshInFlight = null;
    let lastRefreshAttemptAt = 0;
    let failedAtLoad = null;
    let authBlockedUntil = 0;
    // Goes up when the caches are dropped: an answer that was already on its way is not for them.
    let cacheEpoch = 0;
    // The same for lookups, and also goes up with "Actualizar ahora". Separate because the
    // button clears lookups and not the snapshot: a refresh already running is the one it wants.
    let lookupEpoch = 0;

    const inFlightLookups = new Map();
    const slotQueue = [];
    let slotsInUse = 0;

    // ─── storage, which must never take a message down ────────────────────────

    const storage = {
        async get(keys) {
            try {
                return (await chrome.storage.local.get(keys)) || {};
            } catch (err) {
                console.warn('[shop-data] storage.get', err);
                return {};
            }
        },
        async set(items) {
            try {
                await chrome.storage.local.set(items);
            } catch (err) {
                console.warn('[shop-data] storage.set', err);
            }
        },
        async remove(keys) {
            try {
                await chrome.storage.local.remove(keys);
            } catch (err) {
                console.warn('[shop-data] storage.remove', err);
            }
        },
    };

    async function getAdminBase() {
        const { adminBase } = await storage.get('adminBase');
        return String(adminBase || core.DEFAULT_ADMIN_BASE).replace(/\/+$/, '');
    }

    // ─── status, persisted so the popup can read it after a restart ───────────

    let statusLoad = null;

    function loadStatus() {
        if (!statusLoad) {
            statusLoad = storage.get(STATUS_KEY).then((got) => ({
                auth: null,
                warnings: [],
                snapshotError: null,
                lookupError: null,
                ...(got[STATUS_KEY] || {}),
            }));
        }
        return statusLoad;
    }

    async function patchStatus(patch) {
        const status = await loadStatus();
        const changed = Object.keys(patch).some((key) => JSON.stringify(status[key]) !== JSON.stringify(patch[key]));
        if (!changed) return;
        Object.assign(status, patch);
        await storage.set({ [STATUS_KEY]: status });
    }

    async function publicStatus() {
        const status = await loadStatus();
        const adminBase = await getAdminBase();
        const snapshot = await loadSnapshot();
        const now = Date.now();
        const ownAt = snapshot?.ownAt ?? null;
        const ageMs = ownAt ? Math.max(0, now - ownAt) : null;
        const ownTooOld = core.isOwnTooOld(snapshot, now);
        return {
            auth: status.auth,
            loginUrl: `${adminBase}${SIGN_IN_PATH}`,
            adminBase,
            ownKnown: Boolean(snapshot?.own) && !ownTooOld,
            ownTooOld,
            snapshotAt: ownAt,
            snapshotAgeMs: ageMs,
            stale: ageMs === null || ageMs > SNAPSHOT_STALE_MS,
            refreshing: Boolean(refreshInFlight),
            warnings: status.warnings,
            error: status.snapshotError || status.lookupError || null,
        };
    }

    // ─── admin calls ──────────────────────────────────────────────────────────

    /** Never rejects: `{ data }`, `{ authFailed: true }` or `{ error }`. */
    async function callAdmin(path, init, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const base = await getAdminBase();
            const res = await fetch(`${base}${path}`, {
                credentials: 'include',
                cache: 'no-store',
                redirect: 'follow',
                signal: controller.signal,
                ...init,
            });
            if (res.status === 401 || res.status === 403) return { authFailed: true };
            if (res.redirected && SIGN_IN_REDIRECT.test(res.url || '')) return { authFailed: true };
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const data = await res.json();
            if (!data || typeof data !== 'object') return { error: 'respuesta inválida' };
            return { data };
        } catch (err) {
            return { error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
        } finally {
            clearTimeout(timer);
        }
    }

    async function noteAuthFailed() {
        authBlockedUntil = Date.now() + RETRY_AFTER_MS;
        await patchStatus({ auth: false });
    }

    // ─── snapshot ─────────────────────────────────────────────────────────────

    async function loadSnapshot() {
        if (memSnapshot) return memSnapshot;
        if (!snapshotLoad) {
            snapshotLoad = storage.get(SNAPSHOT_KEY).then((got) => {
                const saved = got[SNAPSHOT_KEY];
                if (!memSnapshot && saved && typeof saved.fetchedAt === 'number') memSnapshot = saved;
            });
        }
        await snapshotLoad;
        return memSnapshot;
    }

    const isStale = (snapshot) =>
        Date.now() - snapshot.fetchedAt > (snapshot.own ? SNAPSHOT_STALE_MS : OWN_NULL_RETRY_MS);

    /**
     * When PA last answered: KT can be serving its own last good copy, and that age is the one
     * the 48 h count. Without a usable date it is now, and it is never later than now.
     */
    function ownAtFrom(data, now) {
        const at = typeof data.ownAt === 'string' ? Date.parse(data.ownAt) : NaN;
        return Number.isNaN(at) ? now : Math.min(now, at);
    }

    /**
     * Each part of the snapshot fails alone: a part that did not come keeps its last good value.
     * `unsettled` describes `own`, so it only changes when `own` came: an empty list next to a
     * failed `own` must not settle the products of the copy that stays.
     */
    function mergeSnapshot(prev, data, now) {
        const part = (name) => data[name] ?? prev?.[name] ?? null;
        return {
            generatedAt: data.generatedAt ?? null,
            fetchedAt: now,
            ownAt: data.own ? ownAtFrom(data, now) : (prev?.ownAt ?? null),
            own: part('own'),
            unsettled: data.own && Array.isArray(data.unsettled) ? data.unsettled : (prev?.unsettled ?? null),
            mappedGroups: part('mappedGroups'),
            important: part('important'),
            meta: part('meta'),
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
        };
    }

    /**
     * The last failed snapshot of an earlier SW life, once per life. The larger of the two wins.
     * A date in the future means the clock moved back: it holds nothing and is removed, because
     * left there every new SW life would obey it again until the clock caught up.
     */
    function loadFailedAt() {
        if (!failedAtLoad) {
            failedAtLoad = storage.get(FAILED_AT_KEY).then(async (got) => {
                const saved = got[FAILED_AT_KEY];
                if (typeof saved !== 'number') return;
                if (saved > Date.now()) await storage.remove(FAILED_AT_KEY);
                else lastRefreshAttemptAt = Math.max(lastRefreshAttemptAt, saved);
            });
        }
        return failedAtLoad;
    }

    async function noteRefreshFailed() {
        lastRefreshAttemptAt = Date.now();
        await storage.set({ [FAILED_AT_KEY]: lastRefreshAttemptAt });
    }

    async function doRefresh() {
        const epoch = cacheEpoch;
        const out = await callAdmin(SNAPSHOT_PATH, { method: 'GET' }, SNAPSHOT_TIMEOUT_MS);
        if (epoch !== cacheEpoch) return false;
        if (out.authFailed) {
            await noteRefreshFailed();
            await noteAuthFailed();
            return false;
        }
        if (out.error) {
            await noteRefreshFailed();
            await patchStatus({ snapshotError: out.error });
            return false;
        }

        const next = mergeSnapshot(await loadSnapshot(), out.data, Date.now());
        memSnapshot = next;
        authBlockedUntil = 0;
        await storage.set({ [SNAPSHOT_KEY]: next });
        await storage.remove(FAILED_AT_KEY);
        await patchStatus({
            auth: true,
            warnings: next.warnings,
            snapshotError: null,
        });
        pruneLookups().catch((err) => console.warn('[shop-data] prune', err));
        // Own data still unknown: there is nothing new to paint, and a tab told to ask again
        // would only forget how many times it already tried.
        if (next.own) await tellTabs('snapshot');
        return true;
    }

    /** The running refresh, a new one, or null while the last failure is too recent. */
    function refreshSnapshot({ force = false } = {}) {
        if (refreshInFlight) return refreshInFlight;
        if (!force && Date.now() - lastRefreshAttemptAt < RETRY_AFTER_MS) return null;
        lastRefreshAttemptAt = Date.now();
        const running = doRefresh()
            .catch((err) => {
                console.warn('[shop-data] refresh', err);
                return false;
            })
            .finally(() => {
                if (refreshInFlight === running) refreshInFlight = null;
            });
        refreshInFlight = running;
        return running;
    }

    function withinWait(promise, ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            promise.finally(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /** Stale data now and a refresh behind it. With nothing saved, wait a bounded time. */
    async function snapshotForAnswer() {
        const [snapshot] = await Promise.all([loadSnapshot(), loadFailedAt()]);
        if (snapshot) {
            if (isStale(snapshot)) refreshSnapshot();
            return snapshot;
        }
        const pending = refreshSnapshot();
        if (pending) await withinWait(pending, NO_SNAPSHOT_WAIT_MS);
        return memSnapshot;
    }

    // ─── telling the tabs ─────────────────────────────────────────────────────

    /** The store pages, from the manifest entry that injects the content script there. */
    function storeTabPatterns() {
        const scripts = chrome.runtime.getManifest().content_scripts || [];
        return scripts.find((script) => script.js?.includes(CONTENT_SCRIPT))?.matches || [];
    }

    /** Never rejects. A tab that cannot be reached (still loading, discarded) is simply skipped. */
    async function tellTabs(what) {
        try {
            const patterns = storeTabPatterns();
            if (!patterns.length) return;
            const tabs = await chrome.tabs.query({ url: patterns });
            await Promise.all(
                tabs.map((tab) =>
                    Promise.resolve()
                        .then(() => chrome.tabs.sendMessage(tab.id, { type: 'shop:changed', what }))
                        .catch(() => {}),
                ),
            );
        } catch (err) {
            console.warn('[shop-data] tellTabs', err);
        }
    }

    // ─── lookups ──────────────────────────────────────────────────────────────

    const isResolved = (result) => Boolean(result && result.status !== 'unknown' && result.card);
    const lookupTtl = (result) => (isResolved(result) ? LOOKUP_TTL_RESOLVED_MS : LOOKUP_TTL_UNKNOWN_MS);
    const isFresh = (entry, now) =>
        Boolean(entry && entry.result && typeof entry.at === 'number' && now - entry.at < lookupTtl(entry.result));

    /** Whether this item carries a value the cached entry was not asked with yet. */
    const asksSomethingNew = (entry, item) =>
        ASKED_FIELDS.some((field) => {
            const seen = entry.asked?.[field] || [];
            return Boolean(item[field]) && !seen.includes(item[field]) && seen.length < ASKED_KEEP;
        });

    /** The values already asked plus this item's. All of them, so two pages can't take turns re-asking. */
    function mergeAsked(asked, item) {
        const merged = {};
        for (const field of ASKED_FIELDS) {
            const seen = asked?.[field] || [];
            const isNew = item[field] && !seen.includes(item[field]) && seen.length < ASKED_KEEP;
            merged[field] = isNew ? [...seen, item[field]] : seen;
        }
        return merged;
    }

    async function lookupStorageKeys() {
        try {
            const local = chrome.storage.local;
            const allKeys = local.getKeys ? await local.getKeys() : Object.keys(await storage.get(null));
            return allKeys.filter((key) => key.startsWith(LOOKUP_PREFIX));
        } catch (err) {
            console.warn('[shop-data] lookup keys', err);
            return [];
        }
    }

    async function clearLookups() {
        const keys = await lookupStorageKeys();
        if (keys.length) await storage.remove(keys);
    }

    function withSlot(task) {
        return new Promise((resolve) => {
            const run = () => {
                slotsInUse += 1;
                Promise.resolve()
                    .then(task)
                    .catch((err) => {
                        console.warn('[shop-data] batch', err);
                        return {};
                    })
                    .then((value) => {
                        slotsInUse -= 1;
                        slotQueue.shift()?.();
                        resolve(value);
                    });
            };
            if (slotsInUse < MAX_CONCURRENT) run();
            else slotQueue.push(run);
        });
    }

    function toServerItem(item) {
        const out = { key: item.cacheKey, store: item.store, url: item.url };
        if (item.productId) out.productId = item.productId;
        if (item.title) out.title = item.title;
        if (item.setName) out.setName = item.setName;
        return out;
    }

    /** Resolves to `{ <cacheKey>: result }`, empty when the batch could not be answered. */
    async function postBatch(batch) {
        if (Date.now() < authBlockedUntil) return {};
        const epoch = lookupEpoch;
        const out = await callAdmin(
            LOOKUP_PATH,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: batch.map(toServerItem) }),
            },
            LOOKUP_TIMEOUT_MS,
        );
        if (epoch !== lookupEpoch) return {};
        if (out.authFailed) {
            await noteAuthFailed();
            return {};
        }
        if (out.error || !out.data.results || typeof out.data.results !== 'object') {
            await patchStatus({ lookupError: out.error || 'respuesta inválida' });
            return {};
        }

        const now = Date.now();
        const toCache = {};
        for (const item of batch) {
            const result = out.data.results[item.cacheKey];
            if (result && typeof result === 'object') {
                toCache[`${LOOKUP_PREFIX}${item.cacheKey}`] = { at: now, result, asked: mergeAsked(item.askedBefore, item) };
            }
        }
        await storage.set(toCache);
        await patchStatus({ auth: true, lookupError: null });
        return out.data.results;
    }

    function fetchMissing(items) {
        const notRunning = items.filter((item) => !inFlightLookups.has(item.cacheKey));
        for (let i = 0; i < notRunning.length; i += BATCH_SIZE) {
            const batch = notRunning.slice(i, i + BATCH_SIZE);
            const answered = withSlot(() => postBatch(batch));
            for (const item of batch) {
                const one = answered
                    .then((results) => results[item.cacheKey] || null)
                    .finally(() => {
                        // After a drop of the caches the map can already hold a newer question.
                        if (inFlightLookups.get(item.cacheKey) === one) inFlightLookups.delete(item.cacheKey);
                    });
                inFlightLookups.set(item.cacheKey, one);
            }
        }
        return Promise.all(items.map((item) => inFlightLookups.get(item.cacheKey)));
    }

    /** `Map<cacheKey, result>`. A key that could not be answered is simply absent. */
    async function resolveItems(items) {
        const results = new Map();
        const unique = new Map(items.map((item) => [item.cacheKey, item]));
        if (!unique.size) return results;

        const cached = await storage.get([...unique.keys()].map((key) => `${LOOKUP_PREFIX}${key}`));
        const now = Date.now();
        const missing = [];
        for (const [key, item] of unique) {
            const entry = cached[`${LOOKUP_PREFIX}${key}`];
            if (!isFresh(entry, now)) {
                missing.push(item);
                continue;
            }
            // A product page can bring the id the grid did not have, and a CoolStuffInc grid
            // a real set where its product page only has the site trail. Those can resolve an
            // unknown, so each different value is worth one question.
            if (!isResolved(entry.result) && asksSomethingNew(entry, item)) {
                missing.push({ ...item, askedBefore: entry.asked });
                continue;
            }
            results.set(key, entry.result);
        }

        if (missing.length) {
            const answers = await fetchMissing(missing);
            missing.forEach((item, i) => {
                if (answers[i]) results.set(item.cacheKey, answers[i]);
            });
        }
        return results;
    }

    /** Expired entries are never read again, and a day of browsing writes thousands. */
    async function pruneLookups() {
        const now = Date.now();
        const { [PRUNED_AT_KEY]: prunedAt } = await storage.get(PRUNED_AT_KEY);
        if (prunedAt && now - prunedAt < PRUNE_EVERY_MS) return;
        await storage.set({ [PRUNED_AT_KEY]: now });

        const keys = await lookupStorageKeys();
        if (!keys.length) return;
        const entries = await storage.get(keys);
        const expired = keys.filter((key) => !isFresh(entries[key], now));
        if (expired.length) await storage.remove(expired);
    }

    /**
     * Items as the content script sends them. `key` is only unique inside one store (two
     * Shopify stores share handles and their prices differ), so what is cached and sent
     * to the server is `<store>:<key>`. The answer goes back under the original `key`.
     */
    function cleanItems(items) {
        if (!Array.isArray(items)) return [];
        const clean = [];
        for (const item of items) {
            if (!item || typeof item.key !== 'string' || !item.key || typeof item.store !== 'string') continue;
            clean.push({
                key: item.key,
                cacheKey: `${item.store}:${item.key}`,
                store: item.store,
                url: typeof item.url === 'string' ? item.url : '',
                productId: Number(item.productId) > 0 ? Number(item.productId) : null,
                title: typeof item.title === 'string' ? item.title.slice(0, 300) : null,
                setName: typeof item.setName === 'string' ? item.setName.slice(0, 200) : null,
            });
        }
        return clean;
    }

    // ─── which admin the caches came from ─────────────────────────────────────

    /**
     * `adminBase` is shared with ml-admin-link.js, whose testing flow points it at a dev server,
     * and dev answers must not outlive that. Nothing remembered yet means nothing to compare.
     */
    async function dropCachesIfBaseChanged() {
        const base = await getAdminBase();
        const { [CACHE_BASE_KEY]: saved } = await storage.get(CACHE_BASE_KEY);
        if (saved === base) return;
        await storage.set({ [CACHE_BASE_KEY]: base });
        if (!saved) return;

        cacheEpoch += 1;
        lookupEpoch += 1;
        memSnapshot = null;
        snapshotLoad = null;
        statusLoad = null;
        refreshInFlight = null;
        lastRefreshAttemptAt = 0;
        authBlockedUntil = 0;
        inFlightLookups.clear();
        await storage.remove([SNAPSHOT_KEY, STATUS_KEY, PRUNED_AT_KEY, FAILED_AT_KEY]);
        await clearLookups();
    }

    // One at a time: two messages at once must not both find the change and drop twice.
    let baseCheck = Promise.resolve();
    function syncCacheBase() {
        baseCheck = baseCheck.then(dropCachesIfBaseChanged, dropCachesIfBaseChanged);
        return baseCheck;
    }

    // ─── messages ─────────────────────────────────────────────────────────────

    async function handleLookup(message) {
        const items = cleanItems(message.items);
        const [snapshot, results] = await Promise.all([snapshotForAnswer(), resolveItems(items)]);
        // Too old counts as absent: "loading", and the status tells the page why.
        const usable = core.isOwnTooOld(snapshot, Date.now()) ? null : snapshot;
        const marks = {};
        let answered = true;
        for (const item of items) {
            const result = results.get(item.cacheKey) || null;
            if (!result) answered = false;
            marks[item.key] = { result, own: core.shapeOwn(usable, result?.card) };
        }
        return { ok: answered, marks, status: await publicStatus() };
    }

    async function handleStatus() {
        return { ok: true, status: await publicStatus() };
    }

    /** The button promises fresh data: that includes market, offers and matches fixed in KT. */
    async function handleRefresh() {
        authBlockedUntil = 0;
        // A lookup already on its way answers from before the button: not written back, and the
        // next question does not wait for it.
        lookupEpoch += 1;
        inFlightLookups.clear();
        await clearLookups();
        const done = await refreshSnapshot({ force: true });
        return { ok: done === true, status: await publicStatus() };
    }

    async function handleSettingsChanged() {
        await Promise.all([tellTabs('settings'), syncActionIcon()]);
        return { ok: true };
    }

    // ─── the toolbar button ───────────────────────────────────────────────────

    const ICON_ON = { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png' };
    const ICON_OFF = { 16: '/icons/icon-off-16.png', 32: '/icons/icon-off-32.png' };
    const BADGE_STYLE = {
        buy: { background: '#BA4EFF', text: '#090611' },
        login: { background: '#B45309', text: '#FFFFFF' },
    };
    const ACTION_TITLE = 'PokeArgentum';

    /** Gray while the marks are off, so it shows without opening anything. */
    async function syncActionIcon() {
        if (!chrome.action?.setIcon) return;
        const got = await storage.get(core.SETTINGS_KEY);
        const on = core.normalizeSettings(got[core.SETTINGS_KEY]).enabled;
        try {
            await chrome.action.setIcon({ path: on ? ICON_ON : ICON_OFF });
        } catch (err) {
            console.warn('[shop-data] setIcon', err);
        }
    }

    /** What the tab's content script counted: cards to buy on the page, or "!" with no session. */
    async function handleBadge(message, sender) {
        const tabId = sender?.tab?.id;
        if (typeof tabId !== 'number' || !chrome.action?.setBadgeText) return { ok: false };
        const text = typeof message.text === 'string' ? message.text.slice(0, 4) : '';
        const style = BADGE_STYLE[message.kind] || BADGE_STYLE.buy;
        try {
            await chrome.action.setBadgeText({ tabId, text });
            if (text) {
                await chrome.action.setBadgeBackgroundColor({ tabId, color: style.background });
                await chrome.action.setBadgeTextColor?.({ tabId, color: style.text });
            }
            const title =
                message.kind === 'login'
                    ? `${ACTION_TITLE}: entrá al admin para ver tus datos`
                    : text
                      ? `${ACTION_TITLE}: ${text} ${text === '1' ? 'carta' : 'cartas'} para comprar en esta página`
                      : ACTION_TITLE;
            await chrome.action.setTitle({ tabId, title });
        } catch (err) {
            // the tab can be gone by now
        }
        return { ok: true };
    }

    async function handleOpenOptions() {
        try {
            await chrome.runtime.openOptionsPage();
        } catch (err) {
            console.warn('[shop-data] openOptionsPage', err);
        }
        return { ok: true };
    }

    /** The shortcut of the manifest (`toggle-panel`): to the active tab, if it is a store. */
    async function onCommand(command) {
        if (command !== 'toggle-panel') return;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id !== undefined) await chrome.tabs.sendMessage(tab.id, { type: 'shop:toggle-panel' });
        } catch {
            // not a store tab: nothing listens there
        }
    }

    /** A tab-specific badge outlives a navigation: leaving the store, it goes. A store's own page repaints it. */
    function onTabUpdated(tabId, info) {
        if (!info?.url || !chrome.action?.setBadgeText) return;
        let host = '';
        try {
            host = new URL(info.url).hostname;
        } catch {
            // about:blank and the like
        }
        if (core.storeFromHost(host)) return;
        chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
        chrome.action.setTitle({ tabId, title: ACTION_TITLE }).catch(() => {});
    }

    try {
        chrome.commands?.onCommand?.addListener(onCommand);
        chrome.tabs?.onUpdated?.addListener(onTabUpdated);
        syncActionIcon().catch(() => {});
    } catch (err) {
        console.warn('[shop-data] toolbar', err);
    }

    const HANDLERS = new Map([
        ['shop-lookup', handleLookup],
        ['shop-status', handleStatus],
        ['shop-refresh', handleRefresh],
        ['shop-settings-changed', handleSettingsChanged],
        ['shop-badge', handleBadge],
        ['shop-open-options', handleOpenOptions],
    ]);

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const handler = HANDLERS.get(message?.type);
        if (!handler) return false;
        syncCacheBase()
            .then(() => handler(message, sender))
            .then(sendResponse)
            .catch((err) => {
                console.warn('[shop-data]', message.type, err);
                sendResponse({ ok: false, marks: {}, error: String(err?.message || err), status: null });
            });
        return true; // sendResponse is async
    });
})();
