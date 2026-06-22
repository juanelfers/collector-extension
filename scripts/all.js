// ============================================================================
// Motor de facturación automática en ARCA (AFIP) — "Facturar todo"
// ----------------------------------------------------------------------------
// El admin de PokeArgentum manda una COLA de ventas a la extensión (vía el
// bridge, ver controllers/tcg-premium.js). Acá, en las páginas de ARCA, este
// script toma la cola desde chrome.storage.local y va generando factura por
// factura, solo, recorriendo los pasos del comprobante en línea (RCEL):
//
//   buscarPtosVtas.do  -> punto de venta + tipo de comprobante (A/B)
//   genComDatosEmisor  -> fecha (HOY, dinámica), concepto, actividad
//   genComDatosReceptor-> condición IVA, tipo/nro de doc, forma de pago
//   genComDatosOperacion-> descripción, cantidad, precio (neto+IVA si es A)
//   genComResumenDatos -> Generar -> Imprimir -> vuelve al inicio (siguiente)
//
// Estado en chrome.storage.local bajo la key `invoicing`:
//   { active, mode: 'auto'|'confirm', config, queue:[inv...], results:[...], attempts:{} }
//   - queue[0] es la factura EN CURSO; se saca recién cuando se genera o falla.
//   - results acumula { orderId, status:'ok'|'error', detail, at }.
//
// A vs B: por número de documento. >=11 dígitos => CUIT => Factura A (discrimina
// IVA). Si no => DNI => Factura B (consumidor final, IVA incluido).
//
// OJO (CONFIRMAR EN VIVO): los valores marcados TO-VERIFY (perfil A: universo,
// condición IVA, alícuota) salen de la doc de AFIP pero no se pudieron probar
// contra el sitio real. La rama B replica lo que ya venías usando.
// ============================================================================

const STORAGE_KEY = 'invoicing';
const START_URL = '/rcel/jsp/buscarPtosVtas.do';
const ON_AFIP = location.href.includes('fe.afip.gob.ar/rcel');

// Perfiles por tipo de comprobante. B = valores ya probados. A = best-effort.
const TYPE_PROFILES = {
    B: { universoComprobante: '2', idivareceptor: '5' /* consumidor final */, discriminaIva: false },
    A: { universoComprobante: '1', idivareceptor: '1' /* responsable inscripto — TO-VERIFY */, discriminaIva: true },
};
const IVA_21_ID = '5'; // id de alícuota 21% en AFIP — TO-VERIFY

// ---------------------------------------------------------------- helpers ----
const getState = () => chrome.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] || null);
const setState = (state) => chrome.storage.local.set({ [STORAGE_KEY]: state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const invoiceType = (inv) => (onlyDigits(inv.clientId).length >= 11 ? 'A' : 'B');
const docTypeFor = (inv) => (onlyDigits(inv.clientId).length >= 11 ? '80' /* CUIT */ : '96' /* DNI */);

function todayDDMMYYYY() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function triggerChange(el) {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setValue(el, value) {
    if (!el) return;
    el.value = value;
    triggerChange(el);
}

function waitFor(selector, { timeout = 9000 } = {}) {
    return new Promise((resolve, reject) => {
        const hit = document.querySelector(selector);
        if (hit) return resolve(hit);
        const start = Date.now();
        const iv = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(iv);
                resolve(el);
            } else if (Date.now() - start > timeout) {
                clearInterval(iv);
                reject(new Error(`No apareció el elemento: ${selector}`));
            }
        }, 150);
    });
}

function findContinue() {
    return [...document.querySelectorAll('input[type=button], input[type=submit], button')]
        .find((b) => /continuar/i.test(b.value || b.textContent || ''));
}
function clickContinue() {
    const btn = findContinue();
    if (!btn) throw new Error('No se encontró el botón "Continuar"');
    btn.click();
}
function tryClickContinue() {
    const btn = findContinue();
    if (btn) btn.click();
    return Boolean(btn);
}

// Detección conservadora de error de validación de AFIP en la página actual.
function afipError() {
    const box = document.querySelector('#ha, .msg_error, .error, [class*=error]');
    const txt = (box?.innerText || '').trim();
    if (txt && /(obligatorio|verifique|inválid|invalid|error|no es correcto)/i.test(txt)) return txt.slice(0, 200);
    return null;
}

// ------------------------------------------------------------------ steps ----
function selectComprobanteType(type) {
    // Si AFIP muestra un <select> de tipo de comprobante (aparte de universo),
    // elegimos "Factura A"/"Factura B" por texto. Best-effort. TO-VERIFY.
    const re = type === 'A' ? /factura\s*a\b/i : /factura\s*b\b/i;
    for (const sel of document.querySelectorAll('select')) {
        if (sel.name === 'universoComprobante') continue;
        const opt = [...sel.options].find((o) => re.test(o.textContent));
        if (opt) {
            sel.value = opt.value;
            triggerChange(sel);
            return true;
        }
    }
    return false;
}

