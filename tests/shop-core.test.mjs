// node --test tests/shop-core.test.mjs
//
// shop-core.js directly, and the real service worker files in a `vm` context with
// chrome, fetch, timers and the clock faked. A new context over the same fake storage
// is exactly what a service worker restart is: module variables gone, storage kept.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

await import('../scripts/lib/shop-core.js');
const core = globalThis.PAShopCore;
const { deriveMark, formatDate, formatPct, formatUsd, productIdFromHref, productKeyFromHref, shapeOwn, storeFromHost } = core;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// What a settings object with nothing chosen holds.
const DEFAULTS = {
    enabled: true,
    variant: 'c',
    dimOwned: false,
    disabledStores: [],
    panelEnabled: true,
    panelCorner: 'bottom-left',
    panelSize: 'normal',
    panelPositions: {},
    badge: true,
};

// ─── links ───────────────────────────────────────────────────────────────────

describe('storeFromHost', () => {
    test('finds every store with and without www, ignoring case', () => {
        for (const store of core.STORES) {
            for (const host of store.hosts) {
                assert.equal(storeFromHost(host)?.key, store.key);
                assert.equal(storeFromHost(`www.${host}`)?.key, store.key);
                assert.equal(storeFromHost(host.toUpperCase())?.key, store.key);
            }
        }
    });

    test('the real hosts of production urls', () => {
        assert.equal(storeFromHost('www.coolstuffinc.com').key, 'coolstuffinc');
        assert.equal(storeFromHost('coolstuffinc.com').key, 'coolstuffinc');
        assert.equal(storeFromHost('store.gglehi.com').key, 'gglehi');
        assert.equal(storeFromHost('www.tcgplayer.com').key, 'tcgplayer');
    });

    test('null for anything else', () => {
        for (const host of ['', null, undefined, 'google.com', 'gglehi.com', 'evilwulfgaming.com', 'wulfgaming.com.ar']) {
            assert.equal(storeFromHost(host), null, String(host));
        }
    });

    test('keys equal the KT USA_STORES keys plus tcgplayer', () => {
        assert.deepEqual(core.STORES.map((s) => s.key).sort(), [
            'coolstuffinc', 'gglehi', 'magicandmonsters', 'omotenashi', 'playerscandc', 'pokecollect',
            'smokeandmirrors', 'tcgplayer', 'wulfgaming',
        ]);
    });
});

describe('productKeyFromHref', () => {
    test('Shopify with a collection in the path', () => {
        assert.equal(
            productKeyFromHref('magicandmonsters', '/collections/pokemon-singles/products/blastoise-ex-009-165-scarlet-violet-151'),
            '/products/blastoise-ex-009-165-scarlet-violet-151',
        );
    });

    test('Shopify without a collection', () => {
        assert.equal(
            productKeyFromHref('wulfgaming', '/products/technical-machine-fluorite-sv08-surging-sparks-590075'),
            '/products/technical-machine-fluorite-sv08-surging-sparks-590075',
        );
    });

    test('Shopify: grid and stored url give the same key; query and hash go away', () => {
        const stored = 'https://magicandmonsters.com/products/krokorok-108-185-sword-shield-vivid-voltage';
        const key = productKeyFromHref('magicandmonsters', stored);
        assert.equal(key, '/products/krokorok-108-185-sword-shield-vivid-voltage');
        for (const href of [
            '/collections/all/products/krokorok-108-185-sword-shield-vivid-voltage?variant=123',
            'https://www.magicandmonsters.com/products/krokorok-108-185-sword-shield-vivid-voltage#x',
            '/products/krokorok-108-185-sword-shield-vivid-voltage/',
            '/en-us/products/krokorok-108-185-sword-shield-vivid-voltage',
        ]) {
            assert.equal(productKeyFromHref('magicandmonsters', href), key, href);
        }
    });

    test('Shopify: underscores in a handle are valid', () => {
        assert.equal(productKeyFromHref('omotenashi', '/products/_____s-pikachu-001'), '/products/_____s-pikachu-001');
    });

    test('CoolStuffInc decodes, so encodings of one product collapse', () => {
        const grid = '/p/Pokemon/Charizard+%26+Braixen-GX+%28Alt+Full+Art%29+-+SM230';
        const expected = '/p/Pokemon/Charizard & Braixen-GX (Alt Full Art) - SM230';
        assert.equal(productKeyFromHref('coolstuffinc', grid), expected);
        assert.equal(productKeyFromHref('coolstuffinc', `https://www.coolstuffinc.com${grid}`), expected);
        assert.equal(productKeyFromHref('coolstuffinc', '/p/Pokemon/Charizard%20%26%20Braixen-GX%20(Alt%20Full%20Art)%20-%20SM230'), expected);
        assert.equal(productKeyFromHref('coolstuffinc', 'https://www.coolstuffinc.com/p/Pokemon/Loudred+-+106%2F135'), '/p/Pokemon/Loudred - 106/135');
    });

    test('CoolStuffInc does not trim: a stored url does end in a plus', () => {
        assert.equal(productKeyFromHref('coolstuffinc', '/p/Pokemon/Charizard-EX+-+12%2F108+'), '/p/Pokemon/Charizard-EX - 12/108 ');
    });

    test('CoolStuffInc keeps Pokemon only', () => {
        assert.equal(productKeyFromHref('coolstuffinc', '/p/Magic+The+Gathering/Lightning+Bolt'), null);
        assert.equal(productKeyFromHref('coolstuffinc', '/p/Pokemon/'), null);
    });

    test('TCGplayer gives the numeric id', () => {
        const href = '/product/84186/pokemon-skyridge-charizard?page=1';
        assert.equal(productKeyFromHref('tcgplayer', href), '84186');
        assert.equal(productIdFromHref('tcgplayer', href), 84186);
        assert.equal(productIdFromHref('tcgplayer', 'https://www.tcgplayer.com/product/84186'), 84186);
    });

    test('productIdFromHref is null outside TCGplayer', () => {
        assert.equal(productIdFromHref('wulfgaming', '/products/84186'), null);
        assert.equal(productIdFromHref('tcgplayer', '/search/pokemon/product'), null);
    });

    test('takes a store object as well as a key', () => {
        assert.equal(productKeyFromHref(storeFromHost('www.tcgplayer.com'), '/product/1/x'), '1');
    });

    test('non product links give null', () => {
        const cases = [
            ['wulfgaming', '/'],
            ['wulfgaming', '/collections/pokemon-singles'],
            ['wulfgaming', '/collections/pokemon-singles/products'],
            ['wulfgaming', '/collections/pokemon-singles/products/'],
            ['wulfgaming', '/products'],
            ['wulfgaming', '/products/'],
            ['wulfgaming', '/products/abra.json'],
            ['wulfgaming', '/pages/contact'],
            ['wulfgaming', '/cart'],
            ['wulfgaming', '#'],
            ['wulfgaming', ''],
            ['wulfgaming', null],
            ['wulfgaming', 'javascript:void(0)'],
            ['wulfgaming', 'mailto:hola@wulfgaming.com'],
            ['wulfgaming', 'https://www.instagram.com/products/abra'],
            ['wulfgaming', 'https://gglehi.com/products/abra'],
            ['coolstuffinc', '/Pokemon'],
            ['tcgplayer', '/search/pokemon/product?productLineName=pokemon'],
            ['tcgplayer', '/product/abc/foo'],
            ['tcgplayer', '/categories/trading-and-collectible-card-games/pokemon'],
            ['nope', '/products/abra'],
        ];
        for (const [store, href] of cases) {
            assert.equal(productKeyFromHref(store, href), null, `${store} ${href}`);
        }
    });

    test('one real stored url per store gives a key on its own host', () => {
        const samples = {
            pokecollect: 'https://poke-collect.com/products/glaceon-ex-sv-prismatic-evolutions-holofoil',
            coolstuffinc: 'https://www.coolstuffinc.com/p/Pokemon/Mareanie+-+39%2F145+%28Reverse+Foil%29',
            wulfgaming: 'https://wulfgaming.com/products/pidgeot-southern-islands-46476',
            gglehi: 'https://store.gglehi.com/products/lampent-032-192-trick-or-trade',
            playerscandc: 'https://playerscandc.com/products/galarian-mr-mime-swsh05-battle-styles',
            omotenashi: 'https://omotenashitcg.com/products/rockets-zapdos-008-025',
            magicandmonsters: 'https://magicandmonsters.com/products/krokorok-108-185-sword-shield-vivid-voltage',
            smokeandmirrors: 'https://smokeandmirrorshobby.com/products/jynx-ex-191-165-mew',
        };
        for (const [key, url] of Object.entries(samples)) {
            const store = storeFromHost(new URL(url).hostname);
            assert.equal(store.key, key);
            assert.ok(productKeyFromHref(store, url), url);
        }
    });
});

// ─── deriveMark ──────────────────────────────────────────────────────────────

const printing = (subType, extra = {}) => ({
    subType,
    isReverse: subType === 'Reverse Holofoil',
    market: 10,
    low: 8,
    mid: 9,
    marketUpdatedAt: '2026-11-01T00:00:00Z',
    flimsyMarket: false,
    trend: null,
    here: null,
    bestElsewhere: null,
    boughtAt: null,
    ...extra,
});

const here = (extra = {}) => ({
    priceUsd: 11, landedUsd: 11, diffPct: -0.08, stock: 2, condition: 'Near Mint',
    seenAt: '2026-11-03T00:00:00Z', active: true, belowLow: false, ...extra,
});

const result = (extra = {}, card = {}) => ({
    status: 'ok',
    via: 'url',
    card: { productId: 100, groupId: 5, name: 'Abra', setName: 'Set', number: '1/10', rarity: 'Rare', language: 'en', ...card },
    printings: [printing('Normal'), printing('Reverse Holofoil', { market: 20 })],
    ...extra,
});

const own = ({ normal = null, reverse = null, important = {}, mapped = true, ownKnown = true, meta = null } = {}) => ({
    rows: { 0: normal, 1: reverse },
    important: { 0: important[0] || null, 1: important[1] || null },
    meta,
    mapped,
    ownKnown,
});

describe('climbToCards', () => {
    // A node is just its parent: all the walk knows about the DOM.
    const node = (parent = null) => ({ parent });
    const walk = (links) => core.climbToCards(links, (el) => el.parent);

    test('two links of one product in a card stop at the card, under the grid', () => {
        const grid = node(node());
        const cardA = node(grid);
        const cardB = node(grid);
        const photo = node(node(cardA));
        const title = node(cardA);
        const other = node(cardB);
        const out = walk([
            { link: photo, key: 'a' },
            { link: title, key: 'a' },
            { link: other, key: 'b' },
        ]);
        assert.deepEqual(out.map((o) => o.top), [cardA, cardA, cardB]);
        assert.deepEqual(out.map((o) => o.key), ['a', 'a', 'b']);
    });

    test('a link directly in the grid is its own card', () => {
        const grid = node();
        const a = node(grid);
        const b = node(grid);
        const out = walk([
            { link: a, key: 'a' },
            { link: b, key: 'b' },
        ]);
        assert.deepEqual(out.map((o) => o.top), [a, b]);
    });

    test('a lone product climbs to the top of the document', () => {
        // Why findCards needs looksLikePage on top of the walk.
        const root = node();
        const wrapper = node(root);
        const one = node(wrapper);
        const two = node(wrapper);
        const out = walk([
            { link: one, key: 'a' },
            { link: two, key: 'a' },
        ]);
        assert.equal(out[0].top, root);
        assert.equal(out[1].top, root);
    });

    test('mixing stops at the first shared ancestor whatever the order of the links', () => {
        const grid = node(node());
        const rowOne = node(grid);
        const rowTwo = node(grid);
        const a = node(node(rowOne));
        const b = node(node(rowOne));
        const c = node(node(rowTwo));
        const out = walk([
            { link: c, key: 'c' },
            { link: a, key: 'a' },
            { link: b, key: 'b' },
        ]);
        assert.deepEqual(out.map((o) => o.top), [rowTwo, a.parent, b.parent]);
    });

    test('no links, no cards', () => {
        assert.deepEqual(walk([]), []);
    });
});

