// Shop marks: pure logic shared by the content script, the service worker and the tests.
//
// No DOM and no chrome API in here. It attaches to globalThis so the same file loads
// as a content script, through importScripts in the SW, as a classic script in the
// popup and from node. See CLAUDE.md, "Marcas en tiendas de compra".

(function () {
    'use strict';

    const STORE_LINKS = {
        shopify: 'a[href*="/products/"]',
        csi: 'a[href*="/p/pokemon/" i]',
        tcgplayer: 'a[href*="/product/"]',
    };

    const store = (key, label, hosts, kind) => ({ key, label, hosts, kind, linkSelector: STORE_LINKS[kind] });

    // Keys and labels equal KT `USA_STORES` (konekotekka: lib/compras/stores.mjs).
    const STORES = [
        store('pokecollect', 'Poke-Collect', ['poke-collect.com'], 'shopify'),
        store('coolstuffinc', 'CoolStuffInc', ['coolstuffinc.com'], 'csi'),
        store('wulfgaming', 'Wulf Gaming', ['wulfgaming.com'], 'shopify'),
        store('gglehi', 'GG Lehi', ['store.gglehi.com'], 'shopify'),
        store('playerscandc', 'Players C&C', ['playerscandc.com'], 'shopify'),
        store('omotenashi', 'Omotenashi TCG', ['omotenashitcg.com'], 'shopify'),
        store('magicandmonsters', 'Magic & Monsters', ['magicandmonsters.com'], 'shopify'),
        store('smokeandmirrors', 'Smoke & Mirrors Hobby', ['smokeandmirrorshobby.com'], 'shopify'),
        store('tcgplayer', 'TCGplayer', ['tcgplayer.com'], 'tcgplayer'),
    ];

    const SETTINGS_KEY = 'shop:settings';
    const DEFAULT_SETTINGS = { enabled: true, variant: 'a', dimOwned: false };
    const DEFAULT_ADMIN_BASE = 'https://cartas.konekotekka.com.ar';
    // Older own data is treated as absent: a stock count this old must not read as today's.
    const OWN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
    const REVERSE_SUBTYPE = 'Reverse Holofoil';
    // Narrower than this, stores stack their columns and the open panel lands on Add to cart.
    const PANEL_OPEN_MIN_WIDTH = 1000;

    const stripWww = (host) => String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

    function storeFromHost(hostname) {
        const host = stripWww(hostname);
        if (!host) return null;
        return STORES.find((s) => s.hosts.includes(host)) || null;
    }

    function resolveStore(storeOrKey) {
        if (storeOrKey && typeof storeOrKey === 'object') return storeOrKey;
        return STORES.find((s) => s.key === storeOrKey) || null;
    }

    /** Parses a link of this store. null for another host or an unparseable href. */
    function parseStoreUrl(store, href) {
        if (typeof href !== 'string' || !href.trim()) return null;
        let url;
        try {
            url = new URL(href, `https://${store.hosts[0]}/`);
        } catch {
            return null;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (storeFromHost(url.hostname) !== store) return null;
        return url;
    }

    // Optional Shopify Markets locale, optional collection, then the handle and nothing else.
    const SHOPIFY_PRODUCT = /^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+)\/?$/i;
    const SHOPIFY_NOT_A_PAGE = /\.(?:js|json|xml|atom|oembed)$/i;
    const CSI_PRODUCT = /^\/p\/pokemon\/(.+)$/i;
    const TCGPLAYER_PRODUCT = /^\/product\/(\d+)(?:\/|$)/i;

    function decodeCsiPath(path) {
        const spaced = path.replace(/\+/g, ' ');
        try {
            return decodeURIComponent(spaced);
        } catch {
            return spaced;
        }
    }

    /**
     * Canonical key of a product link, for grouping links and for the identity cache.
     * The same product gives the same key however the theme or the grid spells the link.
     * Not trimmed on CSI: stored urls like `Charizard-EX+-+12%2F108+` do end in a space.
     */
    function productKeyFromHref(storeOrKey, href) {
        const store = resolveStore(storeOrKey);
        if (!store) return null;
        const url = parseStoreUrl(store, href);
        if (!url) return null;

        if (store.kind === 'shopify') {
            const handle = url.pathname.match(SHOPIFY_PRODUCT)?.[1];
            if (!handle || SHOPIFY_NOT_A_PAGE.test(handle)) return null;
            return `/products/${handle.toLowerCase()}`;
        }
        if (store.kind === 'csi') {
            const rest = url.pathname.match(CSI_PRODUCT)?.[1];
            return rest ? `/p/Pokemon/${decodeCsiPath(rest)}` : null;
        }
        if (store.kind === 'tcgplayer') {
            return url.pathname.match(TCGPLAYER_PRODUCT)?.[1] || null;
        }
        return null;
    }

    function productIdFromHref(storeOrKey, href) {
        const store = resolveStore(storeOrKey);
        if (!store || store.kind !== 'tcgplayer') return null;
        const key = productKeyFromHref(store, href);
        return key ? Number(key) : null;
    }

    /**
     * The card walk: from each `{ link, key }`, climb while the parent still holds a single
     * product. `top` is the last node before the parent mixes products. One bottom-up pass,
     * so a grid costs links x depth. `parentOf` is the only thing it knows about the DOM.
     */
    function climbToCards(links, parentOf) {
        const keysByNode = new Map();
        for (const { link, key } of links) {
            for (let node = link; node; node = parentOf(node)) {
                let keys = keysByNode.get(node);
                if (!keys) {
                    keys = new Set();
                    keysByNode.set(node, keys);
                }
                // Already mixed: every ancestor is mixed too, nothing above can change.
                const wasMixed = keys.size > 1;
                keys.add(key);
                if (wasMixed) break;
            }
        }
        return links.map(({ link, key }) => {
            let top = link;
            let parent = parentOf(top);
            while (parent && keysByNode.get(parent)?.size === 1) {
                top = parent;
                parent = parentOf(top);
            }
            return { link, key, top };
        });
    }

    // ─── formats ──────────────────────────────────────────────────────────────

    const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
    const toNum = (n) => {
        if (n === null || n === undefined || n === '') return null;
        const value = Number(n);
        return Number.isFinite(value) ? value : null;
    };

    /** `US$ 12,40`, `US$ 1.234,50`, `-US$ 3,00`. Empty string without a number. */
    function formatUsd(value) {
        const n = toNum(value);
        if (n === null) return '';
        const [whole, cents] = Math.abs(n).toFixed(2).split('.');
        const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        const negative = n < 0 && Number(`${whole}.${cents}`) !== 0;
        return `${negative ? '-' : ''}US$ ${grouped},${cents}`;
    }

    /** From a fraction: -0.08 is `-8 %`, 0.12 is `+12 %`. Empty string without a number. */
    function formatPct(fraction) {
        const n = toNum(fraction);
        if (n === null) return '';
        const rounded = Math.round(n * 100);
        if (rounded === 0) return '0 %';
        return `${rounded > 0 ? '+' : ''}${rounded} %`;
    }

    /**
     * `12/10`, in local time. A date from another year carries it (`12/10/25`), so an
     * old sale does not read as last month. Date-only strings are not shifted by the
     * timezone. Empty string when it does not parse.
     */
    function formatDate(value, now = Date.now()) {
        if (!value) return '';
        const dateOnly = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const date = dateOnly
            ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
            : new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        if (date.getFullYear() === new Date(now).getFullYear()) return `${dd}/${mm}`;
        return `${dd}/${mm}/${String(date.getFullYear()).slice(-2)}`;
    }

    /** `recién`, `hace 3 min`, `hace 2 h`, `hace 4 días`. */
    function formatAge(ms) {
        if (!isNum(ms)) return '';
        const minutes = Math.floor(ms / 60000);
        if (minutes < 1) return 'recién';
        if (minutes < 60) return `hace ${minutes} min`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `hace ${hours} h`;
        const days = Math.floor(hours / 24);
        return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
    }

    // ─── own data ─────────────────────────────────────────────────────────────

    const LANGS = ['en', 'es', 'jap', 'jumbo'];
    const LANG_LABEL = { en: 'EN', es: 'ES', jap: 'JP', jumbo: 'Jumbo' };
    const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DM'];

    const positive = (n) => {
        const value = toNum(n);
        return value !== null && value > 0 ? value : 0;
    };

    const sumPositive = (obj) => Object.values(obj || {}).reduce((total, n) => total + positive(n), 0);

    /**
     * Units of one printing, by language. `count` from PA can be negative (5 rows in
     * production) and can miss units whose printing has no TcgpPrices row of its own,
     * which `byLang` does count, so the total is the largest of the three. Units that
     * `stock` has and `byLang` does not are the card's own language, because `byLang`
     * is only sent when something other than plain English exists.
     */
    function rowUnits(row, nativeLang) {
        const units = { total: 0, hidden: 0, byLang: {} };
        if (!row) return units;
        const stock = positive(row.stock);
        const fromLangs = sumPositive(row.byLang);
        units.hidden = positive(row.hidden);
        units.total = Math.max(stock, fromLangs, units.hidden);
        for (const lang of LANGS) {
            const n = positive(row.byLang?.[lang]);
            if (n) units.byLang[lang] = n;
        }
        const rest = units.total - fromLangs;
        if (rest > 0) units.byLang[nativeLang] = (units.byLang[nativeLang] || 0) + rest;
        return units;
    }

    /**
     * Native units of one printing that can be called stock. All of them in the vault means
     * none: hidden units are attributed to the native language first (the feed does not
     * split them), and in the real rows that is where they are. Part in the vault keeps the
     * count, with the vault in the note.
     */
    function nativeForSale(units, nativeLang) {
        const native = units.byLang[nativeLang] || 0;
        return units.hidden >= native ? 0 : native;
    }

    /**
     * "Tenés 3 + 1 rev", "1 ES", "1 ES + 1 ES rev", "2 en el vault", "Tenés 2 + 1 ES",
     * "1 ES + 2 en el vault" (the English ones are all in the vault, the ES one is on sale).
     */
    function describeStock(normal, reverse, nativeLang) {
        const nativeNormal = nativeForSale(normal, nativeLang);
        const nativeReverse = nativeForSale(reverse, nativeLang);
        const vaultedNative =
            (normal.byLang[nativeLang] || 0) - nativeNormal + (reverse.byLang[nativeLang] || 0) - nativeReverse;
        const total = normal.total + reverse.total;
        const hidden = normal.hidden + reverse.hidden;

        const nativeParts = [];
        if (nativeNormal) nativeParts.push(String(nativeNormal));
        if (nativeReverse) nativeParts.push(`${nativeReverse} rev`);

        const foreignParts = [];
        for (const lang of LANGS) {
            if (lang === nativeLang) continue;
            if (normal.byLang[lang]) foreignParts.push(`${normal.byLang[lang]} ${LANG_LABEL[lang]}`);
            if (reverse.byLang[lang]) foreignParts.push(`${reverse.byLang[lang]} ${LANG_LABEL[lang]} rev`);
        }

        const vaultNote = hidden ? `${hidden} en el vault` : null;
        const breakdown = foreignParts.length
            ? LANGS.filter((lang) => normal.byLang[lang] || reverse.byLang[lang])
                  .map((lang) => `${(normal.byLang[lang] || 0) + (reverse.byLang[lang] || 0)} ${LANG_LABEL[lang]}`)
                  .join(' + ')
            : null;

        // Only the vault: the units exist but are not for sale.
        if (hidden >= total) {
            return { title: vaultNote, badge: 'Vault', langNote: breakdown };
        }

        const langNote = [breakdown, vaultNote].filter(Boolean).join(' · ') || null;
        const titleVault = vaultedNative ? [`${vaultedNative} en el vault`] : [];
        if (!nativeParts.length) {
            return { title: foreignParts.concat(titleVault).join(' + '), badge: foreignParts.join(' + '), langNote };
        }
        const parts = nativeParts.concat(foreignParts, titleVault);
        const compact = [nativeNormal ? String(nativeNormal) : null, nativeReverse ? `${nativeReverse}R` : null]
            .concat(foreignParts)
            .filter(Boolean)
            .join('+');
        return { title: `Tenés ${parts.join(' + ')}`, badge: compact, langNote };
    }

    /**
     * Stock only in the printing this listing does not sell: "Tenés 1 normal, 0 rev",
     * "Tenés 0 normal, 1 rev", "1 ES normal, 0 rev", "0 normal, 2 rev en el vault".
     * Same "Tenés" rule as `describeStock`: only for native units that are on sale.
     */
    function describeOtherPrintingOnly(normal, reverse, nativeLang, listedReverse) {
        const other = listedReverse ? normal : reverse;
        const word = listedReverse ? 'normal' : 'rev';
        const sides = (text) => (listedReverse ? `${text}, 0 rev` : `0 normal, ${text}`);

        if (other.hidden >= other.total) {
            return { title: sides(`${other.total} ${word} en el vault`), badge: 'Vault' };
        }

        const native = nativeForSale(other, nativeLang);
        const foreign = LANGS.filter((lang) => lang !== nativeLang && other.byLang[lang]).map(
            (lang) => `${other.byLang[lang]} ${LANG_LABEL[lang]}`,
        );
        const count = (native ? [String(native)] : []).concat(foreign);
        const title = sides(`${count.join(' + ')} ${word}`);
        const compact = [native ? `${native}${listedReverse ? '' : 'R'}` : null]
            .concat(foreign.map((text) => (listedReverse ? text : `${text} rev`)))
            .filter(Boolean)
            .join('+');
        return {
            title: native ? `Tenés ${title}` : title,
            badge: listedReverse ? `${compact}+0R` : `0+${compact}`,
        };
    }

    function describeConditions(normal, reverse) {
        const units = {};
        for (const row of [normal, reverse]) {
            for (const condition of CONDITIONS) {
                const n = positive(row?.byCondition?.[condition]);
                if (n) units[condition] = (units[condition] || 0) + n;
            }
        }
        const present = CONDITIONS.filter((condition) => units[condition]);
        if (!present.length || (present.length === 1 && present[0] === 'NM')) return null;
        return present.map((condition) => `${units[condition]} ${condition}`).join(' + ');
    }

    /**
     * The own-data shape `deriveMark` takes, from a snapshot and a resolved card.
     * `unsettled` are the products a stock line with no product id could belong to. Having no
     * row says nothing about them, so `mapped` is null, the same as having no map: stock can
     * be asserted, "No la tenés" cannot.
     */
    function shapeOwn(snapshot, card) {
        const productId = card?.productId;
        const known = productId !== undefined && productId !== null;
        const part = (map, reverse) => {
            if (!map || !known) return null;
            return map[`${productId}:${reverse}`] || null;
        };
        const groups = snapshot?.mappedGroups;
        const groupId = card?.groupId;
        const unsettled = known && Array.isArray(snapshot?.unsettled) && snapshot.unsettled.some((id) => Number(id) === Number(productId));
        const inTheMap = Array.isArray(groups) && groupId !== null && groupId !== undefined ? groups.includes(groupId) : null;
        return {
            rows: { 0: part(snapshot?.own, 0), 1: part(snapshot?.own, 1) },
            important: { 0: part(snapshot?.important, 0), 1: part(snapshot?.important, 1) },
            meta: (known && snapshot?.meta?.[productId]) || null,
            mapped: unsettled ? null : inTheMap,
            ownKnown: Boolean(snapshot?.own),
        };
    }

    /** A snapshot with own data that may not be trusted any more. No own data at all is another thing. */
    function isOwnTooOld(snapshot, now = Date.now()) {
        if (!snapshot?.own) return false;
        return typeof snapshot.ownAt !== 'number' || now - snapshot.ownAt > OWN_MAX_AGE_MS;
    }

    // ─── the mark ─────────────────────────────────────────────────────────────

    /**
     * The printing the mark talks about: the one offered here, else the one the listing
     * names (`preferred`, when the card came by title), else the first with a market.
     * null when the listing names a printing the catalog lacks: any other printing's market
     * is not this listing's.
     */
    function pickPrinting(printings, preferred) {
        const offered = printings.filter((p) => p && p.here);
        if (offered.length) {
            const rank = (p) => (p.here.active === false ? 2 : 0) + (p.isReverse ? 1 : 0);
            return offered.reduce((best, p) => (rank(p) < rank(best) ? p : best));
        }
        if (preferred) return printings.find((p) => p && p.subType === preferred) || null;
        const withMarket = printings.filter((p) => p && positive(p.market));
        return withMarket.find((p) => !p.isReverse) || withMarket[0] || printings.find(Boolean) || null;
    }

    /** Whether this listing sells the reverse. null when it does not say. */
    function listingIsReverse(result, shown) {
        if (shown?.here) return Boolean(shown.isReverse);
        if (!result.printing) return null;
        if (shown?.subType === result.printing) return Boolean(shown.isReverse);
        return result.printing === REVERSE_SUBTYPE;
    }

    /** The line of the details: `TCGplayer no lista la versión Reverse`. Empty without a printing. */
    function missingPrintingText(printing) {
        if (!printing) return '';
        return `TCGplayer no lista la versión ${printing === REVERSE_SUBTYPE ? 'Reverse' : printing}`;
    }

    const latestDate = (...values) => {
        const dates = values.filter(Boolean).map((value) => ({ value, time: new Date(value).getTime() }));
        const valid = dates.filter((d) => !Number.isNaN(d.time));
        if (!valid.length) return null;
        return valid.reduce((best, d) => (d.time > best.time ? d : best)).value;
    };

    function deriveMark(result, own) {
        const empty = {
            state: 'unknown',
            doubtful: false,
            doubtfulNote: null,
            title: null,
            badge: null,
            note: null,
            otherPrintingOnly: false,
            reorderNote: null,
            printingMissing: null,
            card: null,
            counts: { normal: 0, reverse: 0 },
            vault: 0,
            langNote: null,
            conditionNote: null,
            price: null,
            sold: { d90: 0, d180: 0, total: 0, last: null },
            wishlist: 0,
            market: null,
            here: null,
            trend: null,
            bestElsewhere: null,
            boughtAt: null,
            meta: null,
        };
        if (!result || result.status === 'unknown' || !result.card) return empty;

        const doubtful = result.status === 'doubtful';
        const card = result.card;
        const printings = Array.isArray(result.printings) ? result.printings : [];
        const shown = pickPrinting(printings, result.printing);
        const ownKnown = own?.ownKnown === true;

        const row0 = own?.rows?.[0] || null;
        const row1 = own?.rows?.[1] || null;
        const imp0 = own?.important?.[0] || null;
        const imp1 = own?.important?.[1] || null;
        const nativeLang = card.language === 'ja' ? 'jap' : 'en';
        const normal = rowUnits(row0, nativeLang);
        const reverse = rowUnits(row1, nativeLang);

        // The wishlist belongs to the card, not the printing: both rows carry the same
        // number, so adding them would double it.
        const wishlist = Math.max(positive(row0?.wishlist), positive(row1?.wishlist));
        const sold = {
            d90: positive(row0?.sold90) + positive(row1?.sold90),
            d180: positive(row0?.sold180) + positive(row1?.sold180),
            total: Math.max(
                positive(row0?.soldTotal) + positive(row1?.soldTotal),
                positive(imp0?.sold) + positive(imp1?.sold),
            ),
            last: latestDate(row0?.lastSoldAt, row1?.lastSoldAt, imp0?.last, imp1?.last),
        };

        // Only this printing's own price: the other one's would read as the price of this one.
        const showsReverse = shown ? shown.isReverse : listingIsReverse(result, shown);
        const price = positive((showsReverse ? row1 : row0)?.price) || null;

        const mark = {
            ...empty,
            doubtful,
            doubtfulNote: doubtful ? '¿Es esta carta?' : null,
            printingMissing: !shown && result.printing ? result.printing : null,
            card,
            counts: { normal: normal.total, reverse: reverse.total },
            vault: normal.hidden + reverse.hidden,
            conditionNote: describeConditions(row0, row1),
            price,
            sold,
            wishlist,
            market: shown
                ? {
                      value: toNum(shown.market),
                      low: toNum(shown.low),
                      mid: toNum(shown.mid),
                      flimsy: Boolean(shown.flimsyMarket),
                      printing: shown.subType || null,
                      updatedAt: shown.marketUpdatedAt || null,
                  }
                : null,
            here: shown?.here
                ? {
                      priceUsd: toNum(shown.here.priceUsd),
                      landedUsd: toNum(shown.here.landedUsd),
                      diffPct: toNum(shown.here.diffPct),
                      belowLow: Boolean(shown.here.belowLow),
                      stale: Boolean(shown.here.stale),
                      ageDays: toNum(shown.here.ageDays),
                      stock: toNum(shown.here.stock), // null means the store does not say, not zero
                      condition: shown.here.condition || null,
                      seenAt: shown.here.seenAt || null,
                      active: shown.here.active !== false,
                      printing: shown.subType || null,
                      isReverse: Boolean(shown.isReverse),
                  }
                : null,
            trend: shown?.trend || null,
            bestElsewhere: shown?.bestElsewhere || null,
            boughtAt: shown?.boughtAt || latestDate(...printings.map((p) => p?.boughtAt)),
            meta: own?.meta || null,
        };

        if (!ownKnown) {
            return { ...mark, state: 'loading', title: 'Cargando tus datos', badge: '...' };
        }

        if (normal.total + reverse.total > 0) {
            const { title, badge, langNote } = describeStock(normal, reverse, nativeLang);
            const listedReverse = listingIsReverse(result, shown);
            const listed = listedReverse === null ? null : listedReverse ? reverse : normal;
            if (listed?.total !== 0) return { ...mark, state: 'have', title, badge, langNote };

            // The store sells a printing we hold none of: "Tenés 1" would read as if we held this one.
            const listedImportant = listedReverse ? imp1 : imp0;
            const listedSold = positive(listedImportant?.sold);
            return {
                ...mark,
                ...describeOtherPrintingOnly(normal, reverse, nativeLang, listedReverse),
                state: 'have',
                langNote,
                otherPrintingOnly: true,
                reorderNote: listedImportant ? (listedSold ? `Reponer · vendiste ${listedSold}` : 'Reponer') : null,
            };
        }

        const recent = sold.d90
            ? `Vendiste ${sold.d90} en 90 días (web)`
            : sold.d180
              ? `Vendiste ${sold.d180} en 180 días (web)`
              : null;

        if (own.mapped === false) {
            return { ...mark, state: 'unmapped', title: 'Set sin mapear', badge: '?', note: 'No se puede saber si la tenés' };
        }

        // mapped null: the set map did not come (PA without the new field, or a card whose
        // product lost its market). It may be a set that cannot be seen from this side, so
        // this cannot assert "No la tenés", and neither can "Falta" or "Reponer".
        if (own.mapped === null || own.mapped === undefined) {
            return {
                ...mark,
                state: 'unmapped',
                title: 'No figura en tu stock',
                badge: '?',
                note: recent || 'No se puede saber si la tenés',
            };
        }

        if (wishlist > 0) {
            return { ...mark, state: 'wanted', title: `Falta · ${wishlist} en wishlist`, badge: 'Falta' };
        }

        if (imp0 || imp1) {
            return {
                ...mark,
                state: 'reorder',
                title: sold.total ? `Reponer · vendiste ${sold.total}` : 'Reponer',
                badge: 'Reponer',
                note: sold.total ? `Vendiste ${sold.total} en total (web)` : null,
            };
        }

        return { ...mark, state: 'none', title: 'No la tenés', badge: '0', note: recent };
    }

    /** A saved choice wins. With none, undefined in the settings, the window decides. */
    function isPanelCollapsed(settings, windowWidth) {
        const saved = settings?.panelCollapsed;
        return typeof saved === 'boolean' ? saved : windowWidth < PANEL_OPEN_MIN_WIDTH;
    }

    function normalizeSettings(saved) {
        const merged = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
        merged.enabled = merged.enabled !== false;
        merged.dimOwned = merged.dimOwned === true;
        if (!['a', 'b', 'c'].includes(merged.variant)) merged.variant = DEFAULT_SETTINGS.variant;
        return merged;
    }

    globalThis.PAShopCore = {
        STORES,
        SETTINGS_KEY,
        DEFAULT_SETTINGS,
        DEFAULT_ADMIN_BASE,
        storeFromHost,
        productKeyFromHref,
        productIdFromHref,
        climbToCards,
        deriveMark,
        shapeOwn,
        isOwnTooOld,
        missingPrintingText,
        isPanelCollapsed,
        normalizeSettings,
        formatUsd,
        formatPct,
        formatDate,
        formatAge,
    };
})();