async function stepStart(inv, cfg) {
    const pv = await waitFor('[name=puntoDeVenta]');
    setValue(pv, cfg.puntoDeVenta || '1');
    const profile = TYPE_PROFILES[invoiceType(inv)];
    const universo = document.querySelector('[name=universoComprobante]');
    if (universo) setValue(universo, profile.universoComprobante);
    await sleep(300); // el tipo de comprobante puede cargarse por AJAX tras elegir universo
    selectComprobanteType(invoiceType(inv));
    clickContinue();
}

async function stepEmisor(cfg) {
    const fc = await waitFor('#fc');
    setValue(fc, cfg.fecha || todayDDMMYYYY());
    setValue(document.querySelector('#idconcepto'), cfg.concepto || '1');
    setValue(document.querySelector('#actiAsociadaId'), cfg.actividad || '479101');
    clickContinue();
}

async function stepReceptor(inv) {
    const profile = TYPE_PROFILES[invoiceType(inv)];
    const iva = await waitFor('#idivareceptor');
    setValue(iva, profile.idivareceptor);
    setValue(document.querySelector('#idtipodocreceptor'), docTypeFor(inv));
    const pago = document.querySelector('#formadepago1');
    if (pago) pago.checked = true;
    setValue(document.querySelector('#nrodocreceptor'), onlyDigits(inv.clientId));
    await sleep(800); // AFIP valida el doc por AJAX (y, en A, trae la razón social)
    clickContinue();
}

async function stepReceptorExtra(inv) {
    setValue(document.querySelector('#idtipodocreceptor'), docTypeFor(inv));
    setValue(document.querySelector('#nrodocreceptor'), onlyDigits(inv.clientId));
    const dom = document.querySelector('#domicilioreceptor');
    if (dom && inv.address) dom.value = inv.address;
    await sleep(400);
    tryClickContinue();
}

async function stepOperacion(inv, cfg) {
    const desc = await waitFor('#detalle_descripcion1');
    setValue(desc, cfg.descripcion || 'Artículos TCG');
    setValue(document.querySelector('#detalle_cantidad1'), '1');
    setValue(document.querySelector('#detalle_medida1'), '98');

    const total = Number(inv.total) || 0;
    const precio = document.querySelector('#detalle_precio1');
    if (invoiceType(inv) === 'A') {
        // Factura A: se carga el NETO; AFIP agrega el IVA. TO-VERIFY selectores.
        const neto = total / 1.21;
        setValue(precio, neto.toFixed(2));
        const ivaSel = document.querySelector('#detalle_iva1, [name=detalle_iva1]');
        if (ivaSel) setValue(ivaSel, IVA_21_ID);
    } else {
        // Factura B: IVA incluido, precio bruto.
        setValue(precio, total.toFixed(2));
    }
    clickContinue();
}

async function stepResumen(inv, state) {
    const genBtn = document.querySelector('#btngenerar');

    // En modo "confirmar", frenamos antes de generar y esperamos al usuario.
    if (state.mode === 'confirm' && genBtn) {
        renderConfirmPanel(state, inv);
        return;
    }

    if (genBtn) {
        genBtn.click(); // postback: la página recarga mostrando el comprobante
        return;
    }

    // Estado post-generación: imprimir y pasar a la siguiente.
    const printBtn = document.querySelector('#botones_comprobante input');
    if (printBtn) printBtn.click();
    await sleep(400);
    await completeCurrent(state, inv, 'ok');
}

// ----------------------------------------------------- avanzar / terminar ----
async function shiftAndGoNext(inv, status, detail) {
    const fresh = (await getState()) || {};
    fresh.results = [...(fresh.results || []), { orderId: inv.orderId, status, detail: detail || null, at: Date.now() }];
    fresh.queue = (fresh.queue || []).slice(1);
    await setState(fresh);
    location.href = START_URL;
}
const completeCurrent = (state, inv, status, detail) => shiftAndGoNext(inv, status, detail);
const failCurrent = (state, inv, detail) => shiftAndGoNext(inv, 'error', detail);

// -------------------------------------------------------------------- UI -----
function ensurePanel() {
    let el = document.getElementById('pa-arca-panel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'pa-arca-panel';
    el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'background:#0b0b14', 'color:#fff', 'border:1px solid #F5CE4B', 'border-radius:12px',
        'padding:14px 16px', 'width:300px', 'font:13px/1.4 system-ui,sans-serif',
        'box-shadow:0 8px 30px rgba(0,0,0,.5)',
    ].join(';');
    document.documentElement.appendChild(el);
    return el;
}

function progressOf(state) {
    const done = (state.results || []).length;
    const left = (state.queue || []).length;
    return { done, left, total: done + left };
}

