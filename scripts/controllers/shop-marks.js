// Shop marks, content script: paints on each store's cards whether Juan already has them.
//
// Everything about the store is untrusted and everything about the theme is unknown:
// - Nodes are built with textContent, never innerHTML.
// - Cards are found by walking up from the product links, without any theme class.
// - On store elements it only writes data-pa-shop-* attributes, never classes, because
//   a Vue or React re-render overwrites `class` and leaves those alone.
// - The marks are absolutely positioned (nothing moves) and only a click on the mark
//   itself is swallowed.
//
// It talks to the service worker through send() and reads settings through getSettings().
// Both look at window.__paShopStub first, so a live page can be exercised with canned
// answers and without reloading the extension. Same for alive().

(function () {
    'use strict';

    const core = globalThis.PAShopCore;
    if (!core) return;

    // Injected twice in the same world (the test harness does it): the last one wins.
    try {
        window.__paShopMarks?.teardown?.();
    } catch (err) {
        console.warn('[shop-marks] teardown', err);
    }

    const store = core.storeFromHost(location.hostname);
    if (!store) return;

    const ROOT = 'pa-shop-root';

    // Links in these are not product cards. Contract list, plus search suggestions.
    const IGNORE_SELECTOR =
        'header, nav, footer, [class*=drawer], [class*=menu], [id*=cart], [class*=predictive], [class*=autocomplete], [role=listbox]';
    // Themes such as Debut wrap the whole page in `.drawer-page-content`: that is not a drawer.
    const MAIN_SELECTOR = 'main, [role=main], #MainContent';
    const CART_FORM_SELECTOR = "form[action*='/cart/add']";
    const TIGHTEN_STOP = new Set(['A', 'IMG', 'PICTURE']);
    const BINDER_TITLE = /\(.+\)\s*\[.+\]/;

    const PAGE_SIZE_LIMIT = 900; // a "card" this big in both directions is really the page
    const PHOTO_MIN_WIDTH = 40;
    const STAMP_INSET = 6;

    const MAX_ITEMS_PER_MESSAGE = 60;
    const RETRY_MS = 30 * 1000;
    const MAX_ATTEMPTS = 5;
    const REASK_AFTER_MS = 15 * 60 * 1000;
    const SCAN_DELAY_MS = 200;
    const HOVER_OPEN_MS = 120;
    const HOVER_CLOSE_MS = 200;
    const STATUS_RECHECK_MS = 5 * 1000;
    const DRAG_SLOP = 4; // px before a press on the panel's head becomes a drag

    let settings = core.normalizeSettings(null);
    let observer = null;
    let started = false;
    let stopped = false;
    let lastUrl = location.href;
    let scanTimer = null;
    let lastScanMs = 0;
    let retryTimer = null;
    let resizeTimer = null;
    let statusTimer = null;

    const entries = new Map(); // card element -> { card, key, node, mark, sig, anchors, photo }
    const records = new Map(); // product key -> { result, own, askedWithId }
    const attempts = new Map(); // product key -> { count, nextAt }
    let pageItems = new Map(); // product key -> lookup item, what this page needs now

    let flushing = false;
    let flushAgain = false;
    let reaskAll = false;
    let lastAskAt = 0;
    let lastStatus = null;

    const counters = { messages: 0, itemsAsked: 0, links: 0, ignored: 0, scans: 0 };

    // ─── the seam: everything that touches the extension goes through here ────

    function alive() {
        const stub = window.__paShopStub;
        if (stub) return stub.dead !== true;
        try {
            return Boolean(globalThis.chrome?.runtime?.id);
        } catch {
            return false;
        }
    }

    /** The answer, or null when there is none. Never rejects. */
    async function send(message) {
        const stub = window.__paShopStub;
        try {
            if (stub) return (await stub.send(message)) ?? null;
            if (!alive()) return null;
            return (await chrome.runtime.sendMessage(message)) ?? null;
        } catch (err) {
            if (alive()) console.warn('[shop-marks] send', err);
            return null;
        }
    }

    async function getSettings() {
        const stub = window.__paShopStub;
        if (stub) return core.normalizeSettings(stub.settings);
        if (!alive()) return core.normalizeSettings(null);
        try {
            const got = await chrome.storage.local.get(core.SETTINGS_KEY);
            return core.normalizeSettings(got[core.SETTINGS_KEY]);
        } catch {
            return core.normalizeSettings(null);
        }
    }

    /**
     * Read and merge: the popup, the options page and other tabs write the same key. `patch` is
     * an object, or a function of what is saved now, for a nested field such as panelPositions.
     */
    async function saveSettings(patch) {
        const merge = (saved) => core.normalizeSettings({ ...saved, ...(typeof patch === 'function' ? patch(core.normalizeSettings(saved)) : patch) });
        const stub = window.__paShopStub;
        if (stub) {
            stub.settings = merge(stub.settings);
            return;
        }
        if (!alive()) return;
        try {
            const got = await chrome.storage.local.get(core.SETTINGS_KEY);
            await chrome.storage.local.set({ [core.SETTINGS_KEY]: merge(got[core.SETTINGS_KEY]) });
        } catch (err) {
            console.warn('[shop-marks] saveSettings', err);
            return;
        }
        // Other open tabs find out from the SW, same as when the popup saves.
        await send({ type: 'shop-settings-changed' });
    }

    /** Marks on this store: on overall and not turned off for this store in the options. */
    const isOn = () => core.isStoreOn(settings, store.key);

    // ─── small DOM helpers ────────────────────────────────────────────────────

    /** Children that are strings become text nodes: store and server data never reach innerHTML. */
    function h(tag, className, ...children) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        for (const child of children) {
            if (child === null || child === undefined || child === false || child === '') continue;
            el.append(child);
        }
        return el;
    }

    /**
     * Stores keep chat bubbles at the top of the z-index range: at CoolStuffInc one sat over
     * the panel's button and took the click. The top layer is above any z-index.
     */
    function appendOnTop(node) {
        node.setAttribute('popover', 'manual');
        document.body.append(node);
        try {
            node.showPopover();
        } catch (err) {
            console.warn('[shop-marks] top layer', err);
        }
    }

    // Line icons. The CSS leaves SVG out of its reset (it would wipe `d`), and styles them itself.
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        grip: 'M9 5.5h.01M15 5.5h.01M9 12h.01M15 12h.01M9 18.5h.01M15 18.5h.01',
        close: 'M6 6l12 12M18 6L6 18',
        fold: 'M5 12h14',
        unfold: 'M12 5v14M5 12h14',
        options: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
        external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    };

    function icon(name, className = '') {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('class', `pa-shop-ico${className ? ` ${className}` : ''}`);
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.append(path);
        return svg;
    }

    const isOwnNode = (node) => node?.nodeType === 1 && Boolean(node.closest?.(`.${ROOT}`));
    const rectOf = (el) => el.getBoundingClientRect();
    const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

    function safeHref(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
        } catch {
            return null;
        }
    }

    // ─── finding the cards ────────────────────────────────────────────────────

    const isPageWrapper = (el) =>
        el === document.body ||
        el === document.documentElement ||
        el.matches(MAIN_SELECTOR) ||
        Boolean(el.querySelector(MAIN_SELECTOR));

    function isInPageChrome(link, memo) {
        let match = link.closest(IGNORE_SELECTOR);
        while (match) {
            let wrapper = memo.get(match);
            if (wrapper === undefined) {
                wrapper = isPageWrapper(match);
                memo.set(match, wrapper);
            }
            if (!wrapper) return true;
            match = match.parentElement?.closest(IGNORE_SELECTOR) || null;
        }
        return false;
    }

    /**
     * Product links of this store outside the page chrome, with their canonical key. Links to
     * the page we are on stay: they are the neighbour that stops the walk of the card next to
     * them. findCards leaves their own card out.
     */
    function collectLinks() {
        const memo = new Map();
        const links = [];
        let ignored = 0;
        for (const link of document.querySelectorAll(store.linkSelector)) {
            if (isOwnNode(link)) continue;
            const key = core.productKeyFromHref(store, link.href);
            if (!key) continue;
            if (isInPageChrome(link, memo)) {
                ignored += 1;
                continue;
            }
            links.push({ link, key });
        }
        counters.links = links.length;
        counters.ignored = ignored;
        return links;
    }

    function looksLikePage(el) {
        if (el === document.body || el === document.documentElement || el.tagName === 'MAIN') return true;
        if (el.querySelector(MAIN_SELECTOR)) return true;
        const rect = rectOf(el);
        return rect.width > PAGE_SIZE_LIMIT && rect.height > PAGE_SIZE_LIMIT;
    }

    /**
     * The buying form of a product page. Only that one: grid cards carry their own quick-add
     * form (all 16 cards of a BinderPOS collection page do), and a card with one is still a card.
     */
    function pageCartForm(pageKey) {
        if (!pageKey) return null;
        const memo = new Map();
        for (const form of document.querySelectorAll(CART_FORM_SELECTOR)) {
            if (!isInPageChrome(form, memo)) return form;
        }
        return null;
    }

    /** No card is this big: the page, the product's own buying area, a whole section of the theme. */
    function isTooBig(el, cartForm) {
        if (looksLikePage(el) || el.querySelector('h1')) return true;
        if (cartForm && el.contains(cartForm)) return true;
        if (el.matches('.shopify-section') || el.querySelector('.shopify-section')) return true;
        return Boolean(el.matches('section') || el.querySelector('section')) && el.querySelectorAll('img').length > 1;
    }

    /**
     * With no neighbour to stop at: take the link and its photo. null when the photo in reach
     * is the one of a too big node: that is the page's product, and a "Next product" text link
     * has no photo of its own to put a mark on.
     */
    function smallestCardWithPhoto(link, cartForm) {
        let el = link;
        for (let depth = 0; depth < 6 && el && el !== document.body; depth += 1) {
            if (el !== link && isTooBig(el, cartForm)) return null;
            if (el.querySelector('img')) return el;
            el = el.parentElement;
        }
        const parent = link.parentElement;
        return parent && parent !== document.body ? parent : link;
    }

    /** `li > div.card > ...` gives `div.card`, so the outline hugs what the eye sees as the card. */
    function tighten(card) {
        let el = card;
        for (;;) {
            const kids = [...el.children].filter((kid) => !kid.classList.contains(ROOT));
            if (kids.length !== 1 || TIGHTEN_STOP.has(kids[0].tagName)) return el;
            // CoolStuffInc: a wrapper of height 0, because its columns are floats. That is not the card.
            const outer = rectOf(el);
            const inner = rectOf(kids[0]);
            if (inner.height < outer.height * 0.6 || inner.width < outer.width * 0.6) return el;
            el = kids[0];
        }
    }

    /** The walk itself lives in the core (pure and tested); what is a page and what hugs the card is the DOM's. */
    function findCards(links) {
        const pageKey = core.productKeyFromHref(store, location.href);
        const cartForm = pageCartForm(pageKey);
        const cards = new Map();
        for (const { link, key, top } of core.climbToCards(links, (el) => el.parentElement)) {
            // The current product is the fixed panel's business.
            if (key === pageKey) continue;
            const fit = isTooBig(top, cartForm) ? smallestCardWithPhoto(link, cartForm) : top;
            if (!fit) continue;
            const card = tighten(fit);
            const group = cards.get(card);
            if (group) group.links.push(link);
            else cards.set(card, { key, links: [link] });
        }
        return cards;
    }

    // ─── what to ask about a card ─────────────────────────────────────────────

    function numericAttr(el, name) {
        const value = Number(el?.getAttribute(name));
        return value > 0 ? value : null;
    }

    function titleOfCard(card, link) {
        const candidates = [];
        for (const img of card.querySelectorAll('img')) candidates.push(img.getAttribute('alt'));
        // Smoke & Mirrors leaves alt empty and keeps the title in the figure.
        candidates.push(card.querySelector('figure [class*=visually-hidden]')?.textContent);
        candidates.push(card.querySelector('h1, h2, h3, h4, h5, h6, [class*=title]')?.textContent);
        candidates.push(link.getAttribute('title'));
        candidates.push(link.textContent);
        const clean = candidates.map(cleanText).filter(Boolean);
        return clean.find((text) => BINDER_TITLE.test(text)) || clean[0] || null;
    }

    function itemForCard(card, key, links) {
        const link = links[0];
        const item = {
            key,
            store: store.key,
            url: link.href,
            productId:
                core.productIdFromHref(store, link.href) ||
                numericAttr(card.querySelector('.catalogMetaData[data-tcgid]'), 'data-tcgid'),
            title: titleOfCard(card, link),
        };
        if (store.kind === 'csi') {
            const crumbs = cleanText(card.querySelector('.breadcrumb-trail')?.textContent);
            if (crumbs) item.setName = crumbs;
        }
        return item;
    }

    function itemForPage() {
        const key = core.productKeyFromHref(store, location.href);
        if (!key) return null;
        const item = {
            key,
            store: store.key,
            url: `${location.origin}${location.pathname}`,
            productId:
                core.productIdFromHref(store, location.href) ||
                numericAttr(document.querySelector('.catalogMetaData[data-tcgid]'), 'data-tcgid'),
            title:
                cleanText(document.querySelector('h1')?.textContent) ||
                cleanText(document.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
                null,
        };
        if (store.kind === 'csi') {
            // Here the set is the link of the offers' row: .breadcrumb-trail belongs to other products.
            const set = cleanText(document.querySelector('a.ItemSet')?.textContent);
            if (set) item.setName = set;
        }
        return item;
    }

    function addItem(items, item) {
        const known = items.get(item.key);
        if (!known || (!known.productId && item.productId)) items.set(item.key, item);
    }

    // ─── painting a mark ──────────────────────────────────────────────────────

    const soldCount = (mark) => mark.sold.total || mark.sold.d180 || mark.sold.d90 || 0;

    function marketText(mark) {
        const value = mark.market?.value;
        if (value === null || value === undefined) return null;
        return `Mkt ${mark.market.flimsy ? '~' : ''}${core.formatUsd(value)}`;
    }

    function diffText(mark) {
        // An offer gone from the store is not a discount anyone can take, and an old price
        // against today's market is not a discount at all.
        if (!mark.here || !mark.here.active || mark.here.stale || mark.here.diffPct === null) return null;
        return core.formatPct(mark.here.diffPct);
    }

    /**
     * The state a mark looks like. The other printing is on the shelf and the one on sale
     * here sells: `state` stays `have`, and it has to look like what it asks for.
     */
    const paintedState = (mark) => (mark.reorderNote ? 'reorder' : mark.state);

    /** "Tenés 3" + "web US$ 12,90" / "Mkt US$ 11,40 · -8 % · vendió 5". Wraps when the photo is narrow. */
    function stripLines(mark) {
        const second = [mark.reorderNote ? 'Reponer' : null, marketText(mark), diffText(mark)];
        if (soldCount(mark)) second.push(`vendió ${soldCount(mark)}`);
        return {
            // The wishlist count and "vendiste" go to the details: here they only push the price off the line.
            label: `${mark.doubtful ? '¿Es esta? ' : ''}${String(mark.title).split(' · ')[0]}`,
            web: mark.price ? `web ${core.formatUsd(mark.price)}` : null,
            second: second.filter(Boolean),
        };
    }

    /**
     * Copies of the other printing only. The big thing is the 0 of the printing on sale here:
     * "Tenés 1 normal, 0 rev" gives "Tenés 1 normal" and "0 rev", "0 normal, 2 ES rev" gives
     * "2 ES rev" and "0 normal". From the title, which already spells out language and vault.
     */
    function otherPrintingSides(title) {
        const text = String(title);
        const tenes = text.startsWith('Tenés ') ? 'Tenés ' : '';
        const sides = text.slice(tenes.length).split(', ');
        const zero = sides.find((side) => side.startsWith('0 ')) ?? sides[sides.length - 1];
        return { word: `${tenes}${sides.find((side) => side !== zero) ?? ''}`, zero };
    }

    /**
     * The stamp of variants a and c: a small word that says what the big thing is.
     * Reads top to bottom: "Tenés / 3", "Vendiste 9 / Reponer", "Sin mapear / ?".
     */
    function stampParts(mark) {
        const sold = soldCount(mark);
        if (mark.otherPrintingOnly) {
            const { word, zero } = otherPrintingSides(mark.title);
            return { word, big: mark.reorderNote ? 'Reponer' : zero };
        }
        switch (mark.state) {
            case 'have':
                if (mark.counts.normal + mark.counts.reverse <= mark.vault) return { word: 'En el vault', big: String(mark.vault) };
                return { word: 'Tenés', big: mark.badge };
            case 'wanted':
                return { word: mark.wishlist ? `Wishlist ${mark.wishlist}` : null, big: 'Falta', sold };
            case 'reorder':
                return { word: sold ? `Vendiste ${sold}` : null, big: 'Reponer', sold };
            case 'unmapped':
                return { word: mark.title === 'Set sin mapear' ? 'Sin mapear' : 'No figura', big: '?' };
            case 'loading':
                return { word: 'Cargando', big: '...' };
            default:
                return { word: mark.title === 'No la tenés' ? 'Tenés' : 'En stock', big: mark.badge };
        }
    }

    /**
     * What the dimming means is "you can skip this one". Copies in another language (the
     * title then does not start with "Tenés") or only in the vault are not that: the
     * English card on the shelf may still be worth buying. Neither are copies of the other
     * printing only, whose title does start with "Tenés".
     */
    const isPlainlyOwned = (mark) => mark.state === 'have' && !mark.doubtful && !mark.otherPrintingOnly && /^Tenés/.test(mark.title || '');

    function buildNode(mark, variant) {
        const state = paintedState(mark);
        let node;
        if (variant === 'b') {
            const lines = stripLines(mark);
            node = h(
                'span',
                `${ROOT} pa-shop-strip`,
                h('span', 'pa-shop-strip-first', h('span', 'pa-shop-strip-label', lines.label), lines.web ? h('span', 'pa-shop-strip-web', lines.web) : null),
                lines.second.length ? h('span', 'pa-shop-strip-second', ...lines.second.map((text) => h('span', 'pa-shop-strip-fact', text))) : null,
            );
        } else {
            const parts = stampParts(mark);
            const decision = variant === 'c' && (state === 'wanted' || state === 'reorder');
            // In c the verdict carries the sales, and everything else stays small.
            // A doubt says so first: a verdict about what may be another card cannot look like a fact.
            const word = mark.doubtful ? '¿Es esta?' : decision && parts.sold ? `vendió ${parts.sold}` : parts.word;
            const shortBig = String(parts.big).length <= 4;
            node = h(
                'span',
                `${ROOT} pa-shop-mark${decision ? ' pa-shop-mark-big' : ''}${shortBig ? ' pa-shop-mark-num' : ''}`,
                word ? h('span', 'pa-shop-word', word) : null,
                h('span', 'pa-shop-badge', decision ? String(parts.big).toUpperCase() : parts.big),
            );
        }
        node.setAttribute('data-pa-shop-state', state);
        if (mark.doubtful) node.setAttribute('data-pa-shop-doubtful', '1');
        if (mark.otherPrintingOnly) node.setAttribute('data-pa-shop-other', '1');
        node.setAttribute('role', 'button');
        node.setAttribute('aria-label', mark.doubtful ? `${mark.doubtfulNote} ${mark.title}` : mark.title);
        return node;
    }

    function locatePhoto(card) {
        let first = null;
        for (const img of card.querySelectorAll('img')) {
            if (isOwnNode(img)) continue;
            if (!first) first = img;
            if (rectOf(img).width >= PHOTO_MIN_WIDTH) return img;
        }
        return first;
    }

    /** The box to position against: the photo's parent, past <picture> and inline wrappers. */
    function anchorOfPhoto(card, photo) {
        if (!photo) return card;
        let el = photo.parentElement;
        while (el && el !== card) {
            const display = getComputedStyle(el).display;
            if (el.tagName !== 'PICTURE' && display !== 'inline' && display !== 'contents') return el;
            el = el.parentElement;
        }
        return card;
    }

    /**
     * `position: relative` on a static box captures any absolute child that positions against
     * something further out: a stretched link shrinks, a SOLD OUT badge moves. Such a box is left
     * alone and the mark uses that further box, which is already positioned. Hidden 1px text
     * (.visually-hidden) does not count: capturing it changes nothing.
     */
    function safeAnchor(el) {
        if (getComputedStyle(el).position !== 'static') return el;
        for (const child of el.querySelectorAll('*')) {
            if (child.classList.contains(ROOT) || getComputedStyle(child).position !== 'absolute') continue;
            if (child.offsetWidth <= 1 || child.offsetHeight <= 1) continue;
            const outer = child.offsetParent;
            // The page itself is not a box a mark can pin, and it would capture everything else.
            if (outer && !el.contains(outer) && outer !== document.body && outer !== document.documentElement) return outer;
        }
        return el;
    }

    /**
     * `isolation` keeps the mark's z-index inside this box: it has to beat the photo, not
     * the store's sticky header. Only a static box gets `position`, see safeAnchor.
     */
    function pinAsAnchor(entry, el) {
        if (el.hasAttribute('data-pa-shop-anchor')) return; // the frame and the mark can share a box
        el.setAttribute('data-pa-shop-anchor', getComputedStyle(el).position === 'static' ? 'pin' : 'iso');
        entry.anchors.push(el);
    }

    function setImportant(node, prop, px) {
        node.style.setProperty(prop, `${Math.round(px)}px`, 'important');
    }

    /** The photo can sit inside a larger box, centered or with text under it. */
    function alignToPhoto(entry) {
        const { node, photo, anchorEl } = entry;
        if (!node || !photo || !anchorEl || !node.isConnected) return;
        const box = rectOf(anchorEl);
        const pic = rectOf(photo);
        if (pic.width < PHOTO_MIN_WIDTH || pic.height < PHOTO_MIN_WIDTH) return; // not loaded yet
        if (node.classList.contains('pa-shop-strip')) {
            // A box that holds only the photo lends its width: more room for the text and
            // nothing of the store underneath. Otherwise, the width of the photo.
            const wide = entry.photoOnlyBox;
            setImportant(node, 'left', wide ? 0 : Math.max(0, pic.left - box.left));
            setImportant(node, 'width', wide ? box.width : pic.width);
            setImportant(node, 'bottom', Math.max(0, box.bottom - pic.bottom));
            return;
        }
        setImportant(node, 'left', Math.max(0, pic.left - box.left) + STAMP_INSET);
        setImportant(node, 'top', Math.max(0, pic.top - box.top) + STAMP_INSET);
    }

    // A lazy image changes size, or swaps its placeholder, long after the mark went in.
    const realign = new ResizeObserver((observed) => {
        for (const { target } of observed) {
            const entry = watchedBoxes.get(target);
            if (entry) alignToPhoto(entry);
        }
    });
    const watchedBoxes = new Map(); // photo or anchor box -> entry

    function watchBox(entry, el) {
        if (!el) return;
        watchedBoxes.set(el, entry);
        realign.observe(el);
    }

    function unwatchBoxes(entry) {
        for (const el of [entry.photo, entry.anchorEl]) {
            if (!el || watchedBoxes.get(el) !== entry) continue;
            watchedBoxes.delete(el);
            realign.unobserve(el);
        }
    }

    /** innerText, because textContent also reads the markup inside <noscript>. */
    const holdsOnlyThePhoto = (box) => !cleanText(box.innerText);

    /** The widest box around the photo with no text of the store: what a strip can cover. */
    function widenToPhotoBox(card, box) {
        let el = box;
        while (el !== card && el.parentElement && el.parentElement !== card && holdsOnlyThePhoto(el.parentElement)) {
            el = el.parentElement;
        }
        return el;
    }

    /** Variant c: the frame is a node of ours, because a store's own layers cover an outline. */
    function mountFrame(entry, mark) {
        if (settings.variant !== 'c') return;
        const state = paintedState(mark);
        const wanted = state === 'wanted' || state === 'reorder' || mark.doubtful;
        if (!wanted) return;
        // It fills its parent, so it needs the card itself pinned. If that is not safe, the mark says it alone.
        if (safeAnchor(entry.card) !== entry.card) return;
        const frame = h('span', `${ROOT} pa-shop-frame`);
        frame.setAttribute('data-pa-shop-state', state);
        if (mark.doubtful) frame.setAttribute('data-pa-shop-doubtful', '1');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.setProperty('border-radius', getComputedStyle(entry.card).borderRadius, 'important');
        pinAsAnchor(entry, entry.card);
        entry.card.append(frame);
        entry.frame = frame;
    }

    function mountNode(entry, node, mark) {
        entry.photo = locatePhoto(entry.card);
        entry.anchorEl = anchorOfPhoto(entry.card, entry.photo);
        if (settings.variant === 'b') entry.anchorEl = widenToPhotoBox(entry.card, entry.anchorEl);
        entry.anchorEl = safeAnchor(entry.anchorEl);
        entry.photoOnlyBox = holdsOnlyThePhoto(entry.anchorEl);
        pinAsAnchor(entry, entry.anchorEl);
        entry.anchorEl.append(node);
        mountFrame(entry, mark);
        alignToPhoto(entry);
        watchBox(entry, entry.photo);
        watchBox(entry, entry.anchorEl);
    }

    function clearCard(entry) {
        if (details.entry === entry) closeDetails();
        unwatchBoxes(entry);
        entry.node?.remove();
        entry.node = null;
        entry.frame?.remove();
        entry.frame = null;
        entry.photo = null;
        entry.anchorEl = null;
        for (const el of entry.anchors) el.removeAttribute('data-pa-shop-anchor');
        entry.anchors = [];
        entry.card.removeAttribute('data-pa-shop-card');
        entry.card.removeAttribute('data-pa-shop-owned');
        // A theme that clones cards (carousels do) clones our mark too, without its listeners.
        for (const stray of entry.card.querySelectorAll(`.${ROOT}`)) stray.remove();
    }

    function paintEntry(entry) {
        const record = records.get(entry.key);
        const mark = core.deriveMark(record?.result ?? null, record?.own ?? null);
        const sig = `${settings.variant}|${JSON.stringify(mark)}`;
        // In its anchor, which safeAnchor can have taken out of the card.
        const intact = mark.state === 'unknown' ? !entry.node : Boolean(entry.node?.isConnected) && Boolean(entry.anchorEl?.contains(entry.node));
        if (entry.sig === sig && intact) return;

        clearCard(entry);
        entry.sig = sig;
        entry.mark = mark;
        if (mark.state === 'unknown') return; // nothing is painted, on purpose

        entry.card.setAttribute('data-pa-shop-card', mark.doubtful ? 'doubtful' : mark.state);
        if (isPlainlyOwned(mark)) entry.card.setAttribute('data-pa-shop-owned', '1');

        const node = buildNode(mark, settings.variant);
        wireMark(node, entry);
        entry.node = node;
        mountNode(entry, node, mark);
    }

    // ─── details: the shared popover and the body it shares with the panel ────
    //
    // Reads top to bottom the way a decision goes: the verdict (head), which card it is, the
    // price here against the market, what the card does in our store, and the fine print.

    const TREND_WORD = { cae: 'sigue bajando', freno: 'frenó', rebota: 'rebotando' };
    // Built from its code: an escape typed in the source arrives as the invisible character itself.
    const NBSP = String.fromCharCode(0xa0);

    const sub = (text, modifier) => (text ? h('div', `pa-shop-sub${modifier ? ` pa-shop-${modifier}` : ''}`, text) : null);

    function chip(text, tone) {
        const node = h('span', 'pa-shop-chip', text);
        node.setAttribute('data-pa-shop-tone', tone);
        return node;
    }

    function externalLink(text, href, className = 'pa-shop-link') {
        const link = h('a', className, h('span', 'pa-shop-link-text', text), icon('external', 'pa-shop-ico-sm'));
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
    }

    /** "Falta" big and "2 en wishlist" beside it: the title split at its first " · ". */
    function verdictParts(mark) {
        const [first, ...rest] = String(mark.title || '').split(' · ');
        return { big: first, small: rest.join(' · ') };
    }

    /** The colored band on top. The panel adds its grip and buttons; the popover has neither. */
    function buildHead(mark, { grip = null, buttons = [] } = {}) {
        const { big, small } = verdictParts(mark);
        const verdict = h('div', 'pa-shop-verdict', h('span', 'pa-shop-verdict-big', big), small ? h('span', 'pa-shop-verdict-small', small) : null);
        const head = h('div', 'pa-shop-head', grip, verdict, buttons.length ? h('div', 'pa-shop-head-buttons', ...buttons) : null);
        head.setAttribute('data-pa-shop-state', paintedState(mark));
        if (mark.doubtful) head.setAttribute('data-pa-shop-doubtful', '1');
        if (mark.otherPrintingOnly) head.setAttribute('data-pa-shop-other', '1');
        return head;
    }

    /** Photo, name and number: to see at a glance that it is the card on the screen. */
    function identityRow(mark) {
        const card = mark.card || {};
        const id = [card.number, card.setName, card.rarity].filter(Boolean).join(' · ');
        const src = safeHref(card.imageUrl);
        let thumb = null;
        if (src) {
            thumb = h('img', 'pa-shop-thumb');
            thumb.alt = '';
            thumb.decoding = 'async';
            // A store's CSP can refuse the CDN: no photo then, rather than a broken one.
            thumb.addEventListener('error', () => thumb.remove(), { once: true });
            thumb.src = src;
        }
        return h('div', 'pa-shop-identity', thumb, h('div', 'pa-shop-identity-text', h('div', 'pa-shop-card-name', card.name), id ? h('div', 'pa-shop-card-id', id) : null));
    }

    /** The store's price, with what it means against the market. */
    function hereColumn(here) {
        const days = here.ageDays;
        const label = here.stale ? (typeof days === 'number' ? `Acá, hace ${days} ${days === 1 ? 'día' : 'días'}` : 'Acá, precio viejo') : 'Precio acá';
        const col = h('div', 'pa-shop-col', h('div', `pa-shop-col-label${here.stale ? ' pa-shop-warn' : ''}`, label), h('div', 'pa-shop-big', core.formatUsd(here.priceUsd)));
        // An offer gone from the store is not a discount anyone can take, and an old price
        // against today's market is not a discount at all.
        const live = here.active && !here.stale;
        const chips = [];
        if (live && here.diffPct !== null) chips.push(chip(`${core.formatPct(here.diffPct)} contra market`, here.diffPct <= 0 ? 'good' : 'bad'));
        if (live && here.belowLow) chips.push(chip('Debajo del low', 'good'));
        if (chips.length) col.append(h('div', 'pa-shop-chips', ...chips));
        if (here.landedUsd !== null && here.landedUsd !== here.priceUsd) col.append(sub(`Puesta en Miami ${core.formatUsd(here.landedUsd)}`));
        const facts = [here.printing, here.condition].filter(Boolean).join(' · ');
        if (facts) col.append(sub(facts));
        // Only CoolStuffInc publishes quantities: no number means it does not say, not zero.
        col.append(sub(here.stock === null ? 'No publica stock' : `Stock ${here.stock}`));
        const seen = here.seenAt ? core.formatDate(here.seenAt) : '';
        if (!here.active) col.append(sub(`No estaba disponible${seen ? ` el ${seen}` : ''}`, 'warn'));
        else if (seen && !here.stale) col.append(sub(`Visto el ${seen}`));
        return col;
    }

    function marketColumn(market, here) {
        const col = h('div', 'pa-shop-col', h('div', 'pa-shop-col-label', 'Market TCGplayer'), h('div', 'pa-shop-big', core.formatUsd(market.value)));
        // One line each: together they break in half in a column at prices over US$ 10.
        if (market.low !== null) col.append(sub(`Low ${core.formatUsd(market.low)}`));
        if (market.mid !== null) col.append(sub(`Mid ${core.formatUsd(market.mid)}`));
        // The printing already reads under the price here when it is the same one.
        if (market.printing && market.printing !== here?.printing) col.append(sub(market.printing));
        if (market.flimsy) col.append(sub('Poco confiable: muy por arriba del mid', 'warn'));
        return col;
    }

    function compareBox(mark) {
        const here = mark.here && mark.here.priceUsd !== null ? mark.here : null;
        const market = mark.market && mark.market.value !== null ? mark.market : null;
        if (!here && !market) return null;
        const cols = [here ? hereColumn(here) : null, market ? marketColumn(market, here) : null].filter(Boolean);
        return h('div', `pa-shop-compare${cols.length === 1 ? ' pa-shop-compare-one' : ''}`, ...cols);
    }

    function tile(label, value, ...subs) {
        return h('div', 'pa-shop-tile', h('div', 'pa-shop-tile-label', label), h('div', 'pa-shop-tile-value', value), ...subs.filter(Boolean).map((text) => h('div', 'pa-shop-tile-sub', text)));
    }

    /** What the card does in our store. Web only: ML leaves no row in Sales. */
    function storeTiles(mark) {
        const tiles = [];
        if (mark.price) tiles.push(tile('Tu precio web', core.formatUsd(mark.price)));
        const { total, d90, d180, last } = mark.sold;
        if (total || d90 || d180) {
            const recent = d90 ? `${d90} en 90 días` : d180 ? `${d180} en 180 días` : null;
            tiles.push(tile('Vendidas', String(total || d180 || d90), recent, last ? `Última${NBSP}${core.formatDate(last)}` : null));
        }
        if (mark.wishlist) tiles.push(tile('En wishlist', String(mark.wishlist)));
        if (!tiles.length) return null;
        return h('div', 'pa-shop-section', h('div', 'pa-shop-section-label', 'En tu tienda'), h('div', 'pa-shop-tiles', ...tiles));
    }

    function note(content, tone) {
        if (!content) return null;
        const node = h('li', 'pa-shop-note', h('span', 'pa-shop-dot'), typeof content === 'string' ? h('span', 'pa-shop-note-text', content) : content);
        if (tone) node.setAttribute('data-pa-shop-tone', tone);
        return node;
    }

    function trendNote(trend) {
        if (!trend) return null;
        const drop = `Bajó ${Math.round(Number(trend.drop) * 100)} %`;
        const peak = trend.peak ? ` desde ${core.formatUsd(trend.peak)}` : '';
        const word = TREND_WORD[trend.state];
        return note(`${drop}${peak}${word ? `, ${word}` : ''}`);
    }

    function bestElsewhereNote(best, here) {
        if (!best) return null;
        // "Más barata" needs a price here to beat: one the store still offers, and not an old one.
        const cheaper = typeof here?.landedUsd === 'number' && here.active && !here.stale && best.landedUsd < here.landedUsd;
        const parts = [`${cheaper ? 'Más barata en' : 'También en'} ${best.storeLabel || best.store}: ${core.formatUsd(best.landedUsd)}`];
        if (best.diffPct !== null && best.diffPct !== undefined) parts.push(core.formatPct(best.diffPct));
        if (best.stock !== null && best.stock !== undefined) parts.push(`stock${NBSP}${best.stock}`);
        const text = parts.join(' · ').replace(/ %/g, `${NBSP}%`); // the % never alone on the next line
        const href = safeHref(best.url);
        return note(href ? externalLink(text, href, 'pa-shop-link pa-shop-note-text') : text, cheaper ? 'good' : null);
    }

    function metaNote(meta) {
        if (!meta) return null;
        const parts = [meta.name];
        if (typeof meta.share === 'number') parts.push(`${Math.round(meta.share * 100)} % de los mazos`);
        if (meta.copies) parts.push(`${meta.copies} ${meta.copies === 1 ? 'copia' : 'copias'}`);
        if (Array.isArray(meta.archetypes) && meta.archetypes.length) parts.push(meta.archetypes.slice(0, 3).join(', '));
        return note(`Meta: ${parts.filter(Boolean).join(' · ')}`);
    }

    /** The whole story of a card. Same content in the popover and in the product panel. */
    function buildBody(mark, record) {
        const card = mark.card || {};
        const body = h('div', 'pa-shop-body', identityRow(mark));
        if (mark.doubtful) body.append(h('div', 'pa-shop-doubt', mark.doubtfulNote));

        const compare = compareBox(mark);
        if (compare) body.append(compare);
        const tiles = storeTiles(mark);
        if (tiles) body.append(tiles);

        const notes = [
            note(core.missingPrintingText(mark.printingMissing), 'warn'),
            note(mark.reorderNote, 'warn'),
            mark.boughtAt ? note(`Ya la compraste el ${core.formatDate(mark.boughtAt)}`, 'warn') : null,
            note(mark.langNote),
            mark.conditionNote ? note(`Condición: ${mark.conditionNote}`) : null,
            note(mark.note),
            trendNote(mark.trend),
            bestElsewhereNote(mark.bestElsewhere, mark.here),
            metaNote(mark.meta),
            record?.result?.via === 'title' ? note('Identificada por el título, no por la URL') : null,
        ].filter(Boolean);
        if (notes.length) body.append(h('ul', 'pa-shop-notes', ...notes));

        const tcgplayer = store.kind === 'tcgplayer' ? null : safeHref(card.tcgplayerUrl);
        if (tcgplayer) body.append(h('div', 'pa-shop-foot', externalLink('Ver en TCGplayer', tcgplayer)));
        return body;
    }

    /** The folded panel: the price here against the market, in one line. */
    function summaryLine(mark) {
        const parts = [];
        const here = mark.here;
        if (here && here.priceUsd !== null) {
            parts.push(h('span', 'pa-shop-summary-item', h('span', 'pa-shop-summary-label', 'Acá'), h('span', 'pa-shop-summary-value', core.formatUsd(here.priceUsd))));
            const pct = diffText(mark);
            if (pct) parts.push(chip(pct, here.diffPct <= 0 ? 'good' : 'bad'));
        }
        const market = mark.market?.value;
        if (market !== null && market !== undefined) {
            parts.push(h('span', 'pa-shop-summary-item', h('span', 'pa-shop-summary-label', 'Market'), h('span', 'pa-shop-summary-value', `${mark.market.flimsy ? '~' : ''}${core.formatUsd(market)}`)));
        }
        return parts.length ? h('div', 'pa-shop-summary', ...parts) : null;
    }

    const details = { node: null, entry: null, source: null, pinned: false, openTimer: null, closeTimer: null };

    function cancelDetailsTimers() {
        clearTimeout(details.openTimer);
        clearTimeout(details.closeTimer);
        details.openTimer = null;
        details.closeTimer = null;
    }

    function closeDetails() {
        cancelDetailsTimers();
        details.node?.remove();
        details.node = null;
        details.entry = null;
        details.source = null;
        details.pinned = false;
    }

    function positionDetails() {
        const { node, source } = details;
        if (!node || !source) return;
        const gap = 8;
        const from = rectOf(source);
        const size = rectOf(node);
        const maxLeft = Math.max(gap, window.innerWidth - size.width - gap);
        const maxTop = Math.max(gap, window.innerHeight - size.height - gap);

        let left = from.right + gap;
        let top = Math.min(Math.max(gap, from.top), maxTop);
        if (left > maxLeft) left = from.left - size.width - gap;
        if (left < gap) {
            left = Math.min(Math.max(gap, from.left), maxLeft);
            top = from.bottom + gap;
            if (top > maxTop) top = Math.max(gap, from.top - size.height - gap);
        }
        setImportant(node, 'left', left);
        setImportant(node, 'top', top);
    }

    function openDetails(entry, source, pinned) {
        cancelDetailsTimers();
        details.node?.remove();
        const node = h('div', `${ROOT} pa-shop-card pa-shop-details`, buildHead(entry.mark), buildBody(entry.mark, records.get(entry.key)));
        node.setAttribute('role', 'dialog');
        node.addEventListener('mouseenter', cancelDetailsTimers);
        node.addEventListener('mouseleave', scheduleDetailsClose);
        details.node = node;
        details.entry = entry;
        details.source = source;
        details.pinned = pinned;
        appendOnTop(node);
        positionDetails();
    }

    function scheduleDetailsClose() {
        if (details.pinned) return;
        clearTimeout(details.closeTimer);
        details.closeTimer = setTimeout(closeDetails, HOVER_CLOSE_MS);
    }

    /** Listeners live on the mark itself: only a click that lands on it gets stopped. */
    function wireMark(node, entry) {
        const stop = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        node.addEventListener('click', (event) => {
            stop(event);
            if (details.entry === entry && details.pinned) closeDetails();
            else openDetails(entry, node, true);
        });
        node.addEventListener('auxclick', stop);
        for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
            node.addEventListener(type, (event) => event.stopPropagation());
        }
        node.addEventListener('mouseenter', () => {
            cancelDetailsTimers();
            if (details.entry === entry) return;
            if (details.pinned) return;
            details.openTimer = setTimeout(() => openDetails(entry, node, false), HOVER_OPEN_MS);
        });
        node.addEventListener('mouseleave', () => {
            clearTimeout(details.openTimer);
            details.openTimer = null;
            if (details.entry === entry) scheduleDetailsClose();
        });
    }

    function onDocumentClick(event) {
        if (!details.node) return;
        if (details.node.contains(event.target) || details.source?.contains(event.target)) return;
        closeDetails(); // the click goes on to wherever it was going
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && details.node) closeDetails();
    }

    /** Only a scroll that moves the mark: an auto-rotating carousel elsewhere must not close it. */
    function onAnyScroll(event) {
        if (details.node && event.target?.contains?.(details.source)) closeDetails();
    }

    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            positionDetails();
            placePanel();
            placePill();
            for (const entry of entries.values()) alignToPhoto(entry);
        }, SCAN_DELAY_MS);
    }

    // ─── the panel on a product page: it moves, folds and closes ──────────────
    //
    // Dragged by its head and dropped anywhere. Where it lands is saved per store, held from the
    // nearest side and end of the window (core.anchorFromRect), so it keeps its place when the
    // window changes size and grows away from that edge when it opens. Double click on the head
    // puts it back in the corner chosen in the options.

    // hiddenFor / shownFor: closed with the X, or opened with the shortcut, for this product only.
    const panel = { node: null, sig: null, pending: false, notice: null, hiddenFor: null, shownFor: null };
    let drag = null; // { id, handle, dx, dy, x0, y0, moved }
    // A thumbnail that loads late makes it taller: it has to stay inside the window.
    const panelSize = new ResizeObserver(() => placePanel());

    const clampTo = (n, min, max) => Math.min(Math.max(n, min), Math.max(min, max));

    /** The window without its scrollbars, which is what `position: fixed` measures from. */
    function viewport() {
        const el = document.documentElement;
        const width = el.clientWidth > 0 && el.clientWidth <= window.innerWidth ? el.clientWidth : window.innerWidth;
        const height = el.clientHeight > 0 && el.clientHeight <= window.innerHeight ? el.clientHeight : window.innerHeight;
        return { width, height };
    }

    function setBox(node, left, top) {
        setImportant(node, 'left', left);
        setImportant(node, 'top', top);
        node.style.setProperty('right', 'auto', 'important');
        node.style.setProperty('bottom', 'auto', 'important');
    }

    /** Where this store keeps the panel: where it was dropped, else the corner of the options. */
    function placeAtAnchor(node) {
        if (!node?.isConnected) return;
        const box = rectOf(node);
        const { left, top } = core.placeFromAnchor(core.panelAnchor(settings, store.key), { width: box.width, height: box.height }, viewport());
        setBox(node, left, top);
    }

    function placePanel() {
        if (!drag) placeAtAnchor(panel.node);
    }

    function removePanel() {
        panelSize.disconnect();
        panel.node?.remove();
        panel.node = null;
        panel.sig = null;
        panel.notice = null;
        // Taken away mid-drag (the marks turned off, say): a drag left behind would hold every
        // later syncPanel as pending, and the panel would never come back.
        drag = null;
        panel.pending = false;
    }

    const productKeyNow = () => core.productKeyFromHref(store, location.href);

    function panelWanted(key) {
        if (!key || !isOn()) return false;
        if (panel.hiddenFor === key) return false;
        if (panel.shownFor === key) return true;
        return settings.panelEnabled;
    }

    function iconButton(name, label, onClick) {
        const button = h('button', 'pa-shop-icon-button', icon(name));
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        // A press on a button is not the start of a drag.
        button.addEventListener('pointerdown', (event) => event.stopPropagation());
        return button;
    }

    function setCollapsed(collapsed) {
        settings = { ...settings, panelCollapsed: collapsed };
        saveSettings({ panelCollapsed: collapsed });
        syncPanel();
    }

    function closePanel() {
        panel.hiddenFor = productKeyNow();
        panel.shownFor = null;
        syncOverlays();
    }

    /** The shortcut and the popup: closed or never shown opens it, open closes it. */
    function togglePanel() {
        const key = productKeyNow();
        if (!key || !isOn()) return;
        if (panel.node) {
            panel.hiddenFor = key;
            panel.shownFor = null;
        } else {
            panel.shownFor = key;
            panel.hiddenFor = null;
        }
        syncOverlays();
    }

    function noticeNode(notice) {
        if (!notice) return null;
        if (notice.kind === 'login') {
            const link = h('a', 'pa-shop-notice-link', 'Entrá al admin para ver tus datos');
            link.href = notice.href;
            link.target = '_blank';
            link.rel = 'noopener';
            return h('div', 'pa-shop-notice', link);
        }
        return h('div', 'pa-shop-notice pa-shop-warn', 'Tus datos tienen más de 2 días');
    }

    function syncPanel() {
        // A panel rebuilt under the pointer would drop the drag: it waits for the drop.
        if (drag) {
            panel.pending = true;
            return;
        }
        const key = productKeyNow();
        const record = panelWanted(key) ? records.get(key) : null;
        const mark = record ? core.deriveMark(record.result, record.own) : null;
        if (!mark || mark.state === 'unknown') {
            removePanel();
            return;
        }

        const collapsed = core.isPanelCollapsed(settings, window.innerWidth);
        const notice = wantedNotice();
        const sig = [key, collapsed, settings.panelSize, notice?.kind, notice?.href, JSON.stringify(mark)].join('|');
        if (panel.sig === sig && panel.node?.isConnected) {
            placePanel();
            return;
        }
        removePanel();

        const buttons = [
            iconButton('options', 'Opciones de la extensión', () => send({ type: 'shop-open-options' })),
            iconButton(collapsed ? 'unfold' : 'fold', collapsed ? 'Desplegar' : 'Plegar', () => setCollapsed(!collapsed)),
            iconButton('close', 'Cerrar en esta carta', closePanel),
        ];
        const head = buildHead(mark, { grip: h('span', 'pa-shop-grip', icon('grip')), buttons });
        head.title = 'Arrastrá para moverlo. Doble click lo vuelve a su esquina.';
        wireDrag(head);

        const inner = h('div', 'pa-shop-inner', head, noticeNode(notice), collapsed ? summaryLine(mark) : buildBody(mark, record));
        const node = h('div', `${ROOT} pa-shop-card pa-shop-panel`, inner);
        node.setAttribute('data-pa-shop-collapsed', collapsed ? '1' : '0');
        node.setAttribute('data-pa-shop-size', settings.panelSize);
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', mark.title || 'Carta');
        panel.node = node;
        panel.sig = sig;
        panel.notice = notice?.kind ?? null;
        appendOnTop(node);
        placePanel();
        panelSize.observe(node);
    }

    // ─── dragging ─────────────────────────────────────────────────────────────

    function wireDrag(handle) {
        handle.addEventListener('pointerdown', onDragStart);
        handle.addEventListener('pointermove', onDragMove);
        handle.addEventListener('pointerup', onDragEnd);
        handle.addEventListener('pointercancel', onDragEnd);
        handle.addEventListener('lostpointercapture', onDragEnd);
        handle.addEventListener('dblclick', onDragReset);
        // The store must not take a press on the panel for one of its own (carousels, drawers).
        for (const type of ['mousedown', 'mouseup', 'click']) handle.addEventListener(type, (event) => event.stopPropagation());
    }

    function onDragStart(event) {
        if (event.button !== 0 || !panel.node || drag) return;
        event.preventDefault();
        event.stopPropagation();
        const box = rectOf(panel.node);
        drag = { id: event.pointerId, handle: event.currentTarget, dx: event.clientX - box.left, dy: event.clientY - box.top, x0: event.clientX, y0: event.clientY, moved: false };
        try {
            drag.handle.setPointerCapture(event.pointerId);
        } catch {
            // a synthetic event has no pointer to capture: the drag still works while over the head
        }
    }

    function onDragMove(event) {
        if (!drag || event.pointerId !== drag.id || !panel.node) return;
        event.preventDefault();
        event.stopPropagation();
        if (!drag.moved && Math.abs(event.clientX - drag.x0) + Math.abs(event.clientY - drag.y0) < DRAG_SLOP) return;
        if (!drag.moved) panel.node.setAttribute('data-pa-shop-dragging', '1');
        drag.moved = true;
        const box = rectOf(panel.node);
        const view = viewport();
        const edge = core.PANEL_EDGE;
        setBox(
            panel.node,
            clampTo(event.clientX - drag.dx, edge, view.width - box.width - edge),
            clampTo(event.clientY - drag.dy, edge, view.height - box.height - edge),
        );
    }

    function onDragEnd(event) {
        if (!drag || event.pointerId !== drag.id) return;
        const { moved, handle } = drag;
        drag = null;
        try {
            if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        } catch {
            // already released
        }
        panel.node?.removeAttribute('data-pa-shop-dragging');
        if (moved && panel.node) {
            const anchor = core.anchorFromRect(rectOf(panel.node), viewport());
            settings = { ...settings, panelPositions: { ...settings.panelPositions, [store.key]: anchor } };
            // Merged into what is saved now: another tab may have moved it on another store.
            saveSettings((saved) => ({ panelPositions: { ...saved.panelPositions, [store.key]: anchor } }));
        }
        if (panel.pending) {
            panel.pending = false;
            syncPanel();
        } else {
            placePanel();
        }
        placePill();
    }

    function onDragReset(event) {
        if (event.target.closest?.('button, a')) return;
        event.preventDefault();
        event.stopPropagation();
        const positions = { ...settings.panelPositions };
        delete positions[store.key];
        settings = { ...settings, panelPositions: positions };
        saveSettings((saved) => {
            const next = { ...saved.panelPositions };
            delete next[store.key];
            return { panelPositions: next };
        });
        placePanel();
        placePill();
    }

    // ─── the notice: no session, or own data too old to trust ─────────────────
    //
    // Inside the panel when there is one. Otherwise a pill of its own, where the panel would be.

    let pill = null; // { node, kind: 'login' | 'old' }

    function wantedNotice() {
        if (!isOn() || !lastStatus) return null;
        const login = lastStatus.auth === false ? safeHref(lastStatus.loginUrl) : null;
        if (login) return { kind: 'login', href: login };
        return lastStatus.ownTooOld ? { kind: 'old' } : null;
    }

    function removePill() {
        pill?.node.remove();
        pill = null;
    }

    function placePill() {
        if (pill) placeAtAnchor(pill.node);
    }

    function syncPill() {
        const wanted = panel.node ? null : wantedNotice();
        if (pill && (pill.kind !== wanted?.kind || !pill.node.isConnected)) removePill();
        if (!wanted) return;
        if (!pill) {
            let node;
            if (wanted.kind === 'login') {
                node = h('a', `${ROOT} pa-shop-pill pa-shop-login`, 'Entrá al admin para ver tus datos');
                node.target = '_blank';
                node.rel = 'noopener';
            } else {
                node = h('div', `${ROOT} pa-shop-pill pa-shop-old-data`, 'Tus datos tienen más de 2 días');
            }
            pill = { node, kind: wanted.kind };
            appendOnTop(node);
        }
        if (wanted.href) pill.node.href = wanted.href;
        placePill();
    }

    // ─── the toolbar badge: how many cards on this page to buy ────────────────

    let lastBadge = null;

    const isToBuy = (mark) => Boolean(mark) && !mark.doubtful && (mark.state === 'wanted' || mark.state === 'reorder' || Boolean(mark.reorderNote));

    /** Cards on this page to buy: the grid's and the product's own, each product once. */
    function keysToBuy() {
        const keys = new Set();
        for (const entry of entries.values()) if (isToBuy(entry.mark)) keys.add(entry.key);
        const key = productKeyNow();
        const record = key ? records.get(key) : null;
        if (record && isToBuy(core.deriveMark(record.result, record.own))) keys.add(key);
        return keys;
    }

    /** Only when it changes: the SW paints it on this tab. */
    function reportBadge() {
        const on = isOn();
        const badge = core.badgeFor({ buy: on ? keysToBuy().size : 0, auth: lastStatus?.auth ?? null, on: on && settings.badge });
        const sig = `${badge.text}|${badge.kind}`;
        if (sig === lastBadge || stopped) return;
        lastBadge = sig;
        send({ type: 'shop-badge', text: badge.text, kind: badge.kind });
    }

    function syncOverlays() {
        syncPanel();
        syncPill();
        reportBadge();
    }

    /** For the popup: what this tab has, and whether the panel shows. */
    function tabStats() {
        const marks = [...entries.values()].map((entry) => entry.mark).filter((mark) => mark && mark.state !== 'unknown');
        const key = productKeyNow();
        return {
            store: store.key,
            storeLabel: store.label,
            on: isOn(),
            enabled: settings.enabled,
            cards: marks.length,
            have: marks.filter((mark) => mark.state === 'have' && !mark.otherPrintingOnly).length,
            buy: isOn() ? keysToBuy().size : 0,
            productPage: Boolean(key),
            productKnown: Boolean(key && records.get(key)?.result?.card),
            panelShown: Boolean(panel.node),
            auth: lastStatus?.auth ?? null,
        };
    }

    /**
     * An answer can come with a refresh still running behind it. If that refresh finds the
     * session gone there is no new snapshot and no shop:changed, so nothing else would say it.
     */
    function followRefresh() {
        if (statusTimer || stopped || !lastStatus?.refreshing) return;
        statusTimer = setTimeout(async () => {
            statusTimer = null;
            const answer = await send({ type: 'shop-status' });
            if (!answer?.status) return;
            lastStatus = answer.status;
            syncOverlays();
            followRefresh();
        }, STATUS_RECHECK_MS);
    }

    // ─── lookups: only what is not known yet, in batches, one message at a time ─

    function isResolved(record) {
        return Boolean(record?.result && record.result.status !== 'unknown' && record.result.card);
    }

    /** This item still wants an answer, whether or not it is time to ask again. */
    function isOpen(item) {
        const record = records.get(item.key);
        // The grid asked without the id and a product page now brings it.
        const betterQuestion = record && !isResolved(record) && item.productId && !record.askedWithId;
        const waitingOnOwn = isResolved(record) && record.own?.ownKnown === false;
        if (record && !betterQuestion && !waitingOnOwn) return false;
        return (attempts.get(item.key)?.count || 0) < MAX_ATTEMPTS;
    }

    function needsAsking(item, now) {
        return isOpen(item) && now >= (attempts.get(item.key)?.nextAt || 0);
    }

    function noteUnanswered(key, now) {
        const tried = attempts.get(key);
        attempts.set(key, { count: (tried?.count || 0) + 1, nextAt: now + RETRY_MS });
    }

    function absorbAnswer(answer, batch) {
        if (answer?.status) {
            lastStatus = answer.status;
            followRefresh();
        }
        const now = Date.now();
        for (const item of batch) {
            const got = answer?.marks?.[item.key];
            if (!got?.result) {
                // marks[key].result null means "could not answer now", not "does not exist".
                noteUnanswered(item.key, now);
                continue;
            }
            const askedWithId = Boolean(item.productId) || Boolean(records.get(item.key)?.askedWithId);
            records.set(item.key, { result: got.result, own: got.own ?? null, askedWithId });
            if (isResolved(records.get(item.key)) && got.own?.ownKnown === false) noteUnanswered(item.key, now);
            else attempts.delete(item.key);
        }
    }

    function repaint() {
        for (const entry of entries.values()) paintEntry(entry);
        syncOverlays();
    }

    function nextBatch() {
        const now = Date.now();
        const all = [...pageItems.values()];
        const wanted = reaskAll ? all : all.filter((item) => needsAsking(item, now));
        reaskAll = false;
        return wanted;
    }

    function scheduleRetry() {
        if (retryTimer || stopped || !isOn()) return;
        const open = [...pageItems.values()].filter(isOpen);
        if (!open.length) return;
        // At the moment the first one is due: a fixed delay can land just before it and wait a whole round more.
        const now = Date.now();
        const soonest = Math.min(...open.map((item) => attempts.get(item.key)?.nextAt ?? now));
        retryTimer = setTimeout(() => {
            retryTimer = null;
            flush();
        }, Math.max(SCAN_DELAY_MS, soonest - now));
    }

    async function flush() {
        if (flushing) {
            flushAgain = true;
            return;
        }
        flushing = true;
        try {
            do {
                flushAgain = false;
                if (!isOn()) break;
                const wanted = nextBatch();
                for (let i = 0; i < wanted.length; i += MAX_ITEMS_PER_MESSAGE) {
                    if (stopped || !alive()) {
                        shutDown();
                        return;
                    }
                    const batch = wanted.slice(i, i + MAX_ITEMS_PER_MESSAGE);
                    counters.messages += 1;
                    counters.itemsAsked += batch.length;
                    lastAskAt = Date.now();
                    const answer = await send({ type: 'shop-lookup', items: batch });
                    absorbAnswer(answer, batch);
                    repaint();
                }
            } while (flushAgain);
            scheduleRetry();
        } catch (err) {
            console.warn('[shop-marks] flush', err);
        } finally {
            flushing = false;
        }
    }

    // ─── scanning ─────────────────────────────────────────────────────────────

    function scan() {
        scanTimer = null;
        if (stopped) return;
        if (!alive()) {
            shutDown();
            return;
        }
        if (!isOn()) return;

        const startedAt = Date.now();
        counters.scans += 1;
        const cards = findCards(collectLinks());
        const items = new Map();

        // Before painting: the walk can move a card to an element inside the old one, and clearing
        // the old one afterwards would sweep the new mark. Vue also reuses an element and swaps its
        // href when paginating.
        for (const [card, entry] of entries) {
            if (cards.get(card)?.key === entry.key) continue;
            clearCard(entry);
            entries.delete(card);
        }

        for (const [card, group] of cards) {
            let entry = entries.get(card);
            if (!entry) {
                // The item is read once, before painting: later the link's text includes our mark.
                entry = {
                    card,
                    key: group.key,
                    item: itemForCard(card, group.key, group.links),
                    node: null,
                    mark: null,
                    sig: null,
                    anchors: [],
                    photo: null,
                    anchorEl: null,
                };
                entries.set(card, entry);
            }
            addItem(items, entry.item);
            paintEntry(entry);
        }

        const page = itemForPage();
        if (page) addItem(items, page);
        pageItems = items;

        syncOverlays();
        lastScanMs = Date.now() - startedAt;
        flush();
    }

    /** Coalesced: at most one scan pending, and a heavy page spaces them out by itself. */
    function scheduleScan() {
        if (scanTimer || stopped) return;
        scanTimer = setTimeout(scan, Math.max(SCAN_DELAY_MS, lastScanMs * 10));
    }

    function checkUrl() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        closeDetails();
        scheduleScan();
    }

    function isRelevantMutation(mutation) {
        if (isOwnNode(mutation.target)) return false;
        if (mutation.type === 'attributes') return true;
        const elementThatIsNotOurs = (node) => node.nodeType === 1 && !node.classList?.contains(ROOT);
        return [...mutation.addedNodes].some(elementThatIsNotOurs) || [...mutation.removedNodes].some(elementThatIsNotOurs);
    }

    function onMutations(mutations) {
        checkUrl();
        if (mutations.some(isRelevantMutation)) scheduleScan();
    }

    async function onVisible() {
        if (document.visibilityState !== 'visible' || stopped || !isOn()) return;
        // Coming back from signing in on another tab, or after a long while away.
        attempts.clear();
        if (lastAskAt && Date.now() - lastAskAt > REASK_AFTER_MS) reaskAll = true;
        if (lastStatus?.auth === false) {
            // Goes past the SW's back-off after a 403: the session may be back right now.
            const answer = await send({ type: 'shop-refresh' });
            if (answer?.status) lastStatus = answer.status;
            syncOverlays();
        }
        scheduleScan();
    }

    function onSnapshotChanged() {
        if (stopped || !isOn()) return;
        attempts.clear();
        reaskAll = true;
        flush();
    }

    /**
     * The SW says what changed and the tab asks for it. Not chrome.storage.onChanged: that event
     * hands every tab the old and new value of every write, ARCA's PDFs included.
     * Returns nothing, so the SW's sendMessage does not wait on an answer. The popup's question
     * about the tab is the one that gets an answer, right away.
     */
    function onShopChanged(message, sender, sendResponse) {
        if (stopped) return;
        switch (message?.type) {
            case 'shop:changed':
                if (message.what === 'snapshot') onSnapshotChanged();
                else if (message.what === 'settings') getSettings().then(applySettings);
                return;
            case 'shop:toggle-panel':
                togglePanel();
                return;
            case 'shop:tab-stats':
                sendResponse?.(tabStats());
                return;
            default:
        }
    }

    // ─── settings, start and stop ─────────────────────────────────────────────

    function writeHtmlAttributes() {
        const html = document.documentElement;
        if (isOn()) {
            html.setAttribute('data-pa-shop-variant', settings.variant);
            html.setAttribute('data-pa-shop-dim', settings.dimOwned ? '1' : '0');
        } else {
            html.removeAttribute('data-pa-shop-variant');
            html.removeAttribute('data-pa-shop-dim');
        }
    }

    function clearPage() {
        closeDetails();
        for (const entry of entries.values()) clearCard(entry);
        entries.clear();
        removePanel();
        removePill();
    }

    function startWatching() {
        if (started) return;
        started = true;
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
    }

    function stopWatching() {
        started = false;
        observer?.disconnect();
        observer = null;
        clearTimeout(scanTimer);
        clearTimeout(retryTimer);
        clearTimeout(resizeTimer);
        clearTimeout(statusTimer);
        scanTimer = null;
        retryTimer = null;
        resizeTimer = null;
        statusTimer = null;
    }

    function applySettings(next) {
        if (stopped) return;
        settings = next;
        writeHtmlAttributes();
        if (!isOn()) {
            stopWatching();
            clearPage();
            reportBadge();
            return;
        }
        startWatching();
        for (const entry of entries.values()) paintEntry(entry); // the variant is part of the signature
        syncOverlays();
        scheduleScan();
    }

    const windowListeners = [
        ['popstate', checkUrl],
        ['hashchange', checkUrl],
        ['resize', onResize],
    ];

    function addListeners() {
        for (const [type, fn] of windowListeners) window.addEventListener(type, fn);
        window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });
        window.navigation?.addEventListener?.('navigatesuccess', checkUrl);
        document.addEventListener('visibilitychange', onVisible);
        document.addEventListener('click', onDocumentClick, true);
        document.addEventListener('keydown', onKeyDown);
        if (!window.__paShopStub) {
            try {
                chrome.runtime.onMessage.addListener(onShopChanged);
            } catch (err) {
                console.warn('[shop-marks] onMessage', err);
            }
        }
    }

    function removeListeners() {
        for (const [type, fn] of windowListeners) window.removeEventListener(type, fn);
        window.removeEventListener('scroll', onAnyScroll, { capture: true });
        window.navigation?.removeEventListener?.('navigatesuccess', checkUrl);
        document.removeEventListener('visibilitychange', onVisible);
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeyDown);
        try {
            if (alive() && !window.__paShopStub) chrome.runtime.onMessage.removeListener(onShopChanged);
        } catch {
            // the context is gone, and the listener with it
        }
    }

    /**
     * The extension was reloaded under this page: chrome.runtime.id is gone and any call
     * would throw. Stop asking, stop watching, and leave the marks: they are still right,
     * their details only use what is already in memory, and the next load of the page
     * brings the new version.
     */
    function shutDown() {
        if (stopped) return;
        stopped = true;
        stopWatching();
        removeListeners();
        // The marks' own listeners stay, so their details keep working. Clicks outside
        // still need to close them.
        document.addEventListener('click', onDocumentClick, true);
        document.addEventListener('keydown', onKeyDown);
    }

    /** Removes every trace, so the same page can be injected again from clean. */
    function teardown() {
        shutDown();
        document.removeEventListener('click', onDocumentClick, true);
        document.removeEventListener('keydown', onKeyDown);
        clearPage();
        document.documentElement.removeAttribute('data-pa-shop-variant');
        document.documentElement.removeAttribute('data-pa-shop-dim');
    }

    window.__paShopMarks = {
        teardown,
        scanNow: () => {
            clearTimeout(scanTimer);
            scan();
        },
        /** Same path as a change in shop:settings. */
        applySettings: (patch) => applySettings(core.normalizeSettings({ ...settings, ...patch })),
        /** Same path as a new snapshot: every card on the page is asked again. */
        snapshotChanged: onSnapshotChanged,
        /** What the SW's message does, for a page running on the stub: no chrome.runtime there. */
        shopChanged: (message) => {
            let answer;
            onShopChanged(message, null, (value) => (answer = value));
            return answer;
        },
        stats: () => ({
            store: store.key,
            variant: settings.variant,
            enabled: settings.enabled,
            on: isOn(),
            stopped,
            links: counters.links,
            ignoredLinks: counters.ignored,
            cards: entries.size,
            painted: [...entries.values()].filter((entry) => entry.node).length,
            keys: pageItems.size,
            known: records.size,
            scans: counters.scans,
            messages: counters.messages,
            itemsAsked: counters.itemsAsked,
            panel: Boolean(panel.node),
            loginPill: pill?.kind === 'login' || panel.notice === 'login',
            oldDataPill: pill?.kind === 'old' || panel.notice === 'old',
            panelPosition: panel.node ? { left: Math.round(rectOf(panel.node).left), top: Math.round(rectOf(panel.node).top) } : null,
            auth: lastStatus?.auth ?? null,
        }),
        /** What each card says right now, for the tests. */
        marksNow: () =>
            [...entries.values()].map((entry) => ({
                key: entry.key,
                state: entry.mark?.state ?? null,
                title: entry.mark?.title ?? null,
                painted: Boolean(entry.node),
                connected: Boolean(entry.node?.isConnected),
            })),
        /** For the card-walk tests: cards of the page right now, without painting anything. */
        findCardsNow: () => [...findCards(collectLinks())].map(([card, group]) => ({ card, key: group.key, links: group.links.length })),
    };

    async function start() {
        const loaded = await getSettings();
        if (stopped) return;
        addListeners();
        settings = loaded;
        writeHtmlAttributes();
        if (!isOn()) {
            reportBadge(); // a badge left by the last page of this tab goes away
            return;
        }
        startWatching();
        scan();
    }

    start().catch((err) => console.warn('[shop-marks] start', err));
})();
