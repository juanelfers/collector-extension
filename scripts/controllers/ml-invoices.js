// ============================================================================
// Driver de carga de facturas en MercadoLibre — "Subir facturas a ML"
// ----------------------------------------------------------------------------
// Espejo del driver de ARCA (all.js) pero para el otro lado del circuito:
// recorre https://vendedores.mercadolibre.com.ar/emisor/adjuntar-factura
// orden por orden, adjuntando el PDF que all.js capturó y dejó en
// chrome.storage.local (key `invoicePdfs`, base64 por orderId).
//
// Estado en chrome.storage.local bajo la key `mlUpload`:
//   { active, queue: [orderId...], results: [{orderId, status, detail, at}], attempts: {} }
//   - queue[0] es la orden EN CURSO; se saca al subirse o fallar.
//
// La página de ML es una SPA que puede cambiar sin aviso, así que el driver es
// deliberadamente conservador: si no encuentra el input de archivo o el botón
// de confirmar, NO adivina — muestra el panel con "Subila a mano y tocá
// Continuar" y espera. TO-VERIFY: selectores contra la página real.
// ============================================================================

const STORAGE_KEY = 'mlUpload';
const PAGE_RE = /vendedores\.mercadolibre\.com\.ar\/emisor\/adjuntar-factura/;
// Verificado 2026-09-06: al aceptar el PDF, ML navega la pestaña ENTERA al
// detalle de la venta (/ventas/{idOrden}/detalle). El content script de la
// pantalla de adjuntar muere ahí sin anotar nada, así que el desenlace se lee
// en la página de detalle: "Factura de la venta · Factura electrónica
// {venta}.pdf". Antes de confirmar se deja `inFlight` en el storage.
const DETAIL_RE = /mercadolibre\.com\.ar\/ventas\/(\d+)\/detalle/;
const INVOICED_RE = /factura\s+de\s+la\s+venta|factura\s+electr[óo]nica\s+\d+\.pdf/i;
// La pantalla de ML sólo acepta el id de ORDEN. La clave de la cola es el id
// del pack (el mismo que usa el admin); `entry.mlOrderId` trae el de la orden.
const urlFor = (orderId, entry) => `https://vendedores.mercadolibre.com.ar/emisor/adjuntar-factura?orders_ids=${entry?.mlOrderId || orderId}`;

const getState = () => chrome.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] || null);
const setState = (state) => chrome.storage.local.set({ [STORAGE_KEY]: state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPdf(orderId) {
    const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
    return invoicePdfs[orderId] || null;
}

// Cuánto se guarda el base64 de una factura YA subida. El PDF se conserva a
// propósito: si la subida fue un falso positivo, sin esto quedaba marcada como
// hecha y sin archivo para reintentar. El manifest pide `unlimitedStorage`, así
// que lo único que hace falta es no acumular para siempre.
const KEEP_UPLOADED_MS = 30 * 24 * 60 * 60 * 1000;

async function markUploaded(orderId) {
    const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
    if (!invoicePdfs[orderId]) return;
    invoicePdfs[orderId] = { ...invoicePdfs[orderId], uploaded: true, at: Date.now() };
    // Recién acá soltamos los base64 viejos: a esta altura ya se verificaron en
    // ML y sólo ocupan lugar.
    const cutoff = Date.now() - KEEP_UPLOADED_MS;
    for (const [id, entry] of Object.entries(invoicePdfs)) {
        if (entry?.uploaded && entry.dataUrl && (entry.at || 0) < cutoff) {
            invoicePdfs[id] = { uploaded: true, at: entry.at };
        }
    }
    await chrome.storage.local.set({ invoicePdfs });
}

function waitFor(getter, { timeout = 15000, interval = 300 } = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const hit = getter();
            if (hit) {
                clearInterval(iv);
                resolve(hit);
            } else if (Date.now() - start > timeout) {
                clearInterval(iv);
                resolve(null);
            }
        }, interval);
    });
}

// El input de archivo suele estar oculto detrás de un botón estilado (Andes),
// así que acá NO se filtra por visibilidad. Se prefiere el que declara PDF.
const findFileInput = () =>
    document.querySelector('input[type=file][accept*="pdf"]')
    || document.querySelector('input[type=file]');