describe('deriveMark states', () => {
    test('unknown: missing result, status unknown or no card', () => {
        for (const missing of [undefined, null, { status: 'unknown', card: null, printings: [] }, { status: 'ok', card: null }]) {
            const mark = deriveMark(missing, own({ normal: { stock: 3 } }));
            assert.equal(mark.state, 'unknown');
            assert.equal(mark.title, null);
        }
    });

    test('loading: ownKnown false never says "no la tenés", whatever else is there', () => {
        const owns = [
            own({ ownKnown: false }),
            own({ ownKnown: false, mapped: false }),
            own({ ownKnown: false, normal: { stock: 3 } }),
            own({ ownKnown: false, important: { 0: { sold: 5 } } }),
            null,
            undefined,
            {},
        ];
        for (const value of owns) {
            const mark = deriveMark(result(), value);
            assert.equal(mark.state, 'loading');
            assert.doesNotMatch(mark.title, /no la ten/i);
            assert.doesNotMatch(mark.title, /tenés/i);
        }
    });

    test('loading still carries the market, which does not depend on own data', () => {
        assert.equal(deriveMark(result(), own({ ownKnown: false })).market.value, 10);
    });

    test('have: plain', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 3, price: 12.9 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, 'Tenés 3');
        assert.equal(mark.badge, '3');
        assert.deepEqual(mark.counts, { normal: 3, reverse: 0 });
        assert.equal(mark.langNote, null);
        assert.equal(mark.price, 12.9);
    });

    test('have: normal and reverse are separate', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 3 }, reverse: { stock: 1 } }));
        assert.equal(mark.title, 'Tenés 3 + 1 rev');
        assert.equal(mark.badge, '3+1R');
        assert.deepEqual(mark.counts, { normal: 3, reverse: 1 });
    });

    test('have: only reverse', () => {
        const mark = deriveMark(result(), own({ reverse: { stock: 2 } }));
        assert.equal(mark.title, 'Tenés 2 rev');
        assert.deepEqual(mark.counts, { normal: 0, reverse: 2 });
    });

    test('have: only Spanish copies read "1 ES", not "Tenés 1"', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 1, byLang: { es: 1 } } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, '1 ES');
        assert.equal(mark.badge, '1 ES');
        assert.doesNotMatch(mark.title, /tenés/i);
        assert.equal(mark.langNote, '1 ES');
    });

    test('have: Spanish copies only visible in byLang (printing with no TcgpPrices row, count 0)', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 0, byLang: { es: 2 } } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, '2 ES');
        assert.equal(mark.counts.normal, 2);
    });

    test('have: count and count_by_lang disagree, the larger wins', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 2, byLang: { en: 2, jumbo: 1 } } }));
        assert.equal(mark.counts.normal, 3);
        assert.equal(mark.title, 'Tenés 2 + 1 Jumbo');
        assert.equal(mark.langNote, '2 EN + 1 Jumbo');
    });

    test('have: English plus Spanish spells out both', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 3, byLang: { en: 2, es: 1 } } }));
        assert.equal(mark.title, 'Tenés 2 + 1 ES');
        assert.equal(mark.langNote, '2 EN + 1 ES');
    });

    test('have: Spanish in normal and reverse', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 1, byLang: { es: 1 } }, reverse: { stock: 1, byLang: { es: 1 } } }));
        assert.equal(mark.title, '1 ES + 1 ES rev');
        assert.deepEqual(mark.counts, { normal: 1, reverse: 1 });
    });

    test('have: Japanese copies of a Japanese card are its own language', () => {
        const ja = result({}, { language: 'ja' });
        const mark = deriveMark(ja, own({ normal: { stock: 2, byLang: { jap: 2 } } }));
        assert.equal(mark.title, 'Tenés 2');
        assert.equal(mark.langNote, null);
        assert.equal(deriveMark(ja, own({ normal: { stock: 2 } })).title, 'Tenés 2');
    });

    test('have: Japanese copies on an English product are spelled out', () => {
        assert.equal(deriveMark(result(), own({ normal: { stock: 2, byLang: { jap: 2 } } })).title, '2 JP');
    });

    test('have: only the vault reads "en el vault"', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 2, hidden: 2 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, '2 en el vault');
        assert.equal(mark.badge, 'Vault');
        assert.doesNotMatch(mark.title, /tenés/i);
        assert.equal(mark.vault, 2);
    });

    test('have: vault across printings, and hidden without a count', () => {
        assert.equal(deriveMark(result(), own({ normal: { stock: 1, hidden: 1 }, reverse: { stock: 1, hidden: 1 } })).title, '2 en el vault');
        assert.equal(deriveMark(result(), own({ normal: { hidden: 1 } })).title, '1 en el vault');
    });

    test('have: part in the vault keeps the count and spells the vault in the note', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 3, hidden: 1 } }));
        assert.equal(mark.title, 'Tenés 3');
        assert.equal(mark.langNote, '1 en el vault');
    });

    test('have: conditions other than NM are spelled out', () => {
        assert.equal(deriveMark(result(), own({ normal: { stock: 3, byCondition: { NM: 2, LP: 1 } } })).conditionNote, '2 NM + 1 LP');
        assert.equal(deriveMark(result(), own({ normal: { stock: 3, byCondition: { NM: 3 } } })).conditionNote, null);
    });

    test('negative counts are not stock', () => {
        const mark = deriveMark(result(), own({ normal: { stock: -2 } }));
        assert.equal(mark.state, 'none');
        assert.equal(mark.title, 'No la tenés');
        assert.deepEqual(mark.counts, { normal: 0, reverse: 0 });
    });

    test('a negative unit in a breakdown does not eat the positive ones', () => {
        const mark = deriveMark(result(), own({ normal: { stock: -1, byLang: { en: -1, es: 2 } } }));
        assert.equal(mark.counts.normal, 2);
        assert.equal(mark.title, '2 ES');
    });

    test('a row with every zero field omitted is stock 0', () => {
        assert.equal(deriveMark(result(), own({ normal: {} })).state, 'none');
    });

    test('unmapped: zero stock on a set outside the map', () => {
        const mark = deriveMark(result(), own({ mapped: false }));
        assert.equal(mark.state, 'unmapped');
        assert.equal(mark.title, 'Set sin mapear');
        assert.doesNotMatch(mark.title, /no la ten/i);
    });

    test('wanted: wishlist is of the card, both rows carry it and it does not double', () => {
        const mark = deriveMark(result(), own({ normal: { wishlist: 2 }, reverse: { wishlist: 2 } }));
        assert.equal(mark.state, 'wanted');
        assert.equal(mark.wishlist, 2);
        assert.equal(mark.title, 'Falta · 2 en wishlist');
    });

    test('reorder: with lifetime sales, from the important map when the feed has no soldTotal', () => {
        const mark = deriveMark(result(), own({ important: { 0: { sold: 3, clients: 1, last: '2026-03-01T00:00:00Z' }, 1: { sold: 2, clients: 1, last: '2026-05-01T00:00:00Z' } } }));
        assert.equal(mark.state, 'reorder');
        assert.equal(mark.sold.total, 5);
        assert.equal(mark.sold.last, '2026-05-01T00:00:00Z');
        assert.equal(mark.title, 'Reponer · vendiste 5');
        assert.match(mark.note, /web/);
    });

    test('none: plain', () => {
        const mark = deriveMark(result(), own());
        assert.equal(mark.state, 'none');
        assert.equal(mark.title, 'No la tenés');
        assert.equal(mark.note, null);
    });

    test('none: recent sales, and they say web', () => {
        assert.equal(deriveMark(result(), own({ normal: { sold90: 1, sold180: 2 } })).note, 'Vendiste 1 en 90 días (web)');
        assert.equal(deriveMark(result(), own({ normal: { sold180: 2 } })).note, 'Vendiste 2 en 180 días (web)');
    });

    test('mapped null with no stock: "No figura en tu stock", "?" and never the 0 of "No la tenés"', () => {
        for (const mapped of [null, undefined]) {
            const mark = deriveMark(result(), { ...own(), mapped });
            assert.equal(mark.state, 'unmapped');
            assert.equal(mark.title, 'No figura en tu stock');
            assert.equal(mark.badge, '?');
            assert.match(mark.note, /no se puede saber/i);
        }
    });

    test('mapped null keeps the recent sales in the note', () => {
        assert.equal(deriveMark(result(), own({ mapped: null, normal: { sold90: 2 } })).note, 'Vendiste 2 en 90 días (web)');
    });

    test('mapped null with stock is still "Tenés"', () => {
        const mark = deriveMark(result(), own({ mapped: null, normal: { stock: 2 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, 'Tenés 2');
    });

    test('only mapped true can say "No la tenés"', () => {
        assert.equal(deriveMark(result(), own({ mapped: true })).title, 'No la tenés');
        assert.equal(deriveMark(result(), own({ mapped: true })).badge, '0');
        assert.equal(deriveMark(result(), own({ mapped: false })).title, 'Set sin mapear');
    });
});

describe('deriveMark: the printing of the listing', () => {
    const REV = 'Reverse Holofoil';
    const reverseListing = (extra = {}) =>
        result({ printings: [printing('Normal'), printing(REV, { market: 20, here: here({ priceUsd: 19 }) })], ...extra });
    const normalListing = (extra = {}) =>
        result({ printings: [printing('Normal', { here: here({ priceUsd: 5 }) }), printing(REV, { market: 20 })], ...extra });

    test('no offer here: the printing the listing names is the one shown', () => {
        const mark = deriveMark(result({ printing: REV }), own());
        assert.equal(mark.market.printing, REV);
        assert.equal(mark.market.value, 20);
    });

    test('no offer here and a named printing the product does not have: no market of another printing', () => {
        const mark = deriveMark(result({ printing: REV, printings: [printing('Holofoil', { market: 15 })] }), own());
        assert.equal(mark.market, null);
        assert.equal(mark.printingMissing, REV);
    });

    test('no name and no offer: the first non reverse, as always', () => {
        assert.equal(deriveMark(result(), own()).market.printing, 'Normal');
    });

    test('an offer here beats the name', () => {
        assert.equal(deriveMark(normalListing({ printing: REV }), own()).market.printing, 'Normal');
    });

    test('a reverse listing and only normal copies: state have, and the title says which', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 1 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.otherPrintingOnly, true);
        assert.equal(mark.title, 'Tenés 1 normal, 0 rev');
        assert.equal(mark.badge, '1+0R');
        assert.deepEqual(mark.counts, { normal: 1, reverse: 0 });
        assert.equal(mark.reorderNote, null);
    });

    test('a normal listing and only reverse copies', () => {
        const mark = deriveMark(normalListing(), own({ reverse: { stock: 1 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.otherPrintingOnly, true);
        assert.equal(mark.title, 'Tenés 0 normal, 1 rev');
        assert.equal(mark.badge, '0+1R');
    });

    test('the printing can come from result.printing, with no offer here (a CSI row by title)', () => {
        const mark = deriveMark(result({ printing: REV }), own({ normal: { stock: 2 } }));
        assert.equal(mark.otherPrintingOnly, true);
        assert.equal(mark.title, 'Tenés 2 normal, 0 rev');
        const normal = deriveMark(result({ printing: 'Normal' }), own({ reverse: { stock: 2 } }));
        assert.equal(normal.title, 'Tenés 0 normal, 2 rev');
    });

    test('result.printing names a reverse the product does not list: still known', () => {
        const mark = deriveMark(result({ printing: REV, printings: [printing('Normal')] }), own({ normal: { stock: 1 } }));
        assert.equal(mark.otherPrintingOnly, true);
        assert.equal(mark.title, 'Tenés 1 normal, 0 rev');
    });

    test('an offer that is no longer active still says what the listing is', () => {
        const res = result({ printings: [printing(REV, { here: here({ active: false }) })] });
        assert.equal(deriveMark(res, own({ normal: { stock: 1 } })).otherPrintingOnly, true);
    });

    test('the Reponer note: that printing in important, with its own sales', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 1 }, important: { 1: { sold: 6, clients: 2 } } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.reorderNote, 'Reponer · vendiste 6');

        const noSales = deriveMark(normalListing(), own({ reverse: { stock: 1 }, important: { 0: { clients: 1 } } }));
        assert.equal(noSales.reorderNote, 'Reponer');
    });

    test('the other printing being important is no Reponer for this one', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 1 }, important: { 0: { sold: 6 } } }));
        assert.equal(mark.reorderNote, null);
    });

    test('this printing in stock is the plain title, no flag and no note', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 3 }, reverse: { stock: 1 }, important: { 1: { sold: 6 } } }));
        assert.equal(mark.otherPrintingOnly, false);
        assert.equal(mark.title, 'Tenés 3 + 1 rev');
        assert.equal(mark.reorderNote, null);
        assert.equal(deriveMark(normalListing(), own({ normal: { stock: 2 } })).otherPrintingOnly, false);
    });

    test('the printing not known: the plain title', () => {
        const mark = deriveMark(result(), own({ reverse: { stock: 2 } }));
        assert.equal(mark.otherPrintingOnly, false);
        assert.equal(mark.title, 'Tenés 2 rev');
    });

    test('no stock at all is not this case', () => {
        const mark = deriveMark(reverseListing(), own());
        assert.equal(mark.otherPrintingOnly, false);
        assert.equal(mark.state, 'none');
    });

    test('the other printing only in Spanish keeps the rule: no "Tenés"', () => {
        const normalEs = deriveMark(reverseListing(), own({ normal: { stock: 1, byLang: { es: 1 } } }));
        assert.equal(normalEs.title, '1 ES normal, 0 rev');
        assert.equal(normalEs.badge, '1 ES+0R');
        assert.equal(normalEs.langNote, '1 ES');
        const reverseEs = deriveMark(normalListing(), own({ reverse: { stock: 1, byLang: { es: 1 } } }));
        assert.equal(reverseEs.title, '0 normal, 1 ES rev');
        assert.equal(reverseEs.badge, '0+1 ES rev');
    });

    test('the other printing with both languages spells both', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 3, byLang: { en: 2, es: 1 } } }));
        assert.equal(mark.title, 'Tenés 2 + 1 ES normal, 0 rev');
        assert.equal(mark.badge, '2+1 ES+0R');
    });

    test('the other printing only in the vault says so', () => {
        const normalVault = deriveMark(reverseListing(), own({ normal: { stock: 2, hidden: 2 } }));
        assert.equal(normalVault.title, '2 normal en el vault, 0 rev');
        assert.equal(normalVault.badge, 'Vault');
        assert.equal(normalVault.otherPrintingOnly, true);
        const reverseVault = deriveMark(normalListing(), own({ reverse: { stock: 1, hidden: 1 } }));
        assert.equal(reverseVault.title, '0 normal, 1 rev en el vault');
    });

    test('a card with only the vault in English and Spanish on sale, other printing', () => {
        const mark = deriveMark(reverseListing(), own({ normal: { stock: 2, byLang: { en: 2, es: 1 }, hidden: 2 } }));
        assert.equal(mark.title, '1 ES normal, 0 rev');
        assert.match(mark.langNote, /2 en el vault/);
    });

    test('doubtful and otherPrintingOnly live together', () => {
        const mark = deriveMark(reverseListing({ status: 'doubtful' }), own({ normal: { stock: 1 } }));
        assert.equal(mark.doubtful, true);
        assert.equal(mark.otherPrintingOnly, true);
    });

    test('the unknown and the loading marks carry the fields too', () => {
        assert.equal(deriveMark(null, own()).otherPrintingOnly, false);
        assert.equal(deriveMark(null, own()).reorderNote, null);
        assert.equal(deriveMark(reverseListing(), own({ ownKnown: false, normal: { stock: 1 } })).otherPrintingOnly, false);
    });
});

describe('deriveMark: a printing the catalog lacks', () => {
    const REV_NAME = 'Reverse Holofoil';
    // What the real lookup answers for CoolStuffInc's "Blastoise - 31/149 (Non-Holo)" on 2026-11-04,
    // plus a trend and a best elsewhere (Thundurus has one) to see them go away.
    const TREND = { drop: 0.3, state: 'cae', peak: 30 };
    const BEST = { store: 'playerscandc', storeLabel: 'Players C&C', landedUsd: 3, diffPct: 0.3953, url: 'https://playerscandc.com/products/x', stock: null };
    const real = (printingAsked = 'Normal') => ({
        status: 'ok',
        via: 'title',
        card: { productId: 83896, groupId: 1408, name: 'Blastoise', setName: 'Boundaries Crossed', number: '31/149', rarity: 'Holo Rare', language: 'en' },
        printing: printingAsked,
        printings: [
            { subType: 'Holofoil', isReverse: false, market: 24.21, low: 9.07, mid: 15.44, marketUpdatedAt: '2026-11-04T13:27:09.113+00:00', flimsyMarket: false, trend: TREND, here: null, bestElsewhere: BEST, boughtAt: null },
            { subType: 'Reverse Holofoil', isReverse: true, market: 41.15, low: 28.16, mid: 62.99, marketUpdatedAt: '2026-11-04T13:27:09.113+00:00', flimsyMarket: false, trend: null, here: null, bestElsewhere: null, boughtAt: null },
        ],
    });

    test('no market, no trend, no best elsewhere: all of them belong to another printing', () => {
        const mark = deriveMark(real(), own());
        assert.equal(mark.printingMissing, 'Normal');
        assert.equal(mark.market, null);
        assert.equal(mark.trend, null);
        assert.equal(mark.bestElsewhere, null);
        assert.equal(mark.here, null);
    });

    test('the card and the state stay: it is still that card', () => {
        const mark = deriveMark(real(), own());
        assert.equal(mark.state, 'none');
        assert.equal(mark.title, 'No la tenés');
        assert.equal(mark.card.name, 'Blastoise');
        assert.equal(mark.doubtful, false);
    });

    test('the stock side still works, by the printing of the listing', () => {
        assert.equal(deriveMark(real(), own({ normal: { stock: 2 } })).title, 'Tenés 2');
        assert.equal(deriveMark(real(), own({ normal: { stock: 2 } })).otherPrintingOnly, false);

        const reverseOnly = deriveMark(real(), own({ reverse: { stock: 1 } }));
        assert.equal(reverseOnly.title, 'Tenés 0 normal, 1 rev');
        assert.equal(reverseOnly.otherPrintingOnly, true);
        assert.equal(reverseOnly.market, null);
    });

    test('a reverse listing where the catalog has no reverse', () => {
        const res = { ...real(REV_NAME), printings: [real().printings[0]] };
        const mark = deriveMark(res, own({ normal: { stock: 1 } }));
        assert.equal(mark.printingMissing, REV_NAME);
        assert.equal(mark.title, 'Tenés 1 normal, 0 rev');
        assert.equal(mark.market, null);
    });

    test('the web price is the one of the printing of the listing', () => {
        const stock = { normal: { stock: 1, price: 5 }, reverse: { stock: 1, price: 9 } };
        assert.equal(deriveMark(real(), own(stock)).price, 5);
        const res = { ...real(REV_NAME), printings: [real().printings[0]] };
        assert.equal(deriveMark(res, own(stock)).price, 9);
    });

    test('a printing that is in the catalog is not missing', () => {
        const mark = deriveMark(real('Holofoil'), own());
        assert.equal(mark.printingMissing, null);
        assert.equal(mark.market.value, 24.21);
        assert.deepEqual(mark.trend, TREND);
        assert.deepEqual(mark.bestElsewhere, BEST);
    });

    test('a listing that names nothing is not missing either', () => {
        const mark = deriveMark(real(null), own());
        assert.equal(mark.printingMissing, null);
        assert.equal(mark.market.printing, 'Holofoil');
    });

    test('an offer here settles it, whatever the name says', () => {
        const res = real();
        res.printings[0].here = here({ priceUsd: 20 });
        const mark = deriveMark(res, own());
        assert.equal(mark.printingMissing, null);
        assert.equal(mark.market.printing, 'Holofoil');
    });

    test('no printings at all and a name: missing too, and nothing breaks', () => {
        const mark = deriveMark({ ...real(), printings: [] }, own());
        assert.equal(mark.printingMissing, 'Normal');
        assert.equal(mark.market, null);
    });

    test('still loading: no market either', () => {
        const mark = deriveMark(real(), own({ ownKnown: false }));
        assert.equal(mark.state, 'loading');
        assert.equal(mark.market, null);
    });

    test('the unknown mark carries the field', () => {
        assert.equal(deriveMark(null, own()).printingMissing, null);
    });

    test('the line of the details', () => {
        assert.equal(core.missingPrintingText('Normal'), 'TCGplayer no lista la versión Normal');
        assert.equal(core.missingPrintingText('Reverse Holofoil'), 'TCGplayer no lista la versión Reverse');
        assert.equal(core.missingPrintingText('Holofoil'), 'TCGplayer no lista la versión Holofoil');
        assert.equal(core.missingPrintingText('1st Edition'), 'TCGplayer no lista la versión 1st Edition');
        assert.equal(core.missingPrintingText(null), '');
    });
});

describe('deriveMark: price of the shown printing only', () => {
    test('product 208304: shown Normal, only the reverse has a price, no price', () => {
        const mark = deriveMark(result(), own({ reverse: { stock: 1, price: 0.9 } }));
        assert.equal(mark.market.printing, 'Normal');
        assert.equal(mark.price, null);
    });

    test('shown reverse, only the normal has a price, no price', () => {
        const res = result({ printings: [printing('Normal'), printing('Reverse Holofoil', { here: here() })] });
        assert.equal(deriveMark(res, own({ normal: { stock: 1, price: 11 } })).price, null);
    });

    test('each printing reads its own', () => {
        const rows = own({ normal: { stock: 1, price: 11 }, reverse: { stock: 1, price: 22 } });
        assert.equal(deriveMark(result(), rows).price, 11);
        assert.equal(deriveMark(result({ printing: 'Reverse Holofoil' }), rows).price, 22);
    });
});

describe('deriveMark: vault with other languages on top', () => {
    test('product 676077: the two English in the vault and one ES on sale is not "Tenés"', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 2, byLang: { en: 2, es: 1 }, hidden: 2 } }));
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, '1 ES + 2 en el vault');
        assert.doesNotMatch(mark.title, /^Tenés/);
        assert.equal(mark.badge, '1 ES');
        assert.equal(mark.langNote, '2 EN + 1 ES · 2 en el vault');
        assert.equal(mark.vault, 2);
        assert.equal(mark.counts.normal, 3);
    });

    test('more hidden than native units: the title does not count anything twice', () => {
        const mark = deriveMark(result(), own({ normal: { byLang: { en: 1, es: 2 }, hidden: 2 } }));
        assert.equal(mark.title, '2 ES + 1 en el vault');
    });

    test('one printing all in the vault and the other on sale: "Tenés" what is on sale', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 2, hidden: 2 }, reverse: { stock: 1 } }));
        assert.equal(mark.title, 'Tenés 1 rev + 2 en el vault');
        assert.equal(mark.badge, '1R');
    });

    test('part in the vault with other languages keeps the count', () => {
        const mark = deriveMark(result(), own({ normal: { stock: 3, byLang: { en: 3, es: 1 }, hidden: 1 } }));
        assert.equal(mark.title, 'Tenés 3 + 1 ES');
        assert.equal(mark.langNote, '3 EN + 1 ES · 1 en el vault');
    });

    test('a hidden Spanish copy with no native ones does not invent a vault in the title', () => {
        const mark = deriveMark(result(), own({ normal: { byLang: { es: 2 }, hidden: 1 } }));
        assert.equal(mark.title, '2 ES');
        assert.equal(mark.langNote, '2 ES · 1 en el vault');
    });
});

describe('deriveMark precedence', () => {
    const everything = {
        normal: { stock: 1, wishlist: 2 },
        important: { 0: { sold: 5 } },
        mapped: false,
        ownKnown: true,
    };

    test('unknown beats loading', () => {
        assert.equal(deriveMark(null, own({ ownKnown: false })).state, 'unknown');
    });
    test('loading beats have', () => {
        assert.equal(deriveMark(result(), { ...own(everything), ownKnown: false }).state, 'loading');
    });
    test('have beats unmapped, wanted and reorder', () => {
        assert.equal(deriveMark(result(), own(everything)).state, 'have');
    });
    test('unmapped beats wanted and reorder', () => {
        assert.equal(deriveMark(result(), own({ ...everything, normal: { stock: 0, wishlist: 2 } })).state, 'unmapped');
    });
    test('mapped null beats wanted and reorder as well: "Falta" asserts the same thing as "No la tenés"', () => {
        const mark = deriveMark(result(), own({ ...everything, mapped: null, normal: { stock: 0, wishlist: 2 } }));
        assert.equal(mark.state, 'unmapped');
        assert.equal(mark.title, 'No figura en tu stock');
        assert.equal(mark.wishlist, 2, 'the number is still there for the details');
    });
    test('wanted beats reorder', () => {
        assert.equal(deriveMark(result(), own({ ...everything, normal: { wishlist: 2 }, mapped: true })).state, 'wanted');
    });
    test('reorder beats none', () => {
        assert.equal(deriveMark(result(), own({ important: { 1: { sold: 1 } } })).state, 'reorder');
    });
});

