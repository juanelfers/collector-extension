// "Editar en mi admin" en la ficha de MercadoLibre.
//
// Ver una publicación propia en ML y querer tocarla termina siempre igual: abrir
// el admin, buscar el artículo a mano, encontrarlo. Este script planta un link al
// lado de "Modificar" que lleva derecho a la pantalla donde se edita.
//
// Del lado del admin la ruta /admin/ml/<MLA...> es la que resuelve QUÉ es ese ID
// (un artículo del inventario, una carta suelta o un Hot Wheels) y redirige a la
// pantalla que corresponde. Acá sólo hay que sacar el ID y armar el link, así
// que un cambio de layout en ML no rompe nada del otro lado.
//
// El link aparece SÓLO en publicaciones propias. La marca es la barra de
// vendedor ("Modificar / Vender uno igual"), que ML dibuja únicamente cuando la
// ficha es tuya, o estar adentro del panel /publicaciones/. Si algún día ML
// cambia esa barra y el link deja de aparecer, aflojar `sellerBar()`.

const ADMIN_BASE_DEFAULT = 'https://cartas.konekotekka.com.ar';
const ADMIN_BASE_LOCAL = 'http://localhost:3000';
const LINK_ID = 'ka-admin-link';
const ACCENT = '#5939C2'; // violeta de Konekotekka
// ML dibuja la barra de vendedor tarde (y a veces la vuelve a dibujar). Después
// de esta ventana se deja de barrer el DOM por texto: en una publicación ajena
// no va a aparecer nunca y el script queda corriendo en cualquier pestaña de ML.
const SCAN_WINDOW_MS = 20000;

let adminBase = ADMIN_BASE_DEFAULT;
let scanUntil = Date.now() + SCAN_WINDOW_MS;
let lastUrl = location.href;

// El admin de producción por default; para probar contra el dev server:
//   chrome.storage.local.set({ adminBase: 'http://localhost:3000' })
// o Shift + click en el link, que abre localhost:3000 esta vez sola.
chrome.storage.local.get('adminBase').then(({ adminBase: saved }) => {
    if (saved) adminBase = saved;
});

/** El ID de la publicación tal como lo pide la API: MLA1234567890. */
function itemIdFromUrl() {
    const url = new URL(location.href);

    // Ficha de producto (/p/ y /up/): la publicación elegida viaja en el filtro.
    const filters = url.searchParams.get('pdp_filters') || '';
    const inFilters = filters.match(/item_id[:=](ML[A-Z]\d{6,})/i);
    if (inFilters) return inFilters[1].toUpperCase();

    const param = url.searchParams.get('item_id') || url.searchParams.get('itemId');
    if (param && /^ML[A-Z]\d{6,}$/i.test(param.trim())) return param.trim().toUpperCase();

    // articulo.mercadolibre.com.ar/MLA-1234567890-titulo-_JM y el panel de
    // vendedor /publicaciones/MLA1234567890/modificar. El guión es opcional.
    // Ojo: en /up/MLAU4097719875 no matchea (MLAU no es un ID de publicación),
    // que es justo lo que se quiere: ese es el producto, no la publicación.
    const inPath = location.pathname.match(/\/(ML[A-Z])-?(\d{6,})/i);
    if (inPath) return `${inPath[1].toUpperCase()}${inPath[2]}`;

    return null;
}

/** Si la URL no lo trae, buscarlo en el DOM (links del panel, canonical, og:url). */
function itemIdFromDom() {
    const hrefs = [
        document.querySelector('a[href*="/publicaciones/ML"]')?.href,
        document.querySelector('link[rel="canonical"]')?.href,
        document.querySelector('meta[property="og:url"]')?.content,
    ];

    for (const href of hrefs) {
        const found = href?.match(/\b(ML[A-Z])-?(\d{6,})\b/);
        if (found) return `${found[1].toUpperCase()}${found[2]}`;
    }

    return null;
}

/**
 * La barra de acciones del vendedor ("Modificar · Vender uno igual · Compartir").
 * Es la prueba de que la publicación es tuya y el lugar donde va el link.
 */
function sellerBar() {
    const byHref = document.querySelector(
        'a[href*="/publicaciones/"][href*="modificar"], a[href*="/item/modificar"]',
    );
    if (byHref) return byHref;

    // Barrido por texto: sólo mientras la página se termina de dibujar.
    if (Date.now() > scanUntil) return null;

    return (
        [...document.querySelectorAll('a, button')].find((el) =>
            /^(modificar|vender uno igual)$/i.test(el.textContent.trim()),
        ) || null
    );
}

/** Adentro del panel del vendedor la publicación es tuya por definición. */
const inSellerPanel = () => /\/publicaciones\/ML[A-Z]\d{6,}/i.test(location.pathname);

const adminUrl = (itemId, base = adminBase) => `${base}/admin/ml/${itemId}`;

function buildLink(itemId) {
    const link = document.createElement('a');

    link.id = LINK_ID;
    link.dataset.itemId = itemId;
    link.textContent = 'Editar en mi admin';
    link.href = adminUrl(itemId);
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'Abrir la ficha en el admin (Shift + click → localhost:3000)';

    // Shift + click para probar contra el dev server sin tocar la config.
    link.addEventListener('click', (e) => {
        if (!e.shiftKey) return;
        e.preventDefault();
        window.open(adminUrl(link.dataset.itemId, ADMIN_BASE_LOCAL), '_blank', 'noopener');
    });

    return link;
}

function mountInBar(itemId, bar) {
    const link = buildLink(itemId);

    Object.assign(link.style, {
        color: ACCENT,
        fontSize: '14px',
        fontWeight: '600',
        marginLeft: '14px',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
    });

    (bar.parentElement || bar).append(link);
}

function mountFloating(itemId) {
    const link = buildLink(itemId);

    Object.assign(link.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '9999',
        padding: '10px 16px',
        borderRadius: '999px',
        background: ACCENT,
        color: '#fff',
        fontSize: '14px',
        fontWeight: '600',
        textDecoration: 'none',
        boxShadow: '0 4px 14px rgba(0, 0, 0, .25)',
    });

    document.body.append(link);
}

function sync() {
    // Cambiar de variante en la ficha (color, unidades por pack) cambia la URL
    // sin recargar: el link tiene que apuntar a la publicación que se está viendo.
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        scanUntil = Date.now() + SCAN_WINDOW_MS;
    }

    const itemId = itemIdFromUrl() || itemIdFromDom();
    const mounted = document.getElementById(LINK_ID);

    if (!itemId) {
        mounted?.remove();
        return;
    }

    if (mounted) {
        if (mounted.dataset.itemId !== itemId) {
            mounted.dataset.itemId = itemId;
            mounted.href = adminUrl(itemId);
        }
        return;
    }

    if (inSellerPanel()) return mountFloating(itemId);

    const bar = sellerBar();
    if (bar) mountInBar(itemId, bar);
}

sync();
setInterval(sync, 2000);