// Botón de confirmar la subida. La página es una SPA de ML (componentes Andes):
// buscamos por texto entre los botones visibles. TO-VERIFY.
// El negativo importa tanto como el positivo: "Cancelar" y "Volver" matchean
// varias de estas palabras en sus labels largos y mandarían el flujo al carajo.
const SUBMIT_RE = /adjuntar|enviar|confirmar|guardar|subir/i;
const NOT_SUBMIT_RE = /cancelar|volver|cerrar|salir|atr[áa]s|descartar|eliminar|quitar/i;

function findSubmit() {
    return [...document.querySelectorAll('button, [role=button]')]
        .filter((b) => !b.disabled && b.offsetParent !== null)
        .filter((b) => !NOT_SUBMIT_RE.test(b.textContent || ''))
        .find((b) => SUBMIT_RE.test(b.textContent || ''));
}

// Señales de que ML aceptó la factura. Se usan como confirmación POSITIVA: sin
// alguna de estas no damos por subida nada (ver waitForOutcome).
const SUCCESS_RE = /factura\s+(adjuntada|cargada|subida)|se\s+adjunt[óo]|adjuntada\s+correctamente|con\s+[ée]xito|listo/i;

function visibleErrorText() {
    const node = [...document.querySelectorAll('[class*=error], [class*=danger], [role=alert]')]
        .find((n) => n.offsetParent !== null && (n.textContent || '').trim());
    return node ? node.textContent.trim().slice(0, 160) : null;
}

// Después de confirmar, esperamos un desenlace EXPLÍCITO. El criterio viejo era
// "si no veo un div de error, salió bien", y en una SPA eso da falso positivo
// con cualquier fallo mudo: marcaba la factura como subida sin estarlo. Ahora,
// si no hay señal clara, devolvemos null y se lo preguntamos al humano.
async function waitForOutcome({ timeout = 12000, interval = 400 } = {}) {
    const start = Date.now();
    const startUrl = location.href;
    for (;;) {
        const err = visibleErrorText();
        if (err) return { status: 'error', detail: err };

        if (SUCCESS_RE.test(document.body?.innerText || '')) return { status: 'ok', detail: 'texto de éxito' };
        // Salir de la pantalla de adjuntar también cuenta: ML navega al volver.
        if (location.href !== startUrl && !PAGE_RE.test(location.href)) {
            return { status: 'ok', detail: 'ML navegó fuera de la pantalla' };
        }
        // El formulario desapareció y no hay error a la vista: la subida se tomó.
        // Con piso de tiempo, porque la SPA puede desmontar el input un instante
        // mientras procesa y eso no es un éxito, es un spinner.
        const elapsed = Date.now() - start;
        if (elapsed > 2500 && !findFileInput()) return { status: 'ok', detail: 'el formulario se cerró' };

        if (elapsed > timeout) return null;
        await sleep(interval);
    }
}