describe('deriveMark details', () => {
    test('doubtful keeps the state in every case', () => {
        const doubtful = result({ status: 'doubtful' });
        for (const [value, state] of [
            [own({ normal: { stock: 1 } }), 'have'],
            [own({ mapped: false }), 'unmapped'],
            [own({ normal: { wishlist: 1 } }), 'wanted'],
            [own({ important: { 0: { sold: 1 } } }), 'reorder'],
            [own(), 'none'],
            [own({ ownKnown: false }), 'loading'],
        ]) {
            const mark = deriveMark(doubtful, value);
            assert.equal(mark.state, state);
            assert.equal(mark.doubtful, true);
            assert.equal(mark.doubtfulNote, '¿Es esta carta?');
        }
        assert.equal(deriveMark(result(), own()).doubtful, false);
    });

    test('a product with only a reverse offer here shows the reverse market and here', () => {
        const res = result({
            printings: [printing('Normal'), printing('Reverse Holofoil', { market: 20, here: here({ priceUsd: 19 }) })],
        });
        const mark = deriveMark(res, own({ normal: { stock: 2, price: 11 }, reverse: { price: 22 } }));
        assert.equal(mark.market.value, 20);
        assert.equal(mark.market.printing, 'Reverse Holofoil');
        assert.equal(mark.here.priceUsd, 19);
        assert.equal(mark.here.isReverse, true);
        assert.equal(mark.price, 22);
        assert.deepEqual(mark.counts, { normal: 2, reverse: 0 });
    });

    test('with no offer here the market is the first non reverse with a market', () => {
        const res = result({ printings: [printing('Reverse Holofoil', { market: 20 }), printing('Holofoil', { market: 15 }), printing('1st Edition', { market: 40 })] });
        const mark = deriveMark(res, own());
        assert.equal(mark.market.printing, 'Holofoil');
        assert.equal(mark.market.value, 15);
        assert.equal(mark.here, null);
    });

    test('a card that only exists as reverse still shows its market', () => {
        const mark = deriveMark(result({ printings: [printing('Reverse Holofoil', { market: 20 })] }), own());
        assert.equal(mark.market.value, 20);
    });

    test('Normal and Reverse offered at one url: normal first, an inactive one last', () => {
        const both = [printing('Normal', { here: here({ priceUsd: 5 }) }), printing('Reverse Holofoil', { here: here({ priceUsd: 7 }) })];
        assert.equal(deriveMark(result({ printings: both }), own()).here.priceUsd, 5);

        const normalGone = [printing('Normal', { here: here({ priceUsd: 5, active: false }) }), printing('Reverse Holofoil', { here: here({ priceUsd: 7 }) })];
        assert.equal(deriveMark(result({ printings: normalGone }), own()).here.priceUsd, 7);
    });

    test('flimsy market travels with the shown printing', () => {
        const res = result({ printings: [printing('Normal', { market: 40, mid: 9, flimsyMarket: true })] });
        const mark = deriveMark(res, own());
        assert.equal(mark.market.flimsy, true);
        assert.equal(mark.market.value, 40);
        assert.equal(deriveMark(result(), own()).market.flimsy, false);
    });

    test('here keeps seen date, active flag, below-low and a null stock as null', () => {
        const res = result({ printings: [printing('Normal', { here: here({ stock: null, active: false, belowLow: true }) })] });
        const mark = deriveMark(res, own());
        assert.equal(mark.here.stock, null);
        assert.equal(mark.here.active, false);
        assert.equal(mark.here.belowLow, true);
        assert.equal(mark.here.seenAt, '2026-11-03T00:00:00Z');
    });

    test('here.stale and here.ageDays pass through, and an old answer without them reads fresh', () => {
        const old = result({ printings: [printing('Normal', { here: here({ stale: true, ageDays: 77 }) })] });
        const mark = deriveMark(old, own());
        assert.equal(mark.here.stale, true);
        assert.equal(mark.here.ageDays, 77);

        const plain = deriveMark(result({ printings: [printing('Normal', { here: here() })] }), own());
        assert.equal(plain.here.stale, false);
        assert.equal(plain.here.ageDays, null);
    });

    test('trend, bestElsewhere, boughtAt and meta pass through', () => {
        const trend = { drop: 0.24, state: null, peak: 16.3 };
        const best = { store: 'gglehi', storeLabel: 'GG Lehi', landedUsd: 9.5, diffPct: -0.2, url: 'x', stock: null };
        const res = result({ printings: [printing('Normal', { trend, bestElsewhere: best, boughtAt: '2026-01-01T00:00:00Z' })] });
        const mark = deriveMark(res, own({ meta: { name: 'Deck', share: 0.1 } }));
        assert.deepEqual(mark.trend, trend);
        assert.deepEqual(mark.bestElsewhere, best);
        assert.equal(mark.boughtAt, '2026-01-01T00:00:00Z');
        assert.equal(mark.meta.name, 'Deck');
    });

    test('boughtAt falls back to another printing', () => {
        const res = result({ printings: [printing('Normal'), printing('Reverse Holofoil', { boughtAt: '2026-02-01T00:00:00Z' })] });
        assert.equal(deriveMark(res, own()).boughtAt, '2026-02-01T00:00:00Z');
    });

    test('a card with no printings, as when the product lost its market', () => {
        const mark = deriveMark(result({ printings: [] }, { groupId: null }), own({ mapped: null }));
        assert.equal(mark.market, null);
        assert.equal(mark.here, null);
        assert.equal(mark.state, 'unmapped');
        assert.equal(mark.badge, '?');
    });
});

describe('formats', () => {
    test('formatUsd is Spanish', () => {
        assert.equal(formatUsd(12.4), 'US$ 12,40');
        assert.equal(formatUsd(12.9), 'US$ 12,90');
        assert.equal(formatUsd(1234.5), 'US$ 1.234,50');
        assert.equal(formatUsd(1234567), 'US$ 1.234.567,00');
        assert.equal(formatUsd(0), 'US$ 0,00');
        assert.equal(formatUsd('12.9'), 'US$ 12,90');
        assert.equal(formatUsd(-3), '-US$ 3,00');
        assert.equal(formatUsd(-0.001), 'US$ 0,00');
        for (const none of [null, undefined, '', 'abc', NaN]) assert.equal(formatUsd(none), '');
    });

    test('formatPct takes a fraction', () => {
        assert.equal(formatPct(-0.08), '-8 %');
        assert.equal(formatPct(0.12), '+12 %');
        assert.equal(formatPct(0.07), '+7 %');
        assert.equal(formatPct(0), '0 %');
        assert.equal(formatPct(-0.004), '0 %');
        for (const none of [null, undefined, '']) assert.equal(formatPct(none), '');
    });

    test('formatDate is day/month, with the year only when it is not this one', () => {
        const now = new Date(2026, 10, 4).getTime();
        assert.equal(formatDate(new Date(2026, 9, 12, 15).toISOString(), now), '12/10');
        assert.equal(formatDate('2026-10-12', now), '12/10');
        assert.equal(formatDate(new Date(2025, 9, 12, 15).toISOString(), now), '12/10/25');
        for (const none of [null, undefined, '', 'nope']) assert.equal(formatDate(none, now), '');
    });

    test('formatAge', () => {
        assert.equal(core.formatAge(10 * 1000), 'recién');
        assert.equal(core.formatAge(3 * MIN), 'hace 3 min');
        assert.equal(core.formatAge(2 * HOUR), 'hace 2 h');
        assert.equal(core.formatAge(24 * HOUR), 'hace 1 día');
        assert.equal(core.formatAge(96 * HOUR), 'hace 4 días');
    });
});

describe('shapeOwn and settings', () => {
    const snapshot = {
        own: { '100:0': { stock: 3 }, '100:1': { stock: 1 } },
        important: { '100:1': { sold: 5 } },
        meta: { 100: { name: 'Deck' } },
        mappedGroups: [5, 6],
    };

    test('reads both printings', () => {
        const shaped = shapeOwn(snapshot, { productId: 100, groupId: 5 });
        assert.deepEqual(shaped.rows, { 0: { stock: 3 }, 1: { stock: 1 } });
        assert.deepEqual(shaped.important, { 0: null, 1: { sold: 5 } });
        assert.deepEqual(shaped.meta, { name: 'Deck' });
        assert.equal(shaped.mapped, true);
        assert.equal(shaped.ownKnown, true);
    });

    test('a group outside the map is false, no map or no group is null', () => {
        assert.equal(shapeOwn(snapshot, { productId: 1, groupId: 9 }).mapped, false);
        assert.equal(shapeOwn({ ...snapshot, mappedGroups: null }, { productId: 1, groupId: 5 }).mapped, null);
        assert.equal(shapeOwn(snapshot, { productId: 1, groupId: null }).mapped, null);
    });

    test('own null or no snapshot is ownKnown false', () => {
        assert.equal(shapeOwn({ ...snapshot, own: null }, { productId: 100 }).ownKnown, false);
        assert.equal(shapeOwn(null, { productId: 100 }).ownKnown, false);
        assert.equal(shapeOwn(snapshot, null).ownKnown, true);
    });

    test('isOwnTooOld: past 48 h or with no date; no own data is not "too old", it is none', () => {
        const now = Date.UTC(2026, 10, 4);
        assert.equal(core.isOwnTooOld({ own: {}, ownAt: now - 48 * HOUR }, now), false);
        assert.equal(core.isOwnTooOld({ own: {}, ownAt: now - 48 * HOUR - 1 }, now), true);
        assert.equal(core.isOwnTooOld({ own: {} }, now), true);
        assert.equal(core.isOwnTooOld({ own: {}, ownAt: null }, now), true);
        assert.equal(core.isOwnTooOld({ own: null, ownAt: now - 90 * 24 * HOUR }, now), false);
        assert.equal(core.isOwnTooOld(null, now), false);
    });

    test('normalizeSettings defaults, validates and keeps fields of the content script', () => {
        assert.deepEqual(core.normalizeSettings(undefined), DEFAULTS);
        assert.deepEqual(core.normalizeSettings({ variant: 'z', enabled: false, panelOpen: true }), {
            ...DEFAULTS, enabled: false, panelOpen: true,
        });
    });

    test('the default look is "Decisión" (c), and a saved one wins', () => {
        assert.equal(core.normalizeSettings(undefined).variant, 'c');
        assert.equal(core.normalizeSettings({ variant: 'a' }).variant, 'a');
    });

    test('normalizeSettings: stores off are real store keys, once each', () => {
        assert.deepEqual(core.normalizeSettings({ disabledStores: ['wulfgaming', 'nope', 'wulfgaming', 'gglehi'] }).disabledStores, ['wulfgaming', 'gglehi']);
        assert.deepEqual(core.normalizeSettings({ disabledStores: 'wulfgaming' }).disabledStores, []);
    });

    test('normalizeSettings: panel corner, size and switches fall back when they are not one', () => {
        const odd = core.normalizeSettings({ panelCorner: 'middle', panelSize: 'huge', panelEnabled: 0, badge: 'no' });
        assert.equal(odd.panelCorner, 'bottom-left');
        assert.equal(odd.panelSize, 'normal');
        assert.equal(odd.panelEnabled, true);
        assert.equal(odd.badge, true);
        const off = core.normalizeSettings({ panelCorner: 'top-right', panelSize: 'large', panelEnabled: false, badge: false });
        assert.deepEqual([off.panelCorner, off.panelSize, off.panelEnabled, off.badge], ['top-right', 'large', false, false]);
    });

    test('normalizeSettings: dropped positions keep only good anchors of real stores, rounded', () => {
        const got = core.normalizeSettings({
            panelPositions: {
                gglehi: { h: 'right', x: 40.6, v: 'top', y: 90 },
                tcgplayer: { h: 'middle', x: 1, v: 'top', y: 1 },
                wulfgaming: { h: 'left', x: -5, v: 'bottom', y: 1 },
                nope: { h: 'left', x: 1, v: 'top', y: 1 },
                coolstuffinc: 'x',
            },
        });
        assert.deepEqual(got.panelPositions, { gglehi: { h: 'right', x: 41, v: 'top', y: 90 } });
        assert.deepEqual(core.normalizeSettings({ panelPositions: [] }).panelPositions, {});
    });

    test('normalizeSettings: a panelCollapsed that is not a boolean is dropped, so "auto" can be saved', () => {
        assert.equal('panelCollapsed' in core.normalizeSettings({ panelCollapsed: null }), false);
        assert.equal('panelCollapsed' in core.normalizeSettings({ panelCollapsed: 'x' }), false);
    });

    test('isStoreOn: on overall and not turned off for that store', () => {
        const settings = core.normalizeSettings({ disabledStores: ['wulfgaming'] });
        assert.equal(core.isStoreOn(settings, 'gglehi'), true);
        assert.equal(core.isStoreOn(settings, 'wulfgaming'), false);
        assert.equal(core.isStoreOn({ ...settings, enabled: false }, 'gglehi'), false);
        assert.equal(core.isStoreOn(null, 'gglehi'), false);
    });

    test('panelCollapsed: nothing chosen is undefined, not false, and a choice is kept', () => {
        assert.equal('panelCollapsed' in core.normalizeSettings(undefined), false);
        assert.equal('panelCollapsed' in core.normalizeSettings({ variant: 'b' }), false);
        assert.equal(core.normalizeSettings({ panelCollapsed: false }).panelCollapsed, false);
        assert.equal(core.normalizeSettings({ panelCollapsed: true }).panelCollapsed, true);
    });

    test('isPanelCollapsed: nothing chosen goes by the window, at 1000 px', () => {
        const none = core.normalizeSettings(undefined);
        assert.equal(core.isPanelCollapsed(none, 800), true);
        assert.equal(core.isPanelCollapsed(none, 999), true);
        assert.equal(core.isPanelCollapsed(none, 1000), false);
        assert.equal(core.isPanelCollapsed(none, 1440), false);
    });

    test('isPanelCollapsed: a saved choice wins, on any window', () => {
        assert.equal(core.isPanelCollapsed({ panelCollapsed: false }, 800), false);
        assert.equal(core.isPanelCollapsed({ panelCollapsed: true }, 1440), true);
    });

    test('isPanelCollapsed: something that is not a choice is no choice', () => {
        assert.equal(core.isPanelCollapsed({ panelCollapsed: null }, 800), true);
        assert.equal(core.isPanelCollapsed({ panelCollapsed: 'x' }, 1440), false);
        assert.equal(core.isPanelCollapsed(null, 800), true);
    });
});

describe('panel position', () => {
    const view = { width: 1440, height: 900 };
    const size = { width: 432, height: 600 };

    test('panelAnchor: where it was dropped on this store, else the corner of the options', () => {
        const settings = core.normalizeSettings({ panelCorner: 'top-right', panelPositions: { gglehi: { h: 'left', x: 300, v: 'top', y: 50 } } });
        assert.deepEqual(core.panelAnchor(settings, 'gglehi'), { h: 'left', x: 300, v: 'top', y: 50 });
        assert.deepEqual(core.panelAnchor(settings, 'tcgplayer'), { h: 'right', x: 16, v: 'top', y: 16 });
        assert.deepEqual(core.panelAnchor(core.normalizeSettings(null), 'tcgplayer'), { h: 'left', x: 16, v: 'bottom', y: 16 });
    });

    test('placeFromAnchor: each corner, measured from its own edges', () => {
        assert.deepEqual(core.placeFromAnchor({ h: 'left', x: 16, v: 'bottom', y: 16 }, size, view), { left: 16, top: 284 });
        assert.deepEqual(core.placeFromAnchor({ h: 'right', x: 16, v: 'top', y: 16 }, size, view), { left: 992, top: 16 });
        assert.deepEqual(core.placeFromAnchor({ h: 'right', x: 40, v: 'bottom', y: 30 }, size, view), { left: 968, top: 270 });
    });

    test('placeFromAnchor: always inside the window, 8 px from the edge', () => {
        // Dropped far right on a wide window, opened on a narrow one.
        assert.deepEqual(core.placeFromAnchor({ h: 'left', x: 1300, v: 'top', y: 700 }, size, view), { left: 1000, top: 292 });
        // Taller than the window: stuck to the top, where the head is.
        assert.deepEqual(core.placeFromAnchor({ h: 'left', x: 16, v: 'bottom', y: 16 }, { width: 432, height: 1200 }, view), { left: 16, top: 8 });
        // Not an anchor: the default corner.
        assert.deepEqual(core.placeFromAnchor(null, size, view), { left: 16, top: 284 });
    });

    test('anchorFromRect: held from the nearest side and end, and back to the same place', () => {
        const rect = { left: 980, top: 40, width: 432, height: 600 };
        const anchor = core.anchorFromRect(rect, view);
        assert.deepEqual(anchor, { h: 'right', x: 28, v: 'top', y: 40 });
        assert.deepEqual(core.placeFromAnchor(anchor, size, view), { left: 980, top: 40 });
        assert.deepEqual(core.anchorFromRect({ left: 20, top: 280, width: 432, height: 600 }, view), { h: 'left', x: 20, v: 'bottom', y: 20 });
    });

    test('anchorFromRect: a panel held from the right keeps its distance when the window narrows', () => {
        const anchor = core.anchorFromRect({ left: 980, top: 40, width: 432, height: 600 }, view);
        assert.deepEqual(core.placeFromAnchor(anchor, size, { width: 1100, height: 700 }), { left: 640, top: 40 });
    });
});

describe('badgeFor', () => {
    test('cards to buy, nothing at zero, and a cap', () => {
        assert.deepEqual(core.badgeFor({ buy: 3, auth: true }), { text: '3', kind: 'buy' });
        assert.deepEqual(core.badgeFor({ buy: 0, auth: true }), { text: '', kind: null });
        assert.deepEqual(core.badgeFor({ buy: 140 }), { text: '99+', kind: 'buy' });
    });

    test('no session wins over the count, and off is empty', () => {
        assert.deepEqual(core.badgeFor({ buy: 3, auth: false }), { text: '!', kind: 'login' });
        assert.deepEqual(core.badgeFor({ buy: 3, auth: false, on: false }), { text: '', kind: null });
        assert.deepEqual(core.badgeFor(), { text: '', kind: null });
    });
});