function renderPanel(state, inv) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    const tipo = invoiceType(inv);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturando ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · Factura ${tipo}</div>
        <div style="opacity:.85">Doc ${onlyDigits(inv.clientId)} · $${Number(inv.total).toFixed(2)}</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-pause" style="${btnStyle('#333')}">Pausar</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-pause').onclick = async () => {
        const s = (await getState()) || state;
        s.active = false;
        await setState(s);
        renderPausedPanel(s);
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

function renderPausedPanel(state) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturación en pausa</div>
        <div style="opacity:.85">${done}/${total} hechas · ${total - done} pendientes</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-resume" style="${btnStyle('#1f7a3a')}">Reanudar</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-resume').onclick = async () => {
        const s = (await getState()) || state;
        s.active = true;
        await setState(s);
        location.href = START_URL;
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

function renderConfirmPanel(state, inv) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Revisá la factura ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · Factura ${invoiceType(inv)} · $${Number(inv.total).toFixed(2)}</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-gen" style="${btnStyle('#1f7a3a')}">Generar</button>
            <button id="pa-skip" style="${btnStyle('#7a1f1f')}">Saltar</button>
        </div>`;
    el.querySelector('#pa-gen').onclick = () => document.querySelector('#btngenerar')?.click();
    el.querySelector('#pa-skip').onclick = () => failCurrent(state, inv, 'Saltada manualmente');
}

function renderDonePanel(state) {
    const el = ensurePanel();
    const results = state.results || [];
    const ok = results.filter((r) => r.status === 'ok').length;
    const err = results.length - ok;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Listo ✅</div>
        <div>${ok} facturadas${err ? ` · <span style="color:#ff8a8a">${err} con error</span>` : ''}</div>
        ${err ? `<div style="margin-top:6px;max-height:120px;overflow:auto;opacity:.8">${results.filter((r) => r.status === 'error').map((r) => `· ${r.orderId}: ${r.detail || 'error'}`).join('<br>')}</div>` : ''}
        <div style="margin-top:10px"><button id="pa-close" style="${btnStyle('#333')}">Cerrar</button></div>`;
    el.querySelector('#pa-close').onclick = async () => {
        await chrome.storage.local.remove(STORAGE_KEY);
        el.remove();
    };
}

function renderUnknownPanel(state) {
    const el = ensurePanel();
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Esperando ARCA…</div>
        <div style="opacity:.85">Página no reconocida del flujo de comprobantes.</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-restart" style="${btnStyle('#1f7a3a')}">Ir al inicio</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-restart').onclick = () => (location.href = START_URL);
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

async function cancelAll() {
    await chrome.storage.local.remove(STORAGE_KEY);
    document.getElementById('pa-arca-panel')?.remove();
}

function btnStyle(bg) {
    return `flex:1;padding:6px 8px;background:${bg};color:#fff;border:0;border-radius:8px;cursor:pointer;font:600 12px system-ui`;
}

// ------------------------------------------------------------------ main -----
(async function main() {
    if (!ON_AFIP) return;

    let state = await getState();
    if (!state) return; // no hay batch en curso → no molestamos al usuario

    if (!state.queue || !state.queue.length) {
        if (state.active) {
            state.active = false;
            await setState(state);
        }
        if (state.results && state.results.length) renderDonePanel(state);
        return;
    }

    if (!state.active) {
        renderPausedPanel(state);
        return;
    }

    const inv = state.queue[0];
    const cfg = state.config || {};

    // Watchdog anti-loop: si una factura reprocesa demasiados pasos, la saltamos.
    state.attempts = state.attempts || {};
    state.attempts[inv.orderId] = (state.attempts[inv.orderId] || 0) + 1;
    await setState(state);
    if (state.attempts[inv.orderId] > 15) {
        await failCurrent(state, inv, 'Demasiados intentos (posible error de AFIP en esta factura)');
        return;
    }

    renderPanel(state, inv);

    // Si AFIP recargó el paso con un error de validación, no reintentamos en loop.
    const err = afipError();
    if (err && state.attempts[inv.orderId] > 2) {
        await failCurrent(state, inv, err);
        return;
    }

    try {
        const href = location.href;
        if (href.includes('buscarPtosVtas.do')) await stepStart(inv, cfg);
        else if (href.includes('genComDatosEmisor.do')) await stepEmisor(cfg);
        else if (href.includes('genComDatosReceptor.do')) await stepReceptor(inv);
        else if (href.includes('gen_com_datos_receptor_bc_extra.jsp')) await stepReceptorExtra(inv);
        else if (href.includes('genComDatosOperacion.do')) await stepOperacion(inv, cfg);
        else if (href.includes('genComResumenDatos.do')) await stepResumen(inv, state);
        else renderUnknownPanel(state);
    } catch (e) {
        console.error('[ARCA driver]', e);
        await failCurrent(state, inv, e.message);
    }
})();