// El truco estándar para setear un input file por código: DataTransfer.
// React lee event.target.files, así que con el change event alcanza.
async function attachPdf(input, orderId, entry) {
    const blob = await (await fetch(entry.dataUrl)).blob();
    const file = new File([blob], `${orderId}.pdf`, { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

// ----------------------------------------------------- avanzar / terminar ----
async function shiftAndGoNext(orderId, status, detail) {
    const fresh = (await getState()) || {};
    fresh.results = [...(fresh.results || []), { orderId, status, detail: detail || null, at: Date.now() }];
    fresh.queue = (fresh.queue || []).slice(1);
    fresh.inFlight = null;
    if (!fresh.queue.length) fresh.active = false; // terminó: que el admin lo vea como terminada
    await setState(fresh);
    if (fresh.queue.length) {
        location.href = urlFor(fresh.queue[0], await getPdf(fresh.queue[0]));
    } else {
        renderDonePanel(fresh);
    }
}

// -------------------------------------------------------------------- UI -----
function ensurePanel() {
    let el = document.getElementById('pa-ml-panel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pa-ml-panel';
    el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'background:#0b0b14', 'color:#fff', 'border:1px solid #F5CE4B', 'border-radius:12px',
        'padding:14px 16px', 'width:300px', 'font:13px/1.4 system-ui,sans-serif',
        'box-shadow:0 8px 30px rgba(0,0,0,.5)',
    ].join(';');
    document.documentElement.appendChild(el);
    return el;
}

function btnStyle(bg) {
    return `flex:1;padding:6px 8px;background:${bg};color:#fff;border:0;border-radius:8px;cursor:pointer;font:600 12px system-ui`;
}

function progressOf(state) {
    const done = (state.results || []).length;
    const left = (state.queue || []).length;
    return { done, left, total: done + left };
}

function renderPanel(state, orderId, note) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Subiendo a ML ${done + 1}/${total}</div>
        <div style="opacity:.85">Venta <b>${orderId}</b></div>
        ${note ? `<div style="margin-top:4px;opacity:.85">${note}</div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-ml-pause" style="${btnStyle('#333')}">Pausar</button>
            <button id="pa-ml-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-ml-pause').onclick = async () => {
        const s = (await getState()) || state;
        s.active = false;
        await setState(s);
        renderPausedPanel(s);
    };
    el.querySelector('#pa-ml-cancel').onclick = cancelAll;
}

// Cuando el driver no encuentra algo en la página, no adivinamos: que el humano
// termine ESTA orden a mano y toque Continuar (ok) o Saltar (error).
function renderManualPanel(state, orderId, reason) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Necesito una mano (${done + 1}/${total})</div>
        <div style="opacity:.85">Orden <b>${orderId}</b></div>
        <div style="margin-top:4px;opacity:.85">${reason}</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-ml-done" style="${btnStyle('#1f7a3a')}">Ya la subí, seguir</button>
            <button id="pa-ml-skip" style="${btnStyle('#7a1f1f')}">Saltar</button>
        </div>`;
    el.querySelector('#pa-ml-done').onclick = async () => {
        await markUploaded(orderId);
        shiftAndGoNext(orderId, 'ok', 'Subida a mano');
    };
    el.querySelector('#pa-ml-skip').onclick = () => shiftAndGoNext(orderId, 'error', reason);
}

function renderPausedPanel(state) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Subida a ML en pausa</div>
        <div style="opacity:.85">${done}/${total} hechas · ${total - done} pendientes</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-ml-resume" style="${btnStyle('#1f7a3a')}">Reanudar</button>
            <button id="pa-ml-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-ml-resume').onclick = async () => {
        const s = (await getState()) || state;
        s.active = true;
        await setState(s);
        if (s.queue?.length) location.href = urlFor(s.queue[0], await getPdf(s.queue[0]));
    };
    el.querySelector('#pa-ml-cancel').onclick = cancelAll;
}

function renderDonePanel(state) {
    const el = ensurePanel();
    const results = state.results || [];
    const ok = results.filter((r) => r.status === 'ok').length;
    const err = results.length - ok;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturas subidas ✅</div>
        <div>${ok} subida(s)${err ? ` · <span style="color:#ff8a8a">${err} con error</span>` : ''}</div>
        ${err ? `<div style="margin-top:6px;max-height:120px;overflow:auto;opacity:.8">${results.filter((r) => r.status === 'error').map((r) => `· ${r.orderId}: ${r.detail || 'error'}`).join('<br>')}</div>` : ''}
        <div style="margin-top:10px"><button id="pa-ml-close" style="${btnStyle('#333')}">Cerrar</button></div>`;
    el.querySelector('#pa-ml-close').onclick = async () => {
        // Se conserva el estado (resultados) para el progreso del admin; el
        // panel no vuelve a aparecer en las páginas de detalle.
        const s = (await getState()) || state;
        s.closed = true;
        await setState(s);
        el.remove();
    };
}

async function cancelAll() {
    await chrome.storage.local.remove(STORAGE_KEY);
    document.getElementById('pa-ml-panel')?.remove();
}

// Página de detalle de una venta: es donde ML deja la pestaña después de
// aceptar el PDF. Si hay una subida en vuelo (o la orden en curso ya figura
// con factura, p.ej. porque ML redirige acá una orden ya facturada), se marca
// y se sigue con la siguiente.
async function onDetailPage(state) {
    const urlOrder = (location.href.match(DETAIL_RE) || [])[1];
    const current = state.queue?.[0] ? String(state.queue[0]) : null;
    const entry = current ? await getPdf(current) : null;
    const currentMl = entry?.mlOrderId || current;
    const inFlight = state.inFlight?.orderId ? String(state.inFlight.orderId) : null;
    if (!current) return;
    // Detalle de OTRA orden: la cola ya avanzó (el driver de adjuntar llegó a
    // anotar el resultado y a pedir la siguiente, pero ML ganó la carrera con
    // su propia navegación al detalle) y la pestaña quedó acá, muda. Seguimos
    // con la orden en curso.
    if (urlOrder !== currentMl) {
        console.log('[PokeArgentum] ML subida: detalle de otra orden, sigo con', current);
        location.href = urlFor(current, entry);
        return;
    }
    if (!inFlight && (state.attempts?.[current] || 0) === 0) return;

    renderPanel(state, current, 'Verificando en el detalle de la venta…');
    const ok = await waitFor(() => INVOICED_RE.test(document.body?.innerText || ''), { timeout: 15000 });
    if (ok) {
        await markUploaded(current);
        await shiftAndGoNext(current, 'ok', inFlight ? 'ML mostró la factura en el detalle' : 'Ya figuraba con factura en ML');
        return;
    }
    renderManualPanel(state, current, 'Confirmé la subida pero el detalle de la venta no muestra la factura. Fijate si quedó cargada.');
}

// ------------------------------------------------------------------ main -----
(async function main() {
    const onDetail = DETAIL_RE.test(location.href);
    if (!PAGE_RE.test(location.href) && !onDetail) return;

    const state = await getState();
    if (!state) return;
    if (onDetail) {
        if (state.active && state.queue?.length) await onDetailPage(state);
        else if (!state.queue?.length && state.results?.length && !state.closed) renderDonePanel(state);
        return;
    }

    if (!state.queue || !state.queue.length) {
        if (state.results?.length && !state.closed) renderDonePanel(state);
        return;
    }
    if (!state.active) {
        renderPausedPanel(state);
        return;
    }

    const orderId = String(state.queue[0]);

    // Watchdog anti-loop, igual que en ARCA.
    state.attempts = state.attempts || {};
    state.attempts[orderId] = (state.attempts[orderId] || 0) + 1;
    await setState(state);
    if (state.attempts[orderId] > 6) {
        return shiftAndGoNext(orderId, 'error', 'Demasiados intentos en la página de ML');
    }

    const entry = await getPdf(orderId);

    // ¿Estamos parados en la orden correcta? (id de orden de ML, no el del pack)
    const urlOrder = new URLSearchParams(location.search).get('orders_ids');
    const wanted = entry?.mlOrderId || orderId;
    if (urlOrder !== wanted) {
        location.href = urlFor(orderId, entry);
        return;
    }

    renderPanel(state, orderId, 'Buscando el formulario…');
    if (!entry?.dataUrl) {
        return renderManualPanel(state, orderId, entry?.uploaded
            ? 'Esta ya figura como subida.'
            : 'No tengo el PDF de esta orden (¿se facturó con "Imprimir" viejo?). Está en Descargas/facturas-arca.');
    }

    const input = await waitFor(findFileInput);
    if (!input) {
        return renderManualPanel(state, orderId, 'No encontré el input de archivo en la página.');
    }

    try {
        await attachPdf(input, orderId, entry);
    } catch (e) {
        return renderManualPanel(state, orderId, `No pude adjuntar el PDF: ${e.message}`);
    }
    renderPanel(state, orderId, 'PDF adjuntado, confirmando…');
    await sleep(1500); // que la SPA procese el archivo y habilite el botón

    const submit = await waitFor(findSubmit, { timeout: 8000 });
    if (!submit) {
        return renderManualPanel(state, orderId, 'Adjunté el PDF pero no encontré el botón de confirmar: revisá y confirmá a mano.');
    }
    // Antes de confirmar: si ML navega al detalle, el script de esa página
    // termina el trabajo (marca la factura y sigue con la siguiente).
    {
        const s = (await getState()) || state;
        s.inFlight = { orderId, at: Date.now() };
        await setState(s);
    }
    submit.click();
    renderPanel(state, orderId, 'Confirmado, esperando a ML…');

    const outcome = await waitForOutcome();
    console.log('[PokeArgentum] ML subida', orderId, outcome);

    if (outcome?.status === 'error') {
        return renderManualPanel(state, orderId, `ML mostró un error: ${outcome.detail}`);
    }
    // Sin confirmación NO marcamos nada: preferimos preguntar antes que anotar
    // como subida una factura que no llegó. Los selectores de esta pantalla
    // están sin verificar, así que este camino es el esperable la primera vez.
    if (!outcome) {
        return renderManualPanel(
            state,
            orderId,
            'Adjunté el PDF y confirmé, pero ML no me devolvió una señal clara. Fijate en la pantalla si quedó cargada.',
        );
    }
    await markUploaded(orderId);
    await shiftAndGoNext(orderId, 'ok', outcome.detail);
})();