describe('shapeOwn: products a stock line could belong to', () => {
    const snapshot = (extra = {}) => ({
        own: { '100:0': { stock: 3 }, '100:1': { stock: 1 }, '300:0': { stock: 0 } },
        important: { '200:0': { sold: 5 } },
        meta: {},
        mappedGroups: [5],
        unsettled: [100, 200, 300],
        ...extra,
    });
    const asked = (productId, groupId = 5) => ({ productId, groupId });
    const markOf = (snap, productId, extra = {}) => deriveMark(result({ printings: [printing('Normal')] }, { productId, groupId: 5 }), { ...shapeOwn(snap, asked(productId)), ...extra });

    test('in the list: mapped is null even with the group in the map', () => {
        assert.equal(shapeOwn(snapshot(), asked(200)).mapped, null);
    });

    test('and also with the group out of the map: it cannot say "Set sin mapear" about a set that has lines', () => {
        assert.equal(shapeOwn(snapshot(), asked(200, 9)).mapped, null);
    });

    test('out of the list: the map decides, as always', () => {
        assert.equal(shapeOwn(snapshot(), asked(400)).mapped, true);
        assert.equal(shapeOwn(snapshot(), asked(400, 9)).mapped, false);
    });

    test('an id that came as text still counts', () => {
        assert.equal(shapeOwn(snapshot({ unsettled: ['200'] }), asked(200)).mapped, null);
    });

    test('no list, an empty list or an odd value: the map decides', () => {
        for (const unsettled of [undefined, null, [], 'x', 200]) {
            assert.equal(shapeOwn(snapshot({ unsettled }), asked(200)).mapped, true, String(unsettled));
        }
    });

    test('no card: nothing breaks and nothing is settled', () => {
        assert.equal(shapeOwn(snapshot(), null).mapped, null);
        assert.equal(shapeOwn(snapshot({ unsettled: [null] }), { productId: null, groupId: 5 }).mapped, true);
    });

    test('no rows: "No figura en tu stock", badge ?, never "No la tenés"', () => {
        const mark = markOf(snapshot(), 200);
        assert.equal(mark.state, 'unmapped');
        assert.equal(mark.title, 'No figura en tu stock');
        assert.equal(mark.badge, '?');
        assert.doesNotMatch(mark.title, /no la ten/i);
    });

    test('a row with no units reads the same', () => {
        assert.equal(markOf(snapshot(), 300).title, 'No figura en tu stock');
    });

    test('neither "Reponer" nor "Falta": they say it is not there', () => {
        assert.equal(markOf(snapshot(), 200).state, 'unmapped');
        const wanted = { ...snapshot(), own: { '200:0': { stock: 0, wishlist: 2 } } };
        assert.equal(markOf(wanted, 200).state, 'unmapped');
    });

    test('with stock it keeps "Tenés N"', () => {
        const mark = markOf(snapshot(), 100);
        assert.equal(mark.state, 'have');
        assert.equal(mark.title, 'Tenés 3 + 1 rev');
    });

    test('the same card out of the list does read "No la tenés"', () => {
        assert.equal(markOf(snapshot({ unsettled: [] }), 200).state, 'reorder');
        assert.equal(markOf(snapshot(), 400).title, 'No la tenés');
    });

    test('no own data is still loading, on the list or not', () => {
        assert.equal(markOf(snapshot({ own: null }), 200).state, 'loading');
    });
});

// ─── a fake browser ──────────────────────────────────────────────────────────

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const flush = async () => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const jsonRes = (data, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    url: '',
    json: async () => clone(data),
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** What outlives a service worker: storage, the clock, the network. */
function makeWorld({ storage = {}, onFetch } = {}) {
    const world = {
        now: Date.UTC(2026, 10, 4, 12),
        storage: clone(storage),
        calls: [],
        timers: [],
        onFetch,
        writes: [],
        failStorage: false,
        tabs: [],
        tabQueries: [],
        tabMessages: [],
        tick(ms) {
            world.now += ms;
            const due = world.timers.filter((t) => t.at <= world.now);
            world.timers = world.timers.filter((t) => t.at > world.now);
            due.forEach((t) => t.fn());
        },
        snapshotCalls: () => world.calls.filter((c) => c.url.endsWith('/extension/snapshot')),
        lookupCalls: () => world.calls.filter((c) => c.url.endsWith('/extension/lookup')),
    };
    return world;
}

function fakeChrome(world, listeners) {
    const local = {
        async get(keys) {
            if (world.failStorage) throw new Error('storage down');
            if (keys === null) return clone(world.storage);
            const list = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const key of list) if (key in world.storage) out[key] = clone(world.storage[key]);
            return out;
        },
        async set(items) {
            if (world.failStorage) throw new Error('storage down');
            world.writes.push(Object.keys(items));
            Object.assign(world.storage, clone(items));
        },
        async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete world.storage[key];
        },
        async getKeys() {
            return Object.keys(world.storage);
        },
    };
    return {
        storage: { local },
        runtime: {
            onMessage: { addListener: (fn) => listeners.push(fn) },
            getManifest: () => JSON.parse(read('manifest.json')),
        },
        downloads: { onDeterminingFilename: { addListener() {} } },
        tabs: {
            async query({ url }) {
                world.tabQueries.push(url);
                return world.tabs.filter((tab) => url.some((pattern) => tab.url.startsWith(pattern.slice(0, -1))));
            },
            sendMessage(tabId, message) {
                world.tabMessages.push({ tabId, message: clone(message) });
                const { fails } = world.tabs.find((tab) => tab.id === tabId);
                if (fails === 'throws') throw new Error('No tab with id');
                if (fails) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
                return Promise.resolve();
            },
        },
    };
}

function sandboxFor(world, listeners, logs = []) {
    class FakeDate extends Date {
        static now() {
            return world.now;
        }
    }
    let nextTimer = 1;
    return {
        chrome: fakeChrome(world, listeners),
        console: {
            log() {},
            warn: (...args) => logs.push(['warn', ...args]),
            error: (...args) => logs.push(['error', ...args]),
        },
        URL,
        AbortController,
        Date: FakeDate,
        setTimeout(fn, ms) {
            const id = nextTimer;
            nextTimer += 1;
            world.timers.push({ id, fn, at: world.now + ms });
            return id;
        },
        clearTimeout(id) {
            world.timers = world.timers.filter((t) => t.id !== id);
        },
        fetch(url, init = {}) {
            world.calls.push({ url, init, items: init.body ? JSON.parse(init.body).items : null });
            return world.onFetch(url, init);
        },
    };
}

/** One service worker life: both real files in a brand new context. */
function bootWorker(world) {
    const listeners = [];
    const context = vm.createContext(sandboxFor(world, listeners));
    vm.runInContext(read('scripts/lib/shop-core.js'), context, { filename: 'shop-core.js' });
    vm.runInContext(read('scripts/lib/shop-data.js'), context, { filename: 'shop-data.js' });
    assert.equal(listeners.length, 1);
    const listener = listeners[0];

    return {
        listener,
        send(message) {
            return new Promise((resolve) => {
                listener(clone(message), {}, (answer) => resolve(clone(answer)));
            });
        },
    };
}

const CARD = { productId: 100, groupId: 5, name: 'Abra', language: 'en' };
const resolved = (card = CARD) => ({ status: 'ok', via: 'url', card, printings: [printing('Normal')] });
const unknownResult = { status: 'unknown', via: null, card: null, printings: [] };

const freshSnapshot = (world, extra = {}) => ({
    fetchedAt: world.now,
    ownAt: world.now,
    generatedAt: '2026-11-04T00:00:00Z',
    own: { '100:0': { stock: 3 } },
    mappedGroups: [5],
    important: {},
    meta: {},
    warnings: [],
    ...extra,
});

const serverSnapshot = (stock = 9, extra = {}) => ({
    generatedAt: '2026-11-04T12:00:00Z',
    own: { '100:0': { stock } },
    mappedGroups: [5],
    important: {},
    meta: {},
    warnings: [],
    ...extra,
});

/** Answers every lookup item with a resolved card, or what `pick(item)` says. */
const lookupOk = (init, pick = () => resolved()) => {
    const { items } = JSON.parse(init.body);
    const results = {};
    for (const item of items) results[item.key] = pick(item);
    return jsonRes({ generatedAt: 'x', results });
};

const item = (key = '/products/abra', store = 'wulfgaming', extra = {}) => ({
    key,
    store,
    url: `https://${store}.example${key}`,
    ...extra,
});

const worldWithSnapshot = (extra, onFetch) => {
    const world = makeWorld({ onFetch });
    world.storage['shop:snapshot'] = freshSnapshot(world, extra);
    return world;
};

const defaultFetch = (snapshotData = serverSnapshot()) => (url, init) =>
    url.endsWith('/snapshot') ? jsonRes(snapshotData) : lookupOk(init);

const STORE_TAB = { id: 1, url: 'https://wulfgaming.com/collections/pokemon' };
const snapshotNotice = (tabId = 1) => ({ tabId, message: { type: 'shop:changed', what: 'snapshot' } });

// ─── the data layer ──────────────────────────────────────────────────────────

describe('shop-data: snapshot freshness', () => {
    test('stale snapshot: answers right away from it and refreshes in the background', async () => {
        const gate = deferred();
        const world = worldWithSnapshot({}, (url, init) => (url.endsWith('/snapshot') ? gate.promise : lookupOk(init)));
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        world.storage['shop:snapshot'].ownAt = world.now - 16 * MIN;
        world.tabs.push(STORE_TAB);
        const worker = bootWorker(world);

        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });

        // The snapshot fetch is still hanging and the answer already came, with the old data.
        assert.equal(world.snapshotCalls().length, 1);
        assert.equal(answer.ok, true);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 3);
        assert.equal(answer.status.refreshing, true);
        assert.deepEqual(world.tabMessages, []);

        world.now += 5000;
        gate.resolve(jsonRes(serverSnapshot(9)));
        await flush();

        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 9);
        assert.equal(world.storage['shop:snapshot'].fetchedAt, world.now);
        assert.deepEqual(world.tabMessages, [snapshotNotice()]);

        const second = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(second.marks['/products/abra'].own.rows[0].stock, 9);
        assert.equal(world.snapshotCalls().length, 1, 'a fresh snapshot is not asked for again');
        assert.equal(second.status.refreshing, false);
    });

    test('fresh snapshot: no fetch at all', async () => {
        const world = worldWithSnapshot({}, (url, init) => lookupOk(init));
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.snapshotCalls().length, 0);
    });

    test('just under 15 min is fresh, just over is stale', async () => {
        const world = worldWithSnapshot({}, defaultFetch());
        const worker = bootWorker(world);
        world.now += 15 * MIN - 1;
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 0);
        world.now += 2;
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('several tabs at once share one refresh', async () => {
        const gate = deferred();
        const world = makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? gate.promise : lookupOk(init)) });
        const worker = bootWorker(world);
        const answers = [1, 2, 3].map(() => worker.send({ type: 'shop-lookup', items: [item()] }));
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
        assert.equal(world.lookupCalls().length, 1);
        gate.resolve(jsonRes(serverSnapshot(4)));
        for (const answer of await Promise.all(answers)) {
            assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 4);
        }
    });

    test('with no snapshot it waits for the first one', async () => {
        const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(7)) });
        const worker = bootWorker(world);
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 7);
        assert.equal(world.storage['shop:snapshot'].fetchedAt, world.now);
    });
});

describe('shop-data: own data too old', () => {
    const DAY = 24 * HOUR;
    const oldSnapshot = (world, ageMs, extra = {}) => {
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - ageMs, ownAt: world.now - ageMs, ...extra });
        world.storage['shop:lookup:wulfgaming:/products/abra'] = { at: world.now, result: resolved() };
        return world;
    };
    const broken = () => jsonRes({}, 500);
    const brokenSnapshot = (url, init) => (url.endsWith('/snapshot') ? broken() : lookupOk(init));

    test('10 days old with the snapshot route down: loading, never "No la tenés", and the status says why', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: brokenSnapshot }), 10 * DAY, { own: { '999:0': { stock: 1 } } });
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        const mark = answer.marks['/products/abra'];

        assert.equal(mark.own.ownKnown, false);
        const derived = deriveMark(mark.result, mark.own);
        assert.equal(derived.state, 'loading');
        assert.doesNotMatch(derived.title, /no la ten/i);
        assert.equal(answer.status.ownTooOld, true);
        assert.equal(answer.status.ownKnown, false);
    });

    test('a row with stock: no old "Tenés 3" either, and nothing of the row reaches the mark', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: brokenSnapshot }), 3 * DAY);
        const mark = (await bootWorker(world).send({ type: 'shop-lookup', items: [item()] })).marks['/products/abra'];
        assert.deepEqual(mark.own.rows, { 0: null, 1: null });
        const derived = deriveMark(mark.result, mark.own);
        assert.equal(derived.state, 'loading');
        assert.equal(derived.counts.normal, 0);
    });

    test('48 h is still good, a millisecond more is not', async () => {
        const good = oldSnapshot(makeWorld({ onFetch: brokenSnapshot }), 48 * HOUR);
        const answer = await bootWorker(good).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.status.ownTooOld, false);

        const over = oldSnapshot(makeWorld({ onFetch: brokenSnapshot }), 48 * HOUR + 1);
        const late = await bootWorker(over).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(late.marks['/products/abra'].own.ownKnown, false);
        assert.equal(late.status.ownTooOld, true);
    });

    test('own data with no ownAt counts as absent', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: brokenSnapshot }), 0);
        delete world.storage['shop:snapshot'].ownAt;
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
        assert.equal(answer.status.ownTooOld, true);
    });

    test('a server that keeps answering own null does not make old data young', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: defaultFetch(serverSnapshot(0, { own: null, warnings: ['PA no contestó'] })) }), 3 * DAY);
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();

        const saved = world.storage['shop:snapshot'];
        assert.equal(saved.fetchedAt, world.now, 'the refresh did happen');
        assert.equal(saved.ownAt, world.now - 3 * DAY, 'the age is that of the own data');
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
        assert.equal(answer.status.ownTooOld, true);
    });

    test('expired session over old data: loading too, auth false for the login pill', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: () => jsonRes({}, 403) }), 30 * DAY);
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
        assert.equal(answer.status.ownTooOld, true);
        assert.equal(answer.status.auth, false);
    });

    test('a good refresh ends it and the tabs are told', async () => {
        let up = false;
        const world = oldSnapshot(
            makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? (up ? jsonRes(serverSnapshot(4)) : broken()) : lookupOk(init)) }),
            3 * DAY,
        );
        world.tabs.push(STORE_TAB);
        const worker = bootWorker(world);
        assert.equal((await worker.send({ type: 'shop-lookup', items: [item()] })).status.ownTooOld, true);
        assert.deepEqual(world.tabMessages, []);

        up = true;
        world.tick(31 * 1000);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.deepEqual(world.tabMessages, [snapshotNotice()]);

        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.status.ownTooOld, false);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 4);
    });

    test('the status answers it after a restart, with no call and no lookup', async () => {
        const world = oldSnapshot(makeWorld({ onFetch: () => assert.fail('no fetch') }), 3 * DAY);
        const answer = await bootWorker(world).send({ type: 'shop-status' });
        assert.equal(answer.status.ownTooOld, true);
        assert.equal(answer.status.ownKnown, false);
        assert.equal(answer.status.snapshotAgeMs, 3 * DAY);
    });

    test('no data at all is not "too old"', async () => {
        const world = makeWorld({ onFetch: () => assert.fail('no fetch') });
        const answer = await bootWorker(world).send({ type: 'shop-status' });
        assert.equal(answer.status.ownTooOld, false);
        assert.equal(answer.status.ownKnown, false);
    });
});

describe('shop-data: telling the tabs', () => {
    const WULF = { id: 1, url: 'https://wulfgaming.com/collections/pokemon' };
    const TCG = { id: 2, url: 'https://www.tcgplayer.com/search/pokemon/product' };
    const OTHER = { id: 3, url: 'https://fe.afip.gob.ar/rcel/jsp/index_bis.jsp' };

    test('a refresh tells every store tab, and only those', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        world.tabs.push(WULF, TCG, OTHER);
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.deepEqual(world.tabMessages, [snapshotNotice(1), snapshotNotice(2)]);
    });

    test('it asks for tabs with the matches of the manifest entry of the content script', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        await bootWorker(world).send({ type: 'shop-refresh' });
        const manifest = JSON.parse(read('manifest.json'));
        const entry = manifest.content_scripts.find((script) => script.js.includes('scripts/controllers/shop-marks.js'));
        assert.deepEqual(world.tabQueries, [entry.matches]);
    });

    test('a tab that does not answer or throws does not stop the others nor the answer', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        world.tabs.push({ ...WULF, fails: 'rejects' }, { ...TCG, fails: 'throws' }, { id: 4, url: 'https://store.gglehi.com/x' });
        const answer = await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(answer.ok, true);
        assert.deepEqual(world.tabMessages.map((m) => m.tabId), [1, 2, 4]);
    });

    test('tabs.query failing does not take the refresh down', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        const worker = bootWorker(world);
        const answer = await new Promise((resolve) => {
            world.tabs = null; // `.filter` of this throws inside the fake query
            worker.listener({ type: 'shop-refresh' }, {}, resolve);
        });
        assert.equal(answer.ok, true);
        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 9);
    });

    test('a failed refresh tells nobody', async () => {
        const world = makeWorld({ onFetch: () => jsonRes({}, 500) });
        world.tabs.push(WULF);
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.deepEqual(world.tabMessages, []);
    });

    test('shop-settings-changed passes it on as "settings"', async () => {
        const world = makeWorld({ onFetch: () => assert.fail('no fetch') });
        world.tabs.push(WULF, TCG, OTHER);
        const answer = await bootWorker(world).send({ type: 'shop-settings-changed' });
        assert.equal(answer.ok, true);
        assert.deepEqual(world.tabMessages, [
            { tabId: 1, message: { type: 'shop:changed', what: 'settings' } },
            { tabId: 2, message: { type: 'shop:changed', what: 'settings' } },
        ]);
    });

    test('nothing of the marks listens to storage changes, and the old key is gone', async () => {
        for (const file of ['scripts/lib/shop-data.js', 'scripts/controllers/shop-marks.js', 'scripts/popup.js']) {
            assert.doesNotMatch(read(file), /onChanged\.addListener/, file);
        }
        const world = makeWorld({ onFetch: defaultFetch() });
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(world.storage['shop:snapshotAt'], undefined);
    });
});

describe('shop-data: snapshot timeout', () => {
    // The fake fetch answers an abort the way the real one does.
    const hangUntilAbort = (url, init) =>
        new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });

    test('a refresh behind an answer gives up at 28 s, inside the life of the SW', async () => {
        const world = worldWithSnapshot({}, (url, init) => (url.endsWith('/snapshot') ? hangUntilAbort(url, init) : lookupOk(init)));
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();

        world.tick(28 * 1000 - 1);
        await flush();
        assert.equal((await worker.send({ type: 'shop-status' })).status.refreshing, true);

        world.tick(1);
        await flush();
        const { status } = await worker.send({ type: 'shop-status' });
        assert.equal(status.refreshing, false);
        assert.equal(status.error, 'timeout');
    });
});

