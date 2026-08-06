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
const urlFor = (orderId) => `https://vendedores.mercadolibre.com.ar/emisor/adjuntar-factura?orders_ids=${orderId}`;

const getState = () => chrome.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] || null);
const setState = (state) => chrome.storage.local.set({ [STORAGE_KEY]: state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPdf(orderId) {
    const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
    return invoicePdfs[orderId] || null;
}

async function markUploaded(orderId) {
    const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
    if (invoicePdfs[orderId]) {
        // Sacamos el base64 (pesa) y dejamos la marca, así el admin puede saber
        // qué se subió y el storage no explota con cientos de PDFs.
        invoicePdfs[orderId] = { uploaded: true, at: Date.now() };
        await chrome.storage.local.set({ invoicePdfs });
    }
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

const findFileInput = () => document.querySelector('input[type=file]');

// Botón de confirmar la subida. La página es una SPA de ML (componentes Andes):
// buscamos por texto entre los botones visibles. TO-VERIFY.
function findSubmit() {
    return [...document.querySelectorAll('button')]
        .filter((b) => !b.disabled && b.offsetParent !== null)
        .find((b) => /adjuntar|enviar|confirmar|guardar|subir/i.test(b.textContent || ''));
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
    await setState(fresh);
    if (fresh.queue.length) {
        location.href = urlFor(fresh.queue[0]);
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
        <div style="opacity:.85">Orden <b>${orderId}</b></div>
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
        if (s.queue?.length) location.href = urlFor(s.queue[0]);
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
        await chrome.storage.local.remove(STORAGE_KEY);
        el.remove();
    };
}

async function cancelAll() {
    await chrome.storage.local.remove(STORAGE_KEY);
    document.getElementById('pa-ml-panel')?.remove();
}

// ------------------------------------------------------------------ main -----
(async function main() {
    if (!PAGE_RE.test(location.href)) return;

    const state = await getState();
    if (!state) return;

    if (!state.queue || !state.queue.length) {
        if (state.results?.length) renderDonePanel(state);
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

    // ¿Estamos parados en la orden correcta?
    const urlOrder = new URLSearchParams(location.search).get('orders_ids');
    if (urlOrder !== orderId) {
        location.href = urlFor(orderId);
        return;
    }

    renderPanel(state, orderId, 'Buscando el formulario…');

    const entry = await getPdf(orderId);
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
    submit.click();
    await sleep(3000); // esperar la respuesta de ML

    // Éxito heurístico: si la página no muestra un error visible, damos por ok.
    const errBox = [...document.querySelectorAll('[class*=error], [class*=danger]')]
        .find((n) => n.offsetParent !== null && (n.textContent || '').trim());
    if (errBox) {
        return renderManualPanel(state, orderId, `ML mostró un error: ${errBox.textContent.trim().slice(0, 120)}`);
    }
    await markUploaded(orderId);
    await shiftAndGoNext(orderId, 'ok');
})();