describe('shop-data: own null with nothing saved', () => {
    const ownNull = serverSnapshot(0, { own: null, warnings: ['PA no contestó'] });

    test('one refresh every 5 min, however many lookups', async () => {
        const world = makeWorld({ onFetch: defaultFetch(ownNull) });
        const worker = bootWorker(world);
        // 9 x 30 s, all inside the 5 min. The retry window of a failure is 30 s, so this is not that one.
        for (let i = 0; i < 9; i += 1) {
            await worker.send({ type: 'shop-lookup', items: [] });
            world.tick(30 * 1000);
        }
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('the count survives a restart of the SW', async () => {
        const world = makeWorld({ onFetch: defaultFetch(ownNull) });
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        world.tick(40 * 1000);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        world.tick(40 * 1000);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('past 5 min it tries again, also after a restart', async () => {
        const world = makeWorld({ onFetch: defaultFetch(ownNull) });
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        world.tick(5 * MIN - 1);
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
        world.tick(2);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('it does not tell the tabs: nothing changed for them', async () => {
        const world = makeWorld({ onFetch: defaultFetch(ownNull) });
        world.tabs.push(STORE_TAB);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.deepEqual(world.tabMessages, []);
    });

    test('when own data finally comes, the tabs are told and marks work', async () => {
        let up = false;
        const world = makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? jsonRes(up ? serverSnapshot(2) : ownNull) : lookupOk(init)) });
        world.tabs.push(STORE_TAB);
        const worker = bootWorker(world);
        assert.equal((await worker.send({ type: 'shop-lookup', items: [item()] })).marks['/products/abra'].own.ownKnown, false);

        up = true;
        world.tick(5 * MIN + 1);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.deepEqual(world.tabMessages, [snapshotNotice()]);
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 2);
    });

    test('the popup button does not wait for the 5 min', async () => {
        const world = makeWorld({ onFetch: defaultFetch(ownNull) });
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await worker.send({ type: 'shop-refresh' });
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('with own data saved the normal 15 min stand: the server saying null does not change that', async () => {
        const world = worldWithSnapshot({}, defaultFetch(ownNull));
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
        world.tick(14 * MIN);
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
    });
});

describe('shop-data: which admin the caches came from', () => {
    const DEV = 'http://localhost:3000';
    const devAnswer = (url, init) =>
        url.endsWith('/snapshot')
            ? jsonRes(serverSnapshot(url.startsWith(DEV) ? 777 : 3))
            : lookupOk(init, () => resolved({ ...CARD, name: url.startsWith(DEV) ? 'DEV DATA' : 'Abra' }));

    const lookupThere = (worker) => worker.send({ type: 'shop-lookup', items: [item()] });

    test('dev answers do not outlive switching back to production', async () => {
        const world = makeWorld({ storage: { adminBase: DEV }, onFetch: devAnswer });
        const worker = bootWorker(world);
        const dev = await lookupThere(worker);
        assert.equal(dev.marks['/products/abra'].result.card.name, 'DEV DATA');
        assert.equal(dev.marks['/products/abra'].own.rows[0].stock, 777);

        delete world.storage.adminBase;
        const before = world.calls.length;
        const prod = await lookupThere(worker);
        assert.ok(world.calls.slice(before).some((call) => call.url.endsWith('/lookup')), 'asks production');
        assert.ok(world.calls.slice(before).some((call) => call.url.endsWith('/snapshot')), 'asks production');
        assert.equal(prod.marks['/products/abra'].result.card.name, 'Abra');
        assert.equal(prod.marks['/products/abra'].own.rows[0].stock, 3);
        assert.equal(world.calls.at(-1).url.startsWith(DEV), false);
    });

    test('the same after a restart of the SW', async () => {
        const world = makeWorld({ storage: { adminBase: DEV }, onFetch: devAnswer });
        await lookupThere(bootWorker(world));
        delete world.storage.adminBase;
        const prod = await lookupThere(bootWorker(world));
        assert.equal(prod.marks['/products/abra'].result.card.name, 'Abra');
        assert.equal(prod.marks['/products/abra'].own.rows[0].stock, 3);
    });

    test('and the other way around, with the session state of the other admin gone too', async () => {
        let prodAuth = false;
        const world = makeWorld({
            onFetch: (url, init) => (url.startsWith(DEV) || prodAuth ? devAnswer(url, init) : jsonRes({}, 403)),
        });
        const worker = bootWorker(world);
        assert.equal((await lookupThere(worker)).status.auth, false);

        world.storage.adminBase = DEV;
        const answer = await lookupThere(worker);
        assert.equal(answer.status.auth, true, 'the block of the other admin does not apply');
        assert.equal(answer.marks['/products/abra'].result.card.name, 'DEV DATA');
    });

    test('asked right after the switch, the status does not speak for the other admin', async () => {
        const world = makeWorld({ storage: { adminBase: DEV }, onFetch: () => jsonRes({}, 403) });
        const worker = bootWorker(world);
        assert.equal((await lookupThere(worker)).status.auth, false);

        delete world.storage.adminBase;
        const { status } = await worker.send({ type: 'shop-status' });
        assert.equal(status.auth, null);
        assert.equal(status.adminBase, 'https://cartas.konekotekka.com.ar');
    });

    test('other keys are not touched', async () => {
        const world = makeWorld({ storage: { adminBase: DEV, sales: { keep: true }, invoicing: { keep: true }, 'shop:settings': { variant: 'c' } }, onFetch: devAnswer });
        const worker = bootWorker(world);
        await lookupThere(worker);
        delete world.storage.adminBase;
        await lookupThere(worker);
        assert.deepEqual(world.storage.sales, { keep: true });
        assert.deepEqual(world.storage.invoicing, { keep: true });
        assert.deepEqual(world.storage['shop:settings'], { variant: 'c' });
    });

    test('the same admin keeps its caches, with or without a trailing slash', async () => {
        const world = makeWorld({ storage: { adminBase: DEV }, onFetch: devAnswer });
        const worker = bootWorker(world);
        await lookupThere(worker);
        const calls = world.calls.length;
        world.storage.adminBase = `${DEV}/`;
        await lookupThere(worker);
        await lookupThere(bootWorker(world));
        assert.equal(world.calls.length, calls);
    });

    test('a first run with nothing remembered keeps what is saved', async () => {
        const world = worldWithSnapshot({}, () => assert.fail('no fetch'));
        world.storage['shop:lookup:wulfgaming:/products/abra'] = { at: world.now, result: resolved() };
        const answer = await lookupThere(bootWorker(world));
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 3);
        assert.equal(world.storage['shop:cacheBase'], 'https://cartas.konekotekka.com.ar');
    });

    test('an answer of the old admin that lands after the switch is thrown away', async () => {
        const gate = deferred();
        const lookupGate = deferred();
        const world = makeWorld({
            storage: { adminBase: DEV },
            onFetch: (url, init) => {
                if (url.startsWith(DEV)) return url.endsWith('/snapshot') ? gate.promise : lookupGate.promise;
                return devAnswer(url, init);
            },
        });
        const worker = bootWorker(world);
        lookupThere(worker);
        await flush();
        assert.equal(world.calls.length, 2);

        delete world.storage.adminBase;
        const prod = await lookupThere(worker);
        assert.equal(prod.marks['/products/abra'].result.card.name, 'Abra');

        gate.resolve(jsonRes(serverSnapshot(777)));
        lookupGate.resolve(jsonRes({ results: { 'wulfgaming:/products/abra': resolved({ ...CARD, name: 'DEV DATA' }) } }));
        await flush();
        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 3);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/abra'].result.card.name, 'Abra');
        assert.equal((await lookupThere(worker)).marks['/products/abra'].own.rows[0].stock, 3);
    });
});

describe('shop-data: failed snapshot', () => {
    const scenarios = [
        ['HTTP 500', () => jsonRes({ error: 'boom' }, 500)],
        ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['fetch throwing outright', () => { throw new Error('nope'); }],
        ['non JSON', () => ({ status: 200, ok: true, redirected: false, url: '', json: async () => { throw new SyntaxError('bad'); } })],
    ];

    for (const [name, failure] of scenarios) {
        test(`${name} keeps ownKnown false, so no "no la tenés"`, async () => {
            const world = makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? failure() : lookupOk(init)) });
            const worker = bootWorker(world);
            const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
            const mark = answer.marks['/products/abra'];

            assert.equal(mark.own.ownKnown, false);
            assert.ok(mark.result, 'the identity still resolved');
            const derived = deriveMark(mark.result, mark.own);
            assert.equal(derived.state, 'loading');
            assert.doesNotMatch(derived.title, /no la ten/i);
            assert.ok(answer.status.error);
            assert.equal(answer.status.ownKnown, false);
            assert.equal(world.storage['shop:snapshot'], undefined);
        });
    }

    test('a hanging snapshot: after 20 s answers ownKnown false, and the late answer still lands', async () => {
        const gate = deferred();
        const world = makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? gate.promise : lookupOk(init)) });
        world.tabs.push(STORE_TAB);
        const worker = bootWorker(world);

        let answered = null;
        worker.send({ type: 'shop-lookup', items: [item()] }).then((answer) => {
            answered = answer;
        });
        await flush();
        assert.equal(answered, null, 'it waits');

        world.tick(19999);
        await flush();
        assert.equal(answered, null, 'still waiting at 19.999 s');

        world.tick(1);
        await flush();
        assert.ok(answered, 'answered at 20 s');
        assert.equal(answered.marks['/products/abra'].own.ownKnown, false);
        assert.equal(deriveMark(answered.marks['/products/abra'].result, answered.marks['/products/abra'].own).state, 'loading');

        gate.resolve(jsonRes(serverSnapshot(2)));
        await flush();
        assert.deepEqual(world.tabMessages, [snapshotNotice()], 'tabs get told to ask again');

        const next = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(next.marks['/products/abra'].own.ownKnown, true);
        assert.equal(next.marks['/products/abra'].own.rows[0].stock, 2);
    });

    test('after a failure a scan does not wait again nor hammer; it retries 30 s later', async () => {
        let fail = true;
        const world = makeWorld({
            onFetch: (url, init) => {
                if (!url.endsWith('/snapshot')) return lookupOk(init);
                return fail ? jsonRes({}, 500) : jsonRes(serverSnapshot(1));
            },
        });
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.snapshotCalls().length, 1);

        fail = false;
        world.tick(31 * 1000);
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.status.error, null);
    });

    test('own null from the server with nothing saved is ownKnown false, warning exposed', async () => {
        const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(0, { own: null, warnings: ['PA no contestó'] })) });
        const worker = bootWorker(world);
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
        assert.deepEqual(answer.status.warnings, ['PA no contestó']);
    });

    test('a part that fails keeps its last good value instead of erasing it', async () => {
        const world = worldWithSnapshot({ important: { '100:0': { sold: 5 } } }, defaultFetch(serverSnapshot(0, { own: null, important: null, warnings: ['PA no contestó'] })));
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        world.storage['shop:snapshot'].ownAt = world.now - 16 * MIN;
        const worker = bootWorker(world);

        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();

        const saved = world.storage['shop:snapshot'];
        assert.equal(saved.own['100:0'].stock, 3);
        assert.equal(saved.important['100:0'].sold, 5);
        assert.equal(saved.fetchedAt, world.now);
        assert.equal(saved.ownAt, world.now - 16 * MIN, 'the age shown is that of the own data');
    });
});

describe('shop-data: the limit after a failed snapshot, across restarts of the SW', () => {
    const STEP = 28 * 1000; // 10 x 28 s are the 4.7 min, and each one is under the limit
    const scenarios = [
        ['HTTP 500', () => jsonRes({ error: 'boom' }, 500)],
        ['a gateway timeout', () => jsonRes({}, 504)],
        ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['no session', () => jsonRes({}, 403)],
    ];
    const failing = (failure) => (url, init) => (url.endsWith('/snapshot') ? failure() : lookupOk(init));
    const snapshotTimes = (world) => world.snapshotAt;

    /** Remembers when each snapshot call happened, on the virtual clock. */
    function timedWorld(onFetch) {
        const world = makeWorld({
            onFetch: (url, init) => {
                if (url.endsWith('/snapshot')) world.snapshotAt.push(world.now);
                return onFetch(url, init);
            },
        });
        world.snapshotAt = [];
        return world;
    }

    const assertSpaced = (times) => {
        for (let i = 1; i < times.length; i += 1) {
            assert.ok(times[i] - times[i - 1] >= 30 * 1000, `calls ${i - 1} and ${i} are ${times[i] - times[i - 1]} ms apart`);
        }
    };

    for (const [name, failure] of scenarios) {
        test(`${name}, 10 lookups over 4.7 min, a new SW each time: at most one call per 30 s`, async () => {
            const world = timedWorld(failing(failure));
            for (let i = 0; i < 10; i += 1) {
                await bootWorker(world).send({ type: 'shop-lookup', items: [] });
                await flush();
                world.tick(STEP);
            }
            assertSpaced(snapshotTimes(world));
            assert.equal(world.snapshotCalls().length, 5); // 0, 56, 112, 168 and 224 s
        });
    }

    test('the same over a stale snapshot, answered from what is saved', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - 16 * MIN });
        for (let i = 0; i < 10; i += 1) {
            const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [] });
            assert.equal(answer.status.ownKnown, true);
            await flush();
            world.tick(STEP);
        }
        assertSpaced(snapshotTimes(world));
        assert.equal(world.snapshotCalls().length, 5);
    });

    test('one SW life gives the same count', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        const worker = bootWorker(world);
        for (let i = 0; i < 10; i += 1) {
            await worker.send({ type: 'shop-lookup', items: [] });
            await flush();
            world.tick(STEP);
        }
        assert.equal(world.snapshotCalls().length, 5);
    });

    test('30 s after the failure a new SW does ask', async () => {
        let up = false;
        const world = timedWorld(failing(() => (up ? jsonRes(serverSnapshot(4)) : jsonRes({}, 500))));
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        up = true;

        world.tick(30 * 1000 - 1);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);

        world.tick(1);
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 4);
    });

    test('it counts from when the attempt failed: a route that hangs does not get asked right after giving up', async () => {
        const world = timedWorld((url, init) =>
            url.endsWith('/snapshot')
                ? new Promise((resolve, reject) => {
                      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                  })
                : lookupOk(init),
        );
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - 16 * MIN });
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        world.tick(28 * 1000);
        await flush();
        assert.equal(world.storage['shop:snapshotFailedAt'], world.now);

        world.tick(29 * 1000);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('the same inside one SW life', async () => {
        const world = timedWorld((url, init) =>
            url.endsWith('/snapshot')
                ? new Promise((resolve, reject) => {
                      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
                  })
                : lookupOk(init),
        );
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - 16 * MIN });
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        world.tick(28 * 1000);
        await flush();

        world.tick(29 * 1000); // 57 s after it started, 29 s after it failed
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
        world.tick(1000);
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('a SW that died in the middle did not fail: the new one asks at once', async () => {
        const hanging = deferred();
        const world = timedWorld(() => hanging.promise);
        bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.storage['shop:snapshotFailedAt'], undefined);
        bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('a good answer is not a failure', async () => {
        const world = timedWorld(failing(() => jsonRes(serverSnapshot(4))));
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(world.storage['shop:snapshotFailedAt'], undefined);
    });

    test('the popup button goes past it, after a restart too', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('the larger of memory and storage: storage could not be written, memory holds', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshotFailedAt'] = world.now - 10 * MIN;
        const worker = bootWorker(world);
        world.failStorage = true;
        await worker.send({ type: 'shop-refresh' });
        assert.equal(world.snapshotCalls().length, 1);
        world.failStorage = false;

        world.tick(5 * 1000);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1, 'the old date in storage does not undo the failure in memory');
    });

    test('a date in the future (the clock moved back) is removed by just loading it, with no refresh involved', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshot'] = freshSnapshot(world);
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 0, 'the snapshot is fresh: nothing to ask');
        assert.ok(!('shop:snapshotFailedAt' in world.storage));
    });

    test('a date in the future holds nothing: not capped to now, the first lookup asks at once', async () => {
        const world = timedWorld(failing(() => jsonRes(serverSnapshot(4))));
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - HOUR });
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 4);
    });

    test('one millisecond ahead is already the future', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshot'] = freshSnapshot(world);
        world.storage['shop:snapshotFailedAt'] = world.now + 1;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.ok(!('shop:snapshotFailedAt' in world.storage));
    });

    test('a date of exactly now is not the future: it stays and holds its whole window', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - 16 * MIN });
        const failedAt = world.now;
        world.storage['shop:snapshotFailedAt'] = failedAt;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 0);
        assert.equal(world.storage['shop:snapshotFailedAt'], failedAt);

        world.tick(30 * 1000 - 1);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 0);

        world.tick(1);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('a date in the past is left where it is', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshot'] = freshSnapshot(world);
        const failedAt = world.now - 10 * 1000;
        world.storage['shop:snapshotFailedAt'] = failedAt;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.storage['shop:snapshotFailedAt'], failedAt);
    });

    test('date 10 h ahead, the route failing, a new SW every 10 min for 80 min: it asks every time', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        const trail = [];
        for (let i = 0; i < 8; i += 1) {
            await bootWorker(world).send({ type: 'shop-lookup', items: [] });
            await flush();
            trail.push(world.snapshotCalls().length);
            assert.equal(world.storage['shop:snapshotFailedAt'], world.now, 'only the real failure stays saved');
            world.tick(10 * MIN);
        }
        assert.deepEqual(trail, [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test('the same with the route healthy and a snapshot 1 h old: the data stops aging', async () => {
        const world = timedWorld(failing(() => jsonRes(serverSnapshot(4))));
        world.storage['shop:snapshot'] = freshSnapshot(world, { fetchedAt: world.now - HOUR, ownAt: world.now - HOUR });
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        const trail = [];
        for (let i = 0; i < 8; i += 1) {
            await bootWorker(world).send({ type: 'shop-lookup', items: [] });
            await flush();
            trail.push(world.snapshotCalls().length);
            assert.equal(world.storage['shop:snapshot'].ownAt > world.now - 16 * MIN, true);
            world.tick(10 * MIN);
        }
        assert.deepEqual(trail, [1, 1, 2, 2, 3, 3, 4, 4], 'one call each time the 15 min run out');
    });

    test('date 10 h ahead inside one SW life: asks at once, then the real failure holds its 30 s', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        world.tick(30 * 1000 - 1);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        world.tick(1);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('the failure right after removing a future date holds across a restart too', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshotFailedAt'] = world.now + 10 * HOUR;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        world.tick(30 * 1000 - 1);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        world.tick(1);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('a refresh that answers removes the saved failure', async () => {
        let up = false;
        const world = timedWorld(failing(() => (up ? jsonRes(serverSnapshot(4)) : jsonRes({}, 500))));
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.storage['shop:snapshotFailedAt'], world.now);

        up = true;
        world.tick(30 * 1000);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
        assert.ok(!('shop:snapshotFailedAt' in world.storage));
    });

    test('the button that answers removes it too, inside the window', async () => {
        let up = false;
        const world = timedWorld(failing(() => (up ? jsonRes(serverSnapshot(4)) : jsonRes({}, 500))));
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(typeof world.storage['shop:snapshotFailedAt'], 'number');

        up = true;
        world.tick(5 * 1000);
        const answer = await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(answer.ok, true);
        assert.ok(!('shop:snapshotFailedAt' in world.storage));
    });

    test('the clock moves back after a failure in this life: a refresh that answers leaves no date ahead', async () => {
        let up = false;
        const world = timedWorld(failing(() => (up ? jsonRes(serverSnapshot(4)) : jsonRes({}, 500))));
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        const failedAt = world.storage['shop:snapshotFailedAt'];

        world.now -= 10 * HOUR;
        assert.ok(failedAt > world.now);
        up = true;
        await worker.send({ type: 'shop-refresh' });
        assert.ok(!('shop:snapshotFailedAt' in world.storage));
    });

    test('an answer with own null is still an answer: the key goes and the 5 min of own null take over', async () => {
        const world = timedWorld(failing(() => jsonRes(serverSnapshot(0, { own: null }))));
        world.storage['shop:snapshotFailedAt'] = world.now - 31 * 1000;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
        assert.ok(!('shop:snapshotFailedAt' in world.storage));

        world.tick(4 * MIN);
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1, 'counted from the saved fetchedAt, not from the removed key');
    });

    test('a late answer of the previous admin does not remove the failure of this one', async () => {
        const DEV = 'http://localhost:3000';
        const late = deferred();
        const world = timedWorld((url, init) => {
            if (!url.endsWith('/snapshot')) return lookupOk(init);
            return url.startsWith(DEV) ? late.promise : jsonRes({}, 500);
        });
        world.storage.adminBase = DEV;
        const worker = bootWorker(world);
        worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        delete world.storage.adminBase;
        await worker.send({ type: 'shop-refresh' });
        const failedAt = world.storage['shop:snapshotFailedAt'];
        assert.equal(failedAt, world.now);

        late.resolve(jsonRes(serverSnapshot(4)));
        await flush();
        assert.equal(world.storage['shop:snapshotFailedAt'], failedAt);
    });

    test('a refresh that fails again keeps the key, with the date of the new failure', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        world.tick(30 * 1000);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(world.storage['shop:snapshotFailedAt'], world.now);
    });

    test('something else in that key is ignored', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        world.storage['shop:snapshotFailedAt'] = 'yesterday';
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);
    });

    test('a failure of another admin does not hold this one', async () => {
        const DEV = 'http://localhost:3000';
        const world = timedWorld((url, init) => (url.startsWith(DEV) ? jsonRes({}, 500) : defaultFetch()(url, init)));
        world.storage.adminBase = DEV;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 1);

        delete world.storage.adminBase;
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(world.storage['shop:snapshotFailedAt'], undefined);
    });

    test('the same admin change inside one SW life', async () => {
        const DEV = 'http://localhost:3000';
        const world = timedWorld((url, init) => (url.startsWith(DEV) ? jsonRes({}, 500) : defaultFetch()(url, init)));
        world.storage.adminBase = DEV;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        delete world.storage.adminBase;
        await worker.send({ type: 'shop-lookup', items: [] });
        assert.equal(world.snapshotCalls().length, 2);
    });

    test('nothing saved says a refresh is running', async () => {
        const world = timedWorld(failing(() => jsonRes({}, 500)));
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        assert.ok(!JSON.stringify(world.storage).includes('refreshing'));
    });
});

describe('shop-data: a lookup in flight when the button is pressed', () => {
    /** Each lookup POST waits on its own gate; the server answers with the market of that moment. */
    function gatedWorld(snapshotFetch = () => jsonRes(serverSnapshot())) {
        const gates = [];
        const world = makeWorld({
            onFetch: (url, init) => {
                if (url.endsWith('/snapshot')) return snapshotFetch();
                const gate = deferred();
                gates.push(gate);
                const market = world.market;
                return gate.promise.then(() => lookupOk(init, () => ({ ...resolved(), printings: [printing('Normal', { market })] })));
            },
        });
        world.market = 10;
        world.storage['shop:snapshot'] = freshSnapshot(world);
        return { world, gates };
    }
    const marketOf = (answer) => answer.marks['/products/abra'].result?.printings[0].market;
    const CACHE_KEY = 'shop:lookup:wulfgaming:/products/abra';

    test('its old answer is not written back', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        const inFlight = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(gates.length, 1);

        world.market = 99;
        await worker.send({ type: 'shop-refresh' });
        gates[0].resolve();
        await inFlight;
        await flush();
        assert.equal(world.storage[CACHE_KEY], undefined);

        const next = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(gates.length, 2, 'the next question goes to the server');
        gates[1].resolve();
        assert.equal(marketOf(await next), 99);
        assert.equal(world.storage[CACHE_KEY].result.printings[0].market, 99);
    });

    test('the tab that asked gets no old answer either, and "could not answer" is what it hears', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        const inFlight = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        await worker.send({ type: 'shop-refresh' });
        gates[0].resolve();
        const answer = await inFlight;
        assert.equal(answer.ok, false);
        assert.equal(answer.marks['/products/abra'].result, null);
    });

    test('a question after the button does not wait on the one from before', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        world.market = 99;
        await worker.send({ type: 'shop-refresh' });

        const next = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(gates.length, 2);
        gates[1].resolve(); // the new one lands first, the old one is still out there
        assert.equal(marketOf(await next), 99);

        gates[0].resolve();
        await flush();
        assert.equal(world.storage[CACHE_KEY].result.printings[0].market, 99, 'the old one landing late changes nothing');
    });

    test('the old one landing does not take the new one out of the map: no second POST', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        await worker.send({ type: 'shop-refresh' });

        const second = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(gates.length, 2);
        gates[0].resolve();
        await flush();

        const third = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(gates.length, 2, 'it joins the question already running');
        gates[1].resolve();
        await Promise.all([second, third]);
    });

    test('a lookup that starts after the button is written as usual', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-refresh' });
        const next = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        gates[0].resolve();
        await next;
        assert.ok(world.storage[CACHE_KEY]);
    });

    test('a batch waiting for its turn when the button is pressed asks after it, so it counts', async () => {
        const { world, gates } = gatedWorld();
        const worker = bootWorker(world);
        const many = (from, to) => Array.from({ length: to - from }, (_, i) => item(`/products/p${from + i}`));
        // 3 batches of 60 and 2 slots: the third one has not been sent yet.
        const answer = worker.send({ type: 'shop-lookup', items: many(0, 180) });
        await flush();
        assert.equal(gates.length, 2);

        world.market = 99;
        await worker.send({ type: 'shop-refresh' });
        gates[0].resolve();
        gates[1].resolve();
        await flush();
        assert.equal(gates.length, 3);
        gates[2].resolve();
        await answer;
        await flush();
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/p0'], undefined);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/p179'].result.printings[0].market, 99);
    });

    test('a refresh already in flight when the button is pressed is not thrown away', async () => {
        const gate = deferred();
        const { world } = gatedWorld(() => gate.promise);
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        world.tabs.push(STORE_TAB);
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        const pressed = worker.send({ type: 'shop-refresh' });
        await flush();
        assert.equal(world.snapshotCalls().length, 1, 'it joins the running one');

        gate.resolve(jsonRes(serverSnapshot(4)));
        const answer = await pressed;
        assert.equal(answer.ok, true);
        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 4);
        assert.deepEqual(world.tabMessages, [snapshotNotice()]);
    });

    test('and the same running refresh still loses to an admin change', async () => {
        const gate = deferred();
        const { world } = gatedWorld(() => gate.promise);
        world.storage.adminBase = 'http://localhost:3000';
        world.storage['shop:cacheBase'] = 'http://localhost:3000';
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [] });
        await flush();

        delete world.storage.adminBase;
        await worker.send({ type: 'shop-status' });
        gate.resolve(jsonRes(serverSnapshot(777)));
        await flush();
        assert.equal(world.storage['shop:snapshot'], undefined);
    });
});

describe('shop-data: what the snapshot brings next to own', () => {
    const DAY = 24 * HOUR;
    const refreshWith = async (world) => {
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-refresh' });
        return worker;
    };

    // ownAt: when PA last answered, not when KT answered.

    test('ownAt is the date KT gives, when its own copy is older', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        const at = new Date(world.now - 3 * HOUR).toISOString();
        world.onFetch = defaultFetch(serverSnapshot(4, { ownAt: at }));
        await refreshWith(world);
        assert.equal(world.storage['shop:snapshot'].ownAt, world.now - 3 * HOUR);
        assert.equal(world.storage['shop:snapshot'].fetchedAt, world.now);
    });

    test('never later than now: a clock ahead does not make the data young', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        world.onFetch = defaultFetch(serverSnapshot(4, { ownAt: new Date(world.now + 5 * MIN).toISOString() }));
        await refreshWith(world);
        assert.equal(world.storage['shop:snapshot'].ownAt, world.now);
    });

    for (const [name, ownAt] of [['missing', undefined], ['null', null], ['garbage', 'ayer'], ['empty', ''], ['a number', 1]]) {
        test(`ownAt ${name}: now, as before`, async () => {
            const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(4, { ownAt })) });
            await refreshWith(world);
            assert.equal(world.storage['shop:snapshot'].ownAt, world.now);
        });
    }

    test('KT serving a copy of 3 days reads as too old, however often it answers', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        const at = new Date(world.now - 3 * DAY).toISOString();
        world.onFetch = (url, init) => (url.endsWith('/snapshot') ? jsonRes(serverSnapshot(4, { ownAt: at, warnings: ['es la última copia buena'] })) : lookupOk(init));
        const worker = await refreshWith(world);
        world.tick(16 * MIN);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(world.snapshotCalls().length, 2);

        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.status.ownTooOld, true);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
        assert.equal(deriveMark(answer.marks['/products/abra'].result, answer.marks['/products/abra'].own).state, 'loading');
    });

    test('the 48 h are counted from there, to the millisecond', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        const at = new Date(world.now - 47 * HOUR).toISOString();
        world.onFetch = (url, init) => (url.endsWith('/snapshot') ? jsonRes(serverSnapshot(4, { ownAt: at })) : assert.fail('no lookup'));
        const worker = await refreshWith(world);
        assert.equal((await worker.send({ type: 'shop-status' })).status.ownTooOld, false);
        world.now += HOUR;
        assert.equal((await worker.send({ type: 'shop-status' })).status.ownTooOld, false);
        world.now += 1;
        assert.equal((await worker.send({ type: 'shop-status' })).status.ownTooOld, true);
    });

    test('the popup shows that age', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        world.onFetch = defaultFetch(serverSnapshot(4, { ownAt: new Date(world.now - 2 * HOUR).toISOString() }));
        await refreshWith(world);
        assert.equal((await bootWorker(world).send({ type: 'shop-status' })).status.snapshotAgeMs, 2 * HOUR);
    });

    test('own that did not come keeps the age it had, whatever date comes with it', async () => {
        const world = worldWithSnapshot({ ownAt: Date.UTC(2026, 10, 4, 10) }, defaultFetch(serverSnapshot(0, { own: null, ownAt: new Date(Date.UTC(2026, 10, 4, 12)).toISOString() })));
        await refreshWith(world);
        assert.equal(world.storage['shop:snapshot'].ownAt, Date.UTC(2026, 10, 4, 10));
    });

    // unsettled: travels with own.

    const keptOwn = { '100:0': { stock: 3 } };
    const withUnsettled = (world, unsettled) => {
        world.storage['shop:snapshot'] = freshSnapshot(world, { own: keptOwn, unsettled, fetchedAt: world.now - 16 * MIN });
        return world;
    };

    test('unsettled comes with own and is saved', async () => {
        const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(4, { unsettled: [200, 300] })) });
        await refreshWith(world);
        assert.deepEqual(world.storage['shop:snapshot'].unsettled, [200, 300]);
    });

    test('a new own with an empty list settles them', async () => {
        const world = withUnsettled(makeWorld({ onFetch: defaultFetch(serverSnapshot(4, { unsettled: [] })) }), [200]);
        await refreshWith(world);
        assert.deepEqual(world.storage['shop:snapshot'].unsettled, []);
    });

    test('own that did not come: its list stays with the copy that stays', async () => {
        for (const unsettled of [undefined, null, [], [999]]) {
            const world = withUnsettled(makeWorld({ onFetch: defaultFetch(serverSnapshot(0, { own: null, unsettled })) }), [200]);
            await refreshWith(world);
            const saved = world.storage['shop:snapshot'];
            assert.deepEqual(saved.own, keptOwn);
            assert.deepEqual(saved.unsettled, [200], `server said ${JSON.stringify(unsettled)}`);
        }
    });

    test('own that came with no list (a KT without the field): the last list stays', async () => {
        const world = withUnsettled(makeWorld({ onFetch: defaultFetch(serverSnapshot(4)) }), [200]);
        await refreshWith(world);
        assert.deepEqual(world.storage['shop:snapshot'].unsettled, [200]);
    });

    test('never had one: null, and nothing breaks', async () => {
        const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(4)) });
        const worker = await refreshWith(world);
        assert.equal(world.storage['shop:snapshot'].unsettled, null);
        assert.equal((await worker.send({ type: 'shop-lookup', items: [item()] })).marks['/products/abra'].own.mapped, true);
    });

    test('end to end: the mark of a product on the list, through the real SW', async () => {
        const card = { ...CARD, productId: 200 };
        const world = makeWorld({
            onFetch: (url, init) =>
                url.endsWith('/snapshot') ? jsonRes(serverSnapshot(4, { unsettled: [200] })) : lookupOk(init, (asked) => resolved(asked.key.endsWith('abra') ? card : CARD)),
        });
        const worker = bootWorker(world);
        const answer = await worker.send({ type: 'shop-lookup', items: [item(), item('/products/owned')] });
        const unsettled = answer.marks['/products/abra'];
        assert.equal(unsettled.own.mapped, null);
        const mark = deriveMark(unsettled.result, unsettled.own);
        assert.equal(mark.title, 'No figura en tu stock');
        assert.equal(mark.badge, '?');

        const owned = answer.marks['/products/owned'];
        assert.equal(deriveMark(owned.result, owned.own).title, 'Tenés 4');
    });

    test('it survives a restart with the saved snapshot', async () => {
        const world = makeWorld({ onFetch: (url, init) => (url.endsWith('/snapshot') ? jsonRes(serverSnapshot(4, { unsettled: [100] })) : lookupOk(init)) });
        await refreshWith(world);
        world.storage['shop:snapshot'].own = { '999:0': { stock: 1 } };
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.mapped, null);
    });
});

describe('shop-data: session', () => {
    for (const status of [401, 403]) {
        test(`${status} gives auth false and exposes loginUrl`, async () => {
            const world = makeWorld({ onFetch: () => jsonRes({ error: 'forbidden' }, status) });
            const worker = bootWorker(world);
            const answer = await worker.send({ type: 'shop-lookup', items: [item()] });

            assert.equal(answer.status.auth, false);
            assert.equal(answer.status.loginUrl, 'https://cartas.konekotekka.com.ar/api/auth/signin');
            assert.equal(answer.ok, false);
            assert.equal(answer.marks['/products/abra'].result, null);
            assert.equal(answer.marks['/products/abra'].own.ownKnown, false);
            assert.equal(Object.keys(world.storage).some((key) => key.startsWith('shop:lookup:')), false, 'a 403 is not cached');
        });
    }

    test('a redirect to the sign-in page is also auth false', async () => {
        const world = makeWorld({
            onFetch: () => ({
                status: 200,
                ok: true,
                redirected: true,
                url: 'https://cartas.konekotekka.com.ar/api/auth/signin?callbackUrl=x',
                json: async () => {
                    throw new SyntaxError('html');
                },
            }),
        });
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.status.auth, false);
        assert.equal(answer.status.error, null);
    });

    test('403 with a saved snapshot still answers the data and says auth false', async () => {
        const world = worldWithSnapshot({}, () => jsonRes({}, 403));
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;
        world.storage['shop:lookup:wulfgaming:/products/abra'] = { at: world.now, result: resolved() };
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 3);
        assert.equal(answer.status.auth, false);
        assert.equal(deriveMark(answer.marks['/products/abra'].result, answer.marks['/products/abra'].own).title, 'Tenés 3');
    });

    test('without a session it does not pound the admin; signing in recovers', async () => {
        let signedIn = false;
        const world = makeWorld({
            onFetch: (url, init) => {
                if (!signedIn) return jsonRes({}, 403);
                return url.endsWith('/snapshot') ? jsonRes(serverSnapshot(1)) : lookupOk(init);
            },
        });
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        const callsAfterFirst = world.calls.length;
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.calls.length, callsAfterFirst, 'no calls during the 30 s window');

        signedIn = true;
        world.tick(31 * 1000);
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.status.auth, true);
        assert.equal(answer.ok, true);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
    });

    test('the popup refresh ignores the waiting window', async () => {
        let signedIn = false;
        const world = makeWorld({ onFetch: () => (signedIn ? jsonRes(serverSnapshot(1)) : jsonRes({}, 403)) });
        const worker = bootWorker(world);
        const first = await worker.send({ type: 'shop-refresh' });
        assert.equal(first.ok, false);
        assert.equal(first.status.auth, false);

        signedIn = true;
        const second = await worker.send({ type: 'shop-refresh' });
        assert.equal(second.ok, true);
        assert.equal(second.status.auth, true);
        assert.equal(second.status.ownKnown, true);
    });

    test('only the session cookie: credentials include, no token, absolute url', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });

        assert.ok(world.calls.length >= 2);
        for (const call of world.calls) {
            assert.equal(call.init.credentials, 'include');
            assert.match(call.url, /^https:\/\/cartas\.konekotekka\.com\.ar\/api\/admin\/compras\/extension\//);
            assert.doesNotMatch(JSON.stringify(call.init.headers || {}), /authorization|token/i);
        }
        assert.doesNotMatch(read('scripts/lib/shop-data.js') + read('scripts/lib/shop-core.js'), /REPARTO_SERVICE_TOKEN|Bearer/);
    });

    test('adminBase from storage, as in ml-admin-link.js', async () => {
        const world = makeWorld({ storage: { adminBase: 'http://localhost:3000/' }, onFetch: defaultFetch() });
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.ok(world.calls.every((call) => call.url.startsWith('http://localhost:3000/api/admin/compras/extension/')));
        assert.equal(answer.status.loginUrl, 'http://localhost:3000/api/auth/signin');
    });
});

describe('shop-data: batching', () => {
    test('130 items: batches of up to 60, 2 at a time, every answer back under its key', async () => {
        let running = 0;
        let maxRunning = 0;
        const world = worldWithSnapshot({}, async (url, init) => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await flush();
            running -= 1;
            return lookupOk(init, (one) => resolved({ ...CARD, name: one.key }));
        });
        const items = Array.from({ length: 130 }, (_, i) => item(`/products/card-${i}`));
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items });

        assert.deepEqual(world.lookupCalls().map((c) => c.items.length).sort((a, b) => b - a), [60, 60, 10]);
        assert.equal(maxRunning, 2);
        assert.equal(answer.ok, true);
        assert.equal(Object.keys(answer.marks).length, 130);
        for (const one of items) {
            assert.equal(answer.marks[one.key].result.card.name, `wulfgaming:${one.key}`);
        }
    });

    test('exactly 60 is one batch, 61 is two', async () => {
        for (const [count, batches] of [[60, 1], [61, 2]]) {
            const world = worldWithSnapshot({}, (url, init) => lookupOk(init));
            await bootWorker(world).send({ type: 'shop-lookup', items: Array.from({ length: count }, (_, i) => item(`/products/c${i}`)) });
            assert.equal(world.lookupCalls().length, batches);
        }
    });

    test('a failed batch does not take the others down and is not cached', async () => {
        let n = 0;
        const world = worldWithSnapshot({}, (url, init) => {
            n += 1;
            return n === 1 ? jsonRes({}, 500) : lookupOk(init);
        });
        const items = Array.from({ length: 70 }, (_, i) => item(`/products/c${i}`));
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items });
        assert.equal(answer.ok, false);
        assert.equal(answer.marks['/products/c0'].result, null);
        assert.ok(answer.marks['/products/c60'].result);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/c0'], undefined);
        assert.ok(world.storage['shop:lookup:wulfgaming:/products/c60']);
    });

    test('a lookup that fails shows in the status, and the next good one clears it', async () => {
        let fail = true;
        const world = worldWithSnapshot({}, (url, init) => (fail ? jsonRes({}, 500) : lookupOk(init)));
        const worker = bootWorker(world);
        const failed = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(failed.ok, false);
        assert.equal(failed.status.error, 'HTTP 500');

        fail = false;
        const fine = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(fine.ok, true);
        assert.equal(fine.status.error, null);
    });

    test('a repeated item goes once, and a second tab reuses the running one', async () => {
        const gate = deferred();
        const world = worldWithSnapshot({}, () => gate.promise);
        const worker = bootWorker(world);
        const first = worker.send({ type: 'shop-lookup', items: [item(), item()] });
        await flush();
        const second = worker.send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(world.lookupCalls().length, 1);
        assert.equal(world.lookupCalls()[0].items.length, 1);
        gate.resolve(jsonRes({ results: { 'wulfgaming:/products/abra': resolved() } }));
        assert.ok((await first).marks['/products/abra'].result);
        assert.ok((await second).marks['/products/abra'].result);
    });

    test('the same handle in two stores does not collide: prices differ per store', async () => {
        const world = worldWithSnapshot({}, (url, init) => lookupOk(init, (one) => resolved({ ...CARD, name: one.store })));
        const worker = bootWorker(world);
        const wulf = await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming')] });
        const gg = await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'gglehi')] });
        assert.equal(wulf.marks['/products/abra'].result.card.name, 'wulfgaming');
        assert.equal(gg.marks['/products/abra'].result.card.name, 'gglehi');
        assert.equal(world.lookupCalls().length, 2);
    });

    test('sends productId, title and setName when it has them, and bad items are dropped', async () => {
        const world = worldWithSnapshot({}, (url, init) => lookupOk(init));
        const answer = await bootWorker(world).send({
            type: 'shop-lookup',
            items: [
                item('/product/5', 'tcgplayer', { productId: 5, title: 'Abra (1/10) [Set]', setName: 'Set' }),
                { store: 'wulfgaming' },
                null,
                { key: 'x' },
            ],
        });
        const [sent] = world.lookupCalls()[0].items;
        assert.equal(sent.productId, 5);
        assert.equal(sent.title, 'Abra (1/10) [Set]');
        assert.equal(sent.setName, 'Set');
        assert.equal(sent.key, 'tcgplayer:/product/5');
        assert.deepEqual(Object.keys(answer.marks), ['/product/5']);
    });
});

describe('shop-data: lookup cache', () => {
    const run = async (answer) => {
        const world = worldWithSnapshot({}, (url, init) => lookupOk(init, answer));
        world.storage['shop:snapshot'].fetchedAt = world.now + 365 * 24 * HOUR; // the snapshot is not on trial here
        return { world, worker: bootWorker(world) };
    };

    test('resolved: 24 h', async () => {
        const { world, worker } = await run(() => resolved());
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);
        assert.ok(world.storage['shop:lookup:wulfgaming:/products/abra']);

        world.tick(24 * HOUR - 1);
        const cached = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);
        assert.equal(cached.marks['/products/abra'].result.card.productId, 100);

        world.tick(2);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 2);
    });

    test('unknown: 6 h', async () => {
        const { world, worker } = await run(() => unknownResult);
        await worker.send({ type: 'shop-lookup', items: [item()] });

        world.tick(6 * HOUR - 1);
        const cached = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);
        assert.equal(cached.marks['/products/abra'].result.status, 'unknown');
        assert.equal(cached.ok, true);

        world.tick(2);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 2);
    });

    test('doubtful counts as resolved', async () => {
        const { world, worker } = await run(() => ({ ...resolved(), status: 'doubtful' }));
        await worker.send({ type: 'shop-lookup', items: [item()] });
        world.tick(7 * HOUR);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);
    });

    test('the cache survives a restart', async () => {
        const { world, worker } = await run(() => resolved());
        await worker.send({ type: 'shop-lookup', items: [item()] });
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);
        assert.equal(answer.marks['/products/abra'].result.card.productId, 100);
    });

    test('a cached unknown is asked again when a product page brings the id', async () => {
        const { world, worker } = await run((one) => (one.productId ? resolved() : unknownResult));
        await worker.send({ type: 'shop-lookup', items: [item()] });
        const answer = await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { productId: 272472 })] });
        assert.equal(world.lookupCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].result.status, 'ok');
    });

    test('a cached unknown is asked again, once, when an item brings the set', async () => {
        const { world, worker } = await run((one) => (one.setName ? resolved() : unknownResult));
        await worker.send({ type: 'shop-lookup', items: [item()] });
        const withSet = () => item('/products/abra', 'wulfgaming', { setName: 'SM Promos' });
        const answer = await worker.send({ type: 'shop-lookup', items: [withSet()] });
        assert.equal(world.lookupCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].result.status, 'ok');
    });

    test('an unknown asked with the set is not asked again on every page', async () => {
        const { world, worker } = await run(() => unknownResult);
        const withSet = () => item('/products/abra', 'wulfgaming', { setName: 'SM Promos' });
        await worker.send({ type: 'shop-lookup', items: [withSet()] });
        await worker.send({ type: 'shop-lookup', items: [withSet()] });
        assert.equal(world.lookupCalls().length, 1);
    });

    test('TCGplayer: 4 lookups of an unknown with its id give 1 POST', async () => {
        const { world, worker } = await run(() => unknownResult);
        const tcg = () => item('/product/500000', 'tcgplayer', { productId: 500000 });
        for (let i = 0; i < 4; i += 1) {
            await worker.send({ type: 'shop-lookup', items: [tcg()] });
            world.tick(MIN);
        }
        assert.equal(world.lookupCalls().length, 1);
    });

    test('the same after a restart: what was asked is in the entry, not in a variable', async () => {
        const { world, worker } = await run(() => unknownResult);
        const tcg = () => item('/product/500000', 'tcgplayer', { productId: 500000 });
        await worker.send({ type: 'shop-lookup', items: [tcg()] });
        await bootWorker(world).send({ type: 'shop-lookup', items: [tcg()] });
        assert.equal(world.lookupCalls().length, 1);
        assert.deepEqual(world.storage['shop:lookup:tcgplayer:/product/500000'].asked, { productId: [500000], setName: [], title: [] });
    });

    test('CoolStuffInc: a product page set then a grid set gives a re-ask', async () => {
        // Both carry a setName. The product page only has the site trail, the grid the real set.
        const TRAIL = 'Main » Collectable Card Games » Pokemon » Charizard & Braixen-GX (Alt Full Art) - SM230';
        const GRID = 'Pokemon » SM Promos';
        const { world, worker } = await run((one) => (one.setName === GRID ? resolved() : unknownResult));
        const csi = (setName) => item('/p/Pokemon/Charizard', 'coolstuffinc', { setName });

        const page = await worker.send({ type: 'shop-lookup', items: [csi(TRAIL)] });
        assert.equal(page.marks['/p/Pokemon/Charizard'].result.status, 'unknown');

        const grid = await worker.send({ type: 'shop-lookup', items: [csi(GRID)] });
        assert.equal(world.lookupCalls().length, 2);
        assert.equal(grid.marks['/p/Pokemon/Charizard'].result.status, 'ok');
    });

    test('a title that arrives later gets its question, once', async () => {
        const { world, worker } = await run((one) => (one.title ? resolved() : unknownResult));
        await worker.send({ type: 'shop-lookup', items: [item()] });
        const titled = () => item('/products/abra', 'wulfgaming', { title: 'Abomasnow (010/198) [Sword & Shield: Chilling Reign]' });
        const answer = await worker.send({ type: 'shop-lookup', items: [titled()] });
        assert.equal(world.lookupCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].result.status, 'ok');
        await worker.send({ type: 'shop-lookup', items: [titled()] });
        assert.equal(world.lookupCalls().length, 2);
    });

    test('once per distinct question: two pages that spell it differently do not take turns forever', async () => {
        const { world, worker } = await run(() => unknownResult);
        const titled = (title) => item('/products/abra', 'wulfgaming', { title });
        for (const title of ['Grid title', 'Page title', 'Grid title', 'Page title', 'Grid title']) {
            await worker.send({ type: 'shop-lookup', items: [titled(title)] });
        }
        assert.equal(world.lookupCalls().length, 2);
        assert.deepEqual(world.storage['shop:lookup:wulfgaming:/products/abra'].asked.title, ['Grid title', 'Page title']);
    });

    test('an item with less than what was asked is not a new question', async () => {
        const { world, worker } = await run(() => unknownResult);
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { title: 'T', setName: 'S', productId: 7 })] });
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { title: 'T' })] });
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { setName: 'S' })] });
        assert.equal(world.lookupCalls().length, 1);
    });

    test('a value that changes on every render stops after a few questions', async () => {
        const { world, worker } = await run(() => unknownResult);
        for (let i = 0; i < 20; i += 1) {
            await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { title: `render ${i}` })] });
        }
        assert.equal(world.lookupCalls().length, 6);
    });

    test('a resolved card is not asked again, whatever the new item brings', async () => {
        const { world, worker } = await run(() => resolved());
        await worker.send({ type: 'shop-lookup', items: [item()] });
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { productId: 9, title: 'T', setName: 'S' })] });
        assert.equal(world.lookupCalls().length, 1);
    });

    test('once expired it starts over: what was asked before is forgotten', async () => {
        const { world, worker } = await run(() => unknownResult);
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { title: 'A' })] });
        world.tick(6 * HOUR + 1);
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { title: 'B' })] });
        assert.equal(world.lookupCalls().length, 2);
        assert.deepEqual(world.storage['shop:lookup:wulfgaming:/products/abra'].asked.title, ['B']);
    });

    test('an entry saved with no record of what was asked gets one more question', async () => {
        const { world, worker } = await run(() => unknownResult);
        world.storage['shop:lookup:wulfgaming:/products/abra'] = { at: world.now, result: unknownResult, askedWithSet: true };
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 0, 'no value, no question');
        await worker.send({ type: 'shop-lookup', items: [item('/products/abra', 'wulfgaming', { setName: 'S' })] });
        assert.equal(world.lookupCalls().length, 1);
    });

    test('expired entries are pruned after a refresh; fresh ones and other keys stay', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        world.storage['shop:lookup:a:old'] = { at: world.now - 25 * HOUR, result: resolved() };
        world.storage['shop:lookup:a:new'] = { at: world.now - HOUR, result: resolved() };
        world.storage['shop:lookup:a:oldunknown'] = { at: world.now - 7 * HOUR, result: unknownResult };
        world.storage['sales'] = { keep: true };
        await bootWorker(world).send({ type: 'shop-lookup', items: [] });
        await flush();
        assert.equal(world.storage['shop:lookup:a:old'], undefined);
        assert.equal(world.storage['shop:lookup:a:oldunknown'], undefined);
        assert.ok(world.storage['shop:lookup:a:new']);
        assert.deepEqual(world.storage['sales'], { keep: true });
    });

    test('shop-refresh clears the lookup cache: the next answer is the server\'s', async () => {
        let market = 10;
        let boughtAt = null;
        const world = worldWithSnapshot({}, (url, init) =>
            url.endsWith('/snapshot')
                ? jsonRes(serverSnapshot())
                : lookupOk(init, () => ({ ...resolved(), printings: [printing('Normal', { market, boughtAt })] })),
        );
        world.storage['sales'] = { keep: true };
        const worker = bootWorker(world);
        await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 1);

        market = 99;
        boughtAt = '2026-11-04T11:00:00Z';
        world.tick(HOUR);
        const cached = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(cached.marks['/products/abra'].result.printings[0].market, 10);

        const refreshed = await worker.send({ type: 'shop-refresh' });
        assert.equal(refreshed.ok, true);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/abra'], undefined);
        assert.deepEqual(world.storage['sales'], { keep: true });

        const after = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 2);
        assert.equal(after.marks['/products/abra'].result.printings[0].market, 99);
        assert.equal(deriveMark(after.marks['/products/abra'].result, after.marks['/products/abra'].own).boughtAt, boughtAt);
    });

    test('shop-refresh clears it even when the snapshot fails', async () => {
        const world = worldWithSnapshot({}, () => jsonRes({}, 500));
        world.storage['shop:lookup:wulfgaming:/products/abra'] = { at: world.now, result: resolved() };
        const answer = await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(answer.ok, false);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/abra'], undefined);
    });
});

describe('shop-data: service worker restart', () => {
    test('dies mid refresh with nothing saved: the new life asks again, no flag left behind', async () => {
        const hanging = deferred();
        let useHanging = true;
        const world = makeWorld({
            onFetch: (url, init) => {
                if (!url.endsWith('/snapshot')) return lookupOk(init);
                return useHanging ? hanging.promise : jsonRes(serverSnapshot(5));
            },
        });

        const first = bootWorker(world);
        first.send({ type: 'shop-lookup', items: [item()] }); // this answer never comes: the port died
        await flush();
        assert.equal(world.snapshotCalls().length, 1);
        assert.equal(world.storage['shop:snapshot'], undefined);
        assert.ok(!JSON.stringify(world.storage).includes('refreshing'), 'nothing persisted says a refresh is running');

        useHanging = false;
        const second = bootWorker(world);
        const answer = await second.send({ type: 'shop-lookup', items: [item()] });

        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 5);
    });

    test('loses the module variable with a snapshot saved: reads storage, no fetch', async () => {
        const world = makeWorld({ onFetch: defaultFetch(serverSnapshot(8)) });
        await bootWorker(world).send({ type: 'shop-refresh' });
        assert.equal(world.snapshotCalls().length, 1);

        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.snapshotCalls().length, 1);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 8);
    });

    test('dies mid refresh over a stale snapshot: the new life answers stale and refreshes', async () => {
        const hanging = deferred();
        let useHanging = true;
        const world = worldWithSnapshot({}, (url, init) => {
            if (!url.endsWith('/snapshot')) return lookupOk(init);
            return useHanging ? hanging.promise : jsonRes(serverSnapshot(6));
        });
        world.storage['shop:snapshot'].fetchedAt = world.now - 16 * MIN;

        await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(world.snapshotCalls().length, 1);

        useHanging = false;
        const second = bootWorker(world);
        const answer = await second.send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].own.rows[0].stock, 3, 'stale, right away');
        await flush();
        assert.equal(world.snapshotCalls().length, 2);
        assert.equal(world.storage['shop:snapshot'].own['100:0'].stock, 6);
    });

    test('dies mid lookup: the new life asks for it again', async () => {
        const hanging = deferred();
        let useHanging = true;
        const world = worldWithSnapshot({}, (url, init) => (useHanging ? hanging.promise : lookupOk(init)));

        bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        await flush();
        assert.equal(world.lookupCalls().length, 1);

        useHanging = false;
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(world.lookupCalls().length, 2);
        assert.ok(answer.marks['/products/abra'].result);
    });

    test('the session state and the age survive for the popup', async () => {
        const world = makeWorld({ onFetch: () => jsonRes({}, 403) });
        await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        const answer = await bootWorker(world).send({ type: 'shop-status' });
        assert.equal(answer.status.auth, false);
        assert.equal(answer.status.snapshotAgeMs, null);
        assert.equal(world.calls.length, 2, 'asking the status makes no network call');

        const fine = makeWorld({ onFetch: defaultFetch() });
        await bootWorker(fine).send({ type: 'shop-refresh' });
        fine.now += 5 * MIN;
        const status = (await bootWorker(fine).send({ type: 'shop-status' })).status;
        assert.equal(status.auth, true);
        assert.equal(status.ownKnown, true);
        assert.equal(status.snapshotAgeMs, 5 * MIN);
        assert.equal(status.stale, false);
    });
});

describe('shop-data: never throws to the page', () => {
    test('messages that are not shop-* are not touched', () => {
        const world = makeWorld({ onFetch: () => assert.fail('no fetch') });
        const { listener } = bootWorker(world);
        for (const message of [{ type: 'save-pdf' }, { action: 'get_downloads' }, { type: 'shop-nope' }, null, undefined, 'shop-lookup', {}]) {
            assert.equal(listener(message, {}, () => assert.fail('no answer')), false);
        }
    });

    test('shop-* messages keep the channel open', () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        assert.equal(bootWorker(world).listener({ type: 'shop-status' }, {}, () => {}), true);
    });

    test('storage down: still answers', async () => {
        const world = makeWorld({ onFetch: defaultFetch() });
        const worker = bootWorker(world);
        world.failStorage = true;
        const answer = await worker.send({ type: 'shop-lookup', items: [item()] });
        assert.ok(answer.marks['/products/abra'].result);
        assert.equal(answer.marks['/products/abra'].own.ownKnown, true);
    });

    test('garbage from the server is not cached and does not break', async () => {
        const world = worldWithSnapshot({}, () => jsonRes({ results: 'nope' }));
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: [item()] });
        assert.equal(answer.marks['/products/abra'].result, null);
        assert.equal(world.storage['shop:lookup:wulfgaming:/products/abra'], undefined);
    });

    test('items not being an array is an empty answer', async () => {
        const world = worldWithSnapshot({}, () => assert.fail('no fetch'));
        const answer = await bootWorker(world).send({ type: 'shop-lookup', items: 'nope' });
        assert.deepEqual(answer.marks, {});
        assert.equal(answer.ok, true);
    });
});

// ─── the toolbar button ──────────────────────────────────────────────────────

describe('shop-data: the toolbar button', () => {
    /** A worker whose chrome also has action, commands and tabs.onUpdated, recording each call. */
    function bootWithToolbar(world) {
        const listeners = [];
        const calls = [];
        const hooks = {};
        const sandbox = sandboxFor(world, listeners);
        const record = (name) => async (arg) => {
            calls.push([name, clone(arg)]);
        };
        sandbox.chrome.action = {
            setIcon: record('setIcon'),
            setBadgeText: record('setBadgeText'),
            setBadgeBackgroundColor: record('setBadgeBackgroundColor'),
            setBadgeTextColor: record('setBadgeTextColor'),
            setTitle: record('setTitle'),
        };
        sandbox.chrome.commands = { onCommand: { addListener: (fn) => (hooks.command = fn) } };
        sandbox.chrome.tabs.onUpdated = { addListener: (fn) => (hooks.tabUpdated = fn) };
        const query = sandbox.chrome.tabs.query;
        sandbox.chrome.tabs.query = async (filter) => (filter.active ? world.tabs.filter((tab) => tab.active) : query(filter));
        sandbox.chrome.runtime.openOptionsPage = async () => calls.push(['openOptionsPage']);
        const context = vm.createContext(sandbox);
        vm.runInContext(read('scripts/lib/shop-core.js'), context, { filename: 'shop-core.js' });
        vm.runInContext(read('scripts/lib/shop-data.js'), context, { filename: 'shop-data.js' });
        const listener = listeners[0];
        return {
            calls,
            hooks,
            send: (message, sender = {}) => new Promise((resolve) => listener(clone(message), sender, (answer) => resolve(clone(answer)))),
        };
    }

    const TAB = { tab: { id: 9 } };

    test('a badge goes to the tab that sent it, violet with ink text, and says what it counts', async () => {
        const worker = bootWithToolbar(makeWorld({ onFetch: () => assert.fail('no fetch') }));
        await flush();
        worker.calls.length = 0;
        const answer = await worker.send({ type: 'shop-badge', text: '3', kind: 'buy' }, TAB);
        assert.equal(answer.ok, true);
        assert.deepEqual(worker.calls, [
            ['setBadgeText', { tabId: 9, text: '3' }],
            ['setBadgeBackgroundColor', { tabId: 9, color: '#BA4EFF' }],
            ['setBadgeTextColor', { tabId: 9, color: '#090611' }],
            ['setTitle', { tabId: 9, title: 'PokeArgentum: 3 cartas para comprar en esta página' }],
        ]);
    });

    test('no session is an amber "!", and an empty badge clears without colors', async () => {
        const worker = bootWithToolbar(makeWorld({ onFetch: () => assert.fail('no fetch') }));
        await flush();
        worker.calls.length = 0;
        await worker.send({ type: 'shop-badge', text: '!', kind: 'login' }, TAB);
        assert.deepEqual(worker.calls[1], ['setBadgeBackgroundColor', { tabId: 9, color: '#B45309' }]);
        worker.calls.length = 0;
        await worker.send({ type: 'shop-badge', text: '', kind: null }, TAB);
        assert.deepEqual(worker.calls, [
            ['setBadgeText', { tabId: 9, text: '' }],
            ['setTitle', { tabId: 9, title: 'PokeArgentum' }],
        ]);
    });

    test('a badge from no tab (the popup) is ignored', async () => {
        const worker = bootWithToolbar(makeWorld({ onFetch: () => assert.fail('no fetch') }));
        await flush();
        worker.calls.length = 0;
        const answer = await worker.send({ type: 'shop-badge', text: '3', kind: 'buy' });
        assert.equal(answer.ok, false);
        assert.deepEqual(worker.calls, []);
    });

    test('the icon goes gray when the marks are off, at start and when the settings change', async () => {
        const world = makeWorld({ storage: { 'shop:settings': { enabled: false } }, onFetch: () => assert.fail('no fetch') });
        const worker = bootWithToolbar(world);
        await flush();
        assert.deepEqual(worker.calls.find(([name]) => name === 'setIcon'), ['setIcon', { path: { 16: '/icons/icon-off-16.png', 32: '/icons/icon-off-32.png' } }]);
        worker.calls.length = 0;
        world.storage['shop:settings'] = { enabled: true };
        await worker.send({ type: 'shop-settings-changed' });
        assert.deepEqual(worker.calls.find(([name]) => name === 'setIcon'), ['setIcon', { path: { 16: '/icons/icon-16.png', 32: '/icons/icon-32.png' } }]);
    });

    test('every icon path the worker sets exists', async () => {
        const off = bootWithToolbar(makeWorld({ storage: { 'shop:settings': { enabled: false } }, onFetch: () => assert.fail('no fetch') }));
        const on = bootWithToolbar(makeWorld({ storage: { 'shop:settings': { enabled: true } }, onFetch: () => assert.fail('no fetch') }));
        await flush();
        const paths = [...off.calls, ...on.calls].filter(([name]) => name === 'setIcon').flatMap(([, { path }]) => Object.values(path));
        assert.equal(paths.length, 4);
        for (const file of paths) assert.ok(existsSync(new URL(file.slice(1), root)), file);
    });

    test('shop-open-options opens the options page', async () => {
        const worker = bootWithToolbar(makeWorld({ onFetch: () => assert.fail('no fetch') }));
        await worker.send({ type: 'shop-open-options' }, TAB);
        assert.ok(worker.calls.some(([name]) => name === 'openOptionsPage'));
    });

    test('the shortcut tells the active tab to toggle its panel, and nothing else does', async () => {
        const world = makeWorld({ onFetch: () => assert.fail('no fetch') });
        world.tabs.push({ id: 4, url: 'https://store.gglehi.com/products/x', active: true }, { id: 5, url: 'https://www.tcgplayer.com/product/1' });
        const worker = bootWithToolbar(world);
        await worker.hooks.command('toggle-panel');
        await worker.hooks.command('something-else');
        assert.deepEqual(world.tabMessages, [{ tabId: 4, message: { type: 'shop:toggle-panel' } }]);
    });

    test('leaving a store clears the tab badge; a store page is left to its content script', async () => {
        const worker = bootWithToolbar(makeWorld({ onFetch: () => assert.fail('no fetch') }));
        await flush();
        worker.calls.length = 0;
        worker.hooks.tabUpdated(9, { url: 'https://www.google.com/search?q=x' });
        worker.hooks.tabUpdated(9, { url: 'https://store.gglehi.com/products/x' });
        worker.hooks.tabUpdated(9, { status: 'complete' });
        await flush();
        assert.deepEqual(worker.calls, [
            ['setBadgeText', { tabId: 9, text: '' }],
            ['setTitle', { tabId: 9, title: 'PokeArgentum' }],
        ]);
    });

    test('the manifest declares the shortcut the worker listens to, and the options page loads the core first', () => {
        const manifest = JSON.parse(read('manifest.json'));
        assert.ok(manifest.commands['toggle-panel']);
        assert.equal(manifest.options_ui.page, 'options.html');
        const options = read('options.html');
        assert.ok(options.includes('scripts/lib/shop-core.js'));
        assert.ok(options.indexOf('scripts/lib/shop-core.js') < options.indexOf('scripts/options.js'));
    });

    test('no text under 13px in the options page', () => {
        for (const [, size] of read('options.html').matchAll(/font(?:-size)?:\s*(\d+)px/g)) assert.ok(Number(size) >= 13, size);
    });
});

// ─── wiring ──────────────────────────────────────────────────────────────────

describe('service-worker.js hook', () => {
    const swSource = read('scripts/lib/service-worker.js');

    function bootRealSw(importScripts, logs) {
        const world = makeWorld({ onFetch: defaultFetch() });
        const listeners = [];
        const sandbox = sandboxFor(world, listeners, logs);
        sandbox.importScripts = (...files) => importScripts(files, context);
        const context = vm.createContext(sandbox);
        vm.runInContext(swSource, context, { filename: 'service-worker.js' });
        return { world, listeners };
    }

    test('the first line loads both files inside a try', () => {
        assert.match(swSource.split(/\r?\n/)[0], /^try \{ importScripts\('shop-core\.js', 'shop-data\.js'\); \} catch \(e\) \{ console\.error\(/);
    });

    test('with the real files both listeners coexist and shop-* gets answered', async () => {
        const { listeners } = bootRealSw((files, context) => {
            for (const file of files) vm.runInContext(read(`scripts/lib/${file}`), context, { filename: file });
        });
        assert.equal(listeners.length, 2);
        const answer = await new Promise((resolve) => {
            for (const listener of listeners) listener({ type: 'shop-status' }, {}, resolve);
        });
        assert.equal(answer.ok, true);
    });

    test('a bug in the shop files cannot take the rest of the SW down', () => {
        const logs = [];
        const { listeners } = bootRealSw(() => {
            throw new SyntaxError('broken shop-data');
        }, logs);
        assert.equal(listeners.length, 1, 'the ARCA and BringIt listener is still registered');
        assert.equal(logs[0][0], 'error');
    });
});

describe('manifest.json', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const entry = manifest.content_scripts.find((script) => script.js.includes('scripts/controllers/shop-marks.js'));

    // A missing css makes Chrome refuse the whole extension, ARCA and BringIt included.
    test('every referenced file exists', () => {
        const icons = (value) => (typeof value === 'string' ? [value] : Object.values(value || {}));
        const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, ...icons(manifest.action.default_icon), ...icons(manifest.icons)];
        for (const script of manifest.content_scripts) files.push(...(script.js || []), ...(script.css || []));
        assert.ok(files.includes('scripts/controllers/shop-marks.js'));
        assert.ok(files.includes('scripts/controllers/shop-marks.css'));
        for (const file of files) assert.ok(existsSync(new URL(file, root)), file);
    });

    test('tabs.query by url is allowed: the manifest has the permission', () => {
        assert.ok(manifest.permissions.includes('tabs'));
    });

    test('host permissions for the admin', () => {
        assert.ok(manifest.host_permissions.includes('https://cartas.konekotekka.com.ar/*'));
        assert.ok(manifest.host_permissions.includes('http://localhost:3000/*'));
    });

    test('the other session\'s Andreani hunk is still there', () => {
        const andreani = manifest.content_scripts.find((script) => script.js.includes('scripts/andreani.js'));
        assert.deepEqual(andreani.matches, ['https://pymes.andreani.com/*', 'https://andreani.com/cuenta/*', 'https://www.andreani.com/cuenta/*']);
    });

    test('content script at document_idle, core before marks', () => {
        assert.equal(entry.run_at, 'document_idle');
        assert.deepEqual(entry.js, ['scripts/lib/shop-core.js', 'scripts/controllers/shop-marks.js']);
        assert.deepEqual(entry.css, ['scripts/controllers/shop-marks.css']);
    });

    test('matches every store host in the core, and only store hosts', () => {
        const hosts = entry.matches.map((pattern) => new URL(pattern.replace('/*', '/')).hostname);
        for (const store of core.STORES) {
            const matched = hosts.filter((host) => storeFromHost(host) === store);
            assert.ok(matched.length >= 1, store.key);
        }
        for (const host of hosts) assert.ok(storeFromHost(host), host);
        for (const host of ['poke-collect.com', 'www.coolstuffinc.com', 'wulfgaming.com', 'store.gglehi.com', 'playerscandc.com', 'omotenashitcg.com', 'magicandmonsters.com', 'smokeandmirrorshobby.com', 'www.tcgplayer.com']) {
            assert.ok(hosts.includes(host), host);
        }
    });
});

describe('popup', () => {
    const html = read('pokeargentum.html');

    class FakeElement {
        constructor(attrs = {}) {
            Object.assign(this, { hidden: false, textContent: '', checked: false, disabled: false, href: '', children: [] }, attrs);
            this.handlers = {};
        }
        addEventListener(type, fn) {
            this.handlers[type] = fn;
        }
        fire(type) {
            return this.handlers[type]();
        }
        replaceChildren(...children) {
            this.children = children;
        }
        appendChild(child) {
            this.children.push(child);
        }
    }

    // Elements come from the real html: an id the script expects and the page lacks fails here.
    function bootPopup({ storage = {}, onMessage }) {
        const elements = {};
        for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements[id] = new FakeElement();
        elements['shop-refresh'].textContent = html.match(/id="shop-refresh">([^<]+)</)[1];
        const variants = [...html.matchAll(/name="shop-variant" value="([^"]+)"/g)].map(([, value]) => new FakeElement({ value }));
        const world = makeWorld({ storage });
        const messages = [];
        const sandbox = sandboxFor(world, []);
        sandbox.chrome.runtime.sendMessage = async (message) => {
            messages.push(message);
            return clone(await onMessage(message));
        };
        sandbox.document = {
            querySelector: () => new FakeElement(),
            querySelectorAll: () => variants,
            getElementById: (id) => elements[id] || null,
            createElement: () => new FakeElement(),
        };
        const context = vm.createContext(sandbox);
        vm.runInContext(read('scripts/lib/shop-core.js'), context);
        vm.runInContext(read('scripts/popup.js'), context);
        return { elements, variants, world, messages };
    }

    const signedIn = { auth: true, loginUrl: 'https://a/api/auth/signin', snapshotAgeMs: 3 * MIN, warnings: [], error: null, refreshing: false };

    test('the page loads the core before popup.js and offers the three variants', () => {
        assert.ok(html.indexOf('scripts/lib/shop-core.js') < html.indexOf('scripts/popup.js'));
        assert.deepEqual([...html.matchAll(/name="shop-variant" value="([^"]+)"/g)].map((m) => m[1]), ['a', 'b', 'c']);
    });

    test('no text under 13px in the section', () => {
        for (const [, size] of html.matchAll(/font(?:-size)?:\s*(\d+)px/g)) assert.ok(Number(size) >= 13, size);
    });

    test('renders saved settings, age and session', async () => {
        const { elements, variants } = bootPopup({
            storage: { 'shop:settings': { enabled: false, variant: 'b', dimOwned: true } },
            onMessage: () => ({ ok: true, status: signedIn }),
        });
        await flush();
        assert.equal(elements['shop-enabled'].checked, false);
        assert.equal(elements['shop-dim-owned'].checked, true);
        assert.deepEqual(variants.map((v) => v.checked), [false, true, false]);
        assert.equal(elements['shop-age'].textContent, 'hace 3 min');
        assert.equal(elements['shop-session'].textContent, 'iniciada');
        assert.equal(elements['shop-login'].hidden, true);
    });

    test('defaults with nothing saved, and no session shows the link to sign in', async () => {
        const { elements, variants } = bootPopup({
            onMessage: () => ({ ok: true, status: { ...signedIn, auth: false, snapshotAgeMs: null } }),
        });
        await flush();
        assert.equal(elements['shop-enabled'].checked, true);
        assert.deepEqual(variants.map((v) => v.checked), [false, false, true]);
        assert.equal(elements['shop-age'].textContent, 'todavía no hay datos');
        assert.equal(elements['shop-session'].textContent, 'sin sesión');
        assert.equal(elements['shop-login'].hidden, false);
        assert.equal(elements['shop-login'].href, 'https://a/api/auth/signin');
    });

    test('changes save merged, keeping what the content script stored there', async () => {
        const { elements, variants, world } = bootPopup({
            storage: { 'shop:settings': { enabled: true, variant: 'a', dimOwned: false, panelOpen: true } },
            onMessage: () => ({ ok: true, status: signedIn }),
        });
        await flush();

        variants[2].checked = true;
        variants[2].fire('change');
        await flush();
        assert.deepEqual(world.storage['shop:settings'], { ...DEFAULTS, enabled: true, variant: 'c', dimOwned: false, panelOpen: true });

        elements['shop-dim-owned'].checked = true;
        elements['shop-dim-owned'].fire('change');
        await flush();
        elements['shop-enabled'].checked = false;
        elements['shop-enabled'].fire('change');
        await flush();
        assert.deepEqual(world.storage['shop:settings'], { ...DEFAULTS, enabled: false, variant: 'c', dimOwned: true, panelOpen: true });
    });

    test('panelCollapsed: saving a setting does not invent one, and keeps one that was chosen', async () => {
        const none = bootPopup({ onMessage: () => ({ ok: true, status: signedIn }) });
        await flush();
        none.elements['shop-dim-owned'].checked = true;
        none.elements['shop-dim-owned'].fire('change');
        await flush();
        assert.equal('panelCollapsed' in none.world.storage['shop:settings'], false);

        const chosen = bootPopup({ storage: { 'shop:settings': { panelCollapsed: false } }, onMessage: () => ({ ok: true, status: signedIn }) });
        await flush();
        chosen.elements['shop-dim-owned'].checked = true;
        chosen.elements['shop-dim-owned'].fire('change');
        await flush();
        assert.equal(chosen.world.storage['shop:settings'].panelCollapsed, false);
    });

    test('after saving a setting it tells the SW, once per change and with the setting already saved', async () => {
        let savedWhenTold = null;
        const { elements, world, messages } = bootPopup({
            onMessage: (message) => {
                if (message.type === 'shop-settings-changed') savedWhenTold = world.storage['shop:settings'];
                return { ok: true, status: signedIn };
            },
        });
        await flush();
        assert.deepEqual(messages.map((m) => m.type), ['shop-status']);

        elements['shop-dim-owned'].checked = true;
        elements['shop-dim-owned'].fire('change');
        await flush();
        assert.deepEqual(messages.map((m) => m.type), ['shop-status', 'shop-settings-changed']);
        assert.equal(savedWhenTold.dimOwned, true);
    });

    test('a dead SW does not lose the setting', async () => {
        const { elements, world } = bootPopup({
            onMessage: () => {
                throw new Error('Could not establish connection');
            },
        });
        await flush();
        elements['shop-dim-owned'].checked = true;
        await elements['shop-dim-owned'].fire('change');
        assert.equal(world.storage['shop:settings'].dimOwned, true);
    });

    test('refresh button asks the SW, blocks while it runs and shows the outcome', async () => {
        const gate = deferred();
        const { elements, messages } = bootPopup({
            onMessage: (message) => (message.type === 'shop-refresh' ? gate.promise : { ok: true, status: signedIn }),
        });
        await flush();
        const button = elements['shop-refresh'];
        const label = button.textContent;

        const done = button.fire('click');
        await flush();
        assert.equal(button.disabled, true);
        assert.deepEqual(messages.map((m) => m.type), ['shop-status', 'shop-refresh']);

        gate.resolve({ ok: false, status: { ...signedIn, error: 'HTTP 500', warnings: ['PA no contestó'] } });
        await done;
        assert.equal(button.disabled, false);
        assert.equal(button.textContent, label);
        assert.equal(elements['shop-warnings'].hidden, false);
        assert.deepEqual(elements['shop-warnings'].children.map((c) => c.textContent), ['No se pudo actualizar: HTTP 500', 'PA no contestó']);
    });

    test('a dead SW does not break the popup', async () => {
        const { elements } = bootPopup({
            onMessage: () => {
                throw new Error('Could not establish connection');
            },
        });
        await flush();
        assert.match(elements['shop-age'].textContent, /Could not establish/);
        assert.equal(elements['shop-session'].textContent, 'sin chequear');
    });
});
