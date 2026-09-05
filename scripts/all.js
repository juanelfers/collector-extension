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
// QUÉ COMPROBANTE SE EMITE: lo define la CONDICIÓN FISCAL DEL EMISOR, no el
// documento del cliente. El admin lo manda en `config.tipoComprobante`:
//   - 'C'    => monotributo (konekotekka): siempre Factura C, sin discriminar IVA.
//   - 'auto' => responsable inscripto (pokeargentum), la lógica de siempre:
//               >=11 dígitos => CUIT => Factura A (discrimina IVA);
//               si no => DNI => Factura B (consumidor final, IVA incluido).
// Sin `tipoComprobante` cae en 'auto', así que las colas viejas siguen igual.
//
// OJO (CONFIRMAR EN VIVO): los valores marcados TO-VERIFY (perfiles A y C) salen
// de la doc de AFIP pero no se pudieron probar contra el sitio real. La rama B
// replica lo que ya venías usando.
// ============================================================================

const STORAGE_KEY = 'invoicing';
const START_URL = '/rcel/jsp/buscarPtosVtas.do';
const ON_AFIP = location.href.includes('fe.afip.gob.ar');
// Estar en fe.afip.gob.ar NO alcanza: si la sesión se vence a mitad del batch,
// ARCA rebota a otra parte del sitio y ninguno de los pasos matchea. Ahí antes
// el driver quedaba mudo; ahora se distingue para poder avisar.
const ON_RCEL = location.href.includes('fe.afip.gob.ar/rcel');
// Entrada al RCEL. /rcel/jsp/* en frío da 403: la sesión la crea el handoff SSO.
const RCEL_SSO = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel';

// Perfiles por tipo de comprobante. B = valores ya probados. A = best-effort.
// C = monotributo (konekotekka). El desplegable de tipo de comprobante ya viene
// en "2" por default en esa cuenta, así que lo dejamos como está en vez de
// buscarlo por texto (evita que el matcher agarre otro select).
// `idivareceptor: null` = no pisar lo que ARCA autocompleta del padrón al
// validar el CUIT: desde ML no sabemos la condición frente al IVA del comprador.
const TYPE_PROFILES = {
    B: { universoComprobante: '2', idivareceptor: '5' /* consumidor final */, discriminaIva: false },
    A: { universoComprobante: '1', idivareceptor: '1' /* responsable inscripto — TO-VERIFY */, discriminaIva: true },
    C: { universoComprobante: '2', idivareceptor: null, discriminaIva: false, skipTypeSelect: true },
};
const IVA_21_ID = '5'; // id de alícuota 21% en AFIP (verificado en el DOM real)
const CONSUMIDOR_FINAL_ID = '5'; // condición IVA del receptor cuando el doc es DNI

// ---------------------------------------------------------------- helpers ----
const getState = () => chrome.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] || null);
const setState = (state) => chrome.storage.local.set({ [STORAGE_KEY]: state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const docTypeFor = (inv) => (onlyDigits(inv.clientId).length >= 11 ? '80' /* CUIT */ : '96' /* DNI */);

// El tipo sale de la config de la cuenta emisora. 'auto' (o vacío) = A/B por
// documento del cliente, que es lo de siempre para un responsable inscripto.
function invoiceType(inv, cfg = {}) {
    const forced = inv.tipoComprobante || cfg.tipoComprobante;
    if (forced && forced !== 'auto' && TYPE_PROFILES[forced]) return forced;
    return onlyDigits(inv.clientId).length >= 11 ? 'A' : 'B';
}
const profileFor = (inv, cfg) => TYPE_PROFILES[invoiceType(inv, cfg)];

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

// Errores que NO son de esta factura sino de la configuración del batch: la
// fecha, el punto de venta, la clase de comprobante. Si no frenamos, la cola
// entera falla una por una (378 navegaciones para nada). Se pausa y se muestra
// el texto real de ARCA, que es el único que dice qué corregir en el admin.
const FATAL_ERRORS = [
    /fecha del comprobante es inv[áa]lida/i,
    /anterior al inicio de actividades/i,
    /comprobantes emitidos con fecha posterior/i,
    /no ofrece "Factura/i,
    /no está en la lista de ARCA/i,
];
const isFatalMessage = (msg) => FATAL_ERRORS.some((re) => re.test(msg || ''));

// Mismo criterio pero mirando la página: el error de fecha llega como una
// pantalla aparte con "< Volver", que no es ninguno de los pasos conocidos.
function fatalPageError() {
    const lines = (document.body?.innerText || '').split('\n').map((s) => s.trim());
    return lines.find((l) => l && l.length < 300 && isFatalMessage(l)) || null;
}

// Detección conservadora de error de validación de AFIP en la página actual.
function afipError() {
    const box = document.querySelector('#ha, .msg_error, .error, [class*=error]');
    const txt = (box?.innerText || '').trim();
    if (txt && /(obligatorio|verifique|inválid|invalid|error|no es correcto)/i.test(txt)) return txt.slice(0, 200);
    return null;
}

// ------------------------------------------------------------------ steps ----
function findComprobanteOption(type) {
    const re = new RegExp(`factura\\s*${type}\\b`, 'i');
    for (const sel of document.querySelectorAll('select')) {
        if (sel.name === 'universoComprobante' || sel.name === 'puntoDeVenta') continue;
        const opt = [...sel.options].find((o) => re.test(o.textContent));
        if (opt) return { sel, opt };
    }
    return null;
}

// El select de tipo de comprobante se puebla por AJAX DESPUÉS de elegir el
// punto de venta, así que esperamos a que aparezca la opción en vez de dormir
// un rato fijo. Si nunca aparece, es que ARCA no habilitó esa clase en ese
// punto de venta: mejor fallar con un mensaje claro que seguir con el select
// en "seleccionar..." y comerse un error de validación críptico.
async function selectComprobanteType(type, { timeout = 20000 } = {}) {
    const start = Date.now();
    for (;;) {
        const hit = findComprobanteOption(type);
        if (hit) {
            hit.sel.value = hit.opt.value;
            triggerChange(hit.sel);
            return;
        }
        if (Date.now() - start > timeout) {
            throw new Error(`ARCA no ofrece "Factura ${type}" en el punto de venta elegido`);
        }
        await sleep(200);
    }
}

// El punto de venta es un <select> y el value puede venir con ceros a la
// izquierda ("00012") según la cuenta. Probamos el valor tal cual y, si no hay
// opción, buscamos la que tenga ese número.
function setPuntoDeVenta(el, pv) {
    const wanted = onlyDigits(pv);
    if (!el.options) return setValue(el, pv);
    const match = [...el.options].find((o) => onlyDigits(o.value) === wanted)
        || [...el.options].find((o) => onlyDigits(o.textContent).startsWith(wanted));
    if (!match) throw new Error(`El punto de venta ${pv} no está en la lista de ARCA`);
    el.value = match.value;
    triggerChange(el);
}

async function stepStart(inv, cfg) {
    const pv = await waitFor('[name=puntoDeVenta]');
    setPuntoDeVenta(pv, cfg.puntoDeVenta || '1');
    const profile = profileFor(inv, cfg);
    const universo = document.querySelector('[name=universoComprobante]');
    if (universo && profile.universoComprobante) setValue(universo, profile.universoComprobante);
    // En monotributo el desplegable ya viene en el comprobante correcto: no lo
    // buscamos por texto para no pisar otro select del formulario.
    if (!profile.skipTypeSelect) await selectComprobanteType(invoiceType(inv, cfg));
    clickContinue();
}

async function stepEmisor(cfg) {
    const fc = await waitFor('#fc');
    setValue(fc, cfg.fecha || todayDDMMYYYY());
    setValue(document.querySelector('#idconcepto'), cfg.concepto || '1');
    setValue(document.querySelector('#actiAsociadaId'), cfg.actividad || '479101');
    clickContinue();
}

async function stepReceptor(inv, cfg) {
    const profile = profileFor(inv, cfg);
    const iva = await waitFor('#idivareceptor');
    // Sin condición fija en el perfil (C), usamos la que manda el admin —
    // ML nos dice el taxpayer_type del comprador. Si tampoco viene: DNI es
    // consumidor final, y con CUIT no tocamos nada (la trae ARCA del padrón).
    const cond = profile.idivareceptor
        ?? inv.condicionIva
        ?? (docTypeFor(inv) === '96' ? CONSUMIDOR_FINAL_ID : null);
    if (cond) setValue(iva, cond);
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
    if (profileFor(inv, cfg).discriminaIva) {
        // Factura A: se carga el NETO; AFIP agrega el IVA encima.
        setValue(precio, (total / 1.21).toFixed(2));
    } else {
        // Factura B y C: precio bruto (IVA incluido).
        setValue(precio, total.toFixed(2));
    }
    // Siendo RI la alícuota es obligatoria SIEMPRE, también en B (ahí ARCA la
    // usa para calcular el IVA contenido, no lo suma). En C el select no existe
    // y esto queda en no-op, así konekotekka sigue igual.
    const ivaSel = document.querySelector('#detalle_tipo_iva1, [name=detalleTipoIVA]');
    if (ivaSel) setValue(ivaSel, IVA_21_ID);
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
        genBtn.click();
        // "Confirmar Datos..." no navega: abre un modal jQuery UI ("Usted está
        // por generar un nuevo comprobante. ¿Confirma la Operación?"). Como el
        // script no se re-ejecuta sin navegación, el Confirmar hay que
        // apretarlo desde acá. Recién ese click hace el postback al comprobante.
        const confirmBtn = await waitForDialogConfirm();
        confirmBtn?.click();
        return;
    }

    // Estado post-generación: capturar el PDF y pasar a la siguiente.
    // OJO: acá NUNCA hay que clickear "Imprimir": su onclick es
    // parent.location.href = 'imprimirComprobante.do?c=' + idComprobante, o sea
    // NAVEGA la pestaña al PDF y el batch muere ahí. El PDF se baja por fetch.
    const captured = await capturePdf(inv);
    await completeCurrent(state, inv, 'ok', captured ? null : 'Generada, pero no pude capturar el PDF');
}

// Botón "Confirmar" del modal jQuery UI de generación (los botones no tienen
// id: se matchea por texto exacto entre los visibles, para no agarrar el
// "Cancelar" de al lado).
function waitForDialogConfirm({ timeout = 6000 } = {}) {
    return new Promise((resolve) => {
        const start = Date.now();
        const iv = setInterval(() => {
            const btn = [...document.querySelectorAll('.ui-dialog .ui-dialog-buttonset button')]
                .filter((b) => b.offsetParent !== null)
                .find((b) => /^confirmar$/i.test((b.textContent || '').trim()));
            if (btn) {
                clearInterval(iv);
                resolve(btn);
            } else if (Date.now() - start > timeout) {
                clearInterval(iv);
                resolve(null); // sin modal: que el humano mire qué pasó
            }
        }, 150);
    });
}

// Baja el PDF del comprobante recién generado SIN navegar: el onclick real del
// botón es parent.location.href = 'imprimirComprobante.do?c=' + idComprobante
// (visto en vivo), con idComprobante como global de la página. Lo pescamos del
// HTML, armamos la URL nosotros y el fetch viaja con las cookies de la sesión.
// El base64 queda en chrome.storage.local (key `invoicePdfs`) para que el
// driver de ML lo suba, y de paso se descarga como facturas-arca/{orderId}.pdf.
async function capturePdf(inv) {
    try {
        const idm = document.documentElement.innerHTML.match(/idComprobante\s*=\s*['"]?(\d+)/);
        if (!idm) return false;
        const url = new URL(`imprimirComprobante.do?c=${idm[1]}`, location.href).href;
        // Timeout: ARCA a veces deja el request colgado para siempre y el batch
        // muere acá. Abortar corta también la lectura del body; cae al catch,
        // devuelve false y la factura sigue como "generada sin PDF".
        const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        // Magia %PDF al principio; si vino HTML (otra página intermedia), plan B.
        const head = new Uint8Array(buf.slice(0, 4));
        if (String.fromCharCode(...head) !== '%PDF') return false;

        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const dataUrl = `data:application/pdf;base64,${btoa(bin)}`;

        const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
        invoicePdfs[inv.orderId] = { dataUrl, at: Date.now(), uploaded: false };
        await chrome.storage.local.set({ invoicePdfs });
        chrome.runtime.sendMessage({ type: 'save-pdf', orderId: inv.orderId, dataUrl });
        console.log('[PokeArgentum] PDF capturado', inv.orderId, `${Math.round(bytes.length / 1024)}KB`);
        return true;
    } catch (e) {
        console.warn('[PokeArgentum] no se pudo capturar el PDF, uso Imprimir', e);
        return false;
    }
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

// Freno de mano: deja la cola intacta (no consume la factura en curso) y espera
// a que el humano arregle la config en el admin y reanude.
async function pauseBatch(state, reason) {
    const fresh = (await getState()) || state;
    fresh.active = false;
    fresh.pauseReason = reason || null;
    await setState(fresh);
    console.warn('[ARCA driver] batch en pausa:', reason);
    renderPausedPanel(fresh);
}

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
    const tipo = invoiceType(inv, state.config || {});
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
    const fecha = state.config?.fecha;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturación en pausa</div>
        <div style="opacity:.85">${done}/${total} hechas · ${total - done} pendientes</div>
        ${state.pauseReason ? `
        <div style="margin-top:8px;padding:8px;background:#2a1414;border-radius:8px;color:#ff8a8a">
            ${state.pauseReason}
        </div>
        <div style="margin-top:6px;opacity:.8">Arreglalo en el admin${fecha ? ` (fecha enviada: <b>${fecha}</b>)` : ''} y volvé a mandar la cola.</div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-resume" style="${btnStyle('#1f7a3a')}">Reanudar</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-resume').onclick = async () => {
        const s = (await getState()) || state;
        s.active = true;
        s.pauseReason = null;
        // La factura en curso ya gastó intentos contra el error viejo: sin esto
        // el watchdog la mata apenas reanudás.
        if (s.attempts && s.queue?.[0]) delete s.attempts[s.queue[0].orderId];
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
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · Factura ${invoiceType(inv, state.config || {})} · $${Number(inv.total).toFixed(2)}</div>
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

function renderUnknownPanel(state, inv) {
    const el = ensurePanel();
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Esperando ARCA…</div>
        <div style="opacity:.85">Página no reconocida del flujo.</div>
        <div style="opacity:.85">En curso: <b>${inv?.orderId || '—'}</b></div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-restart" style="${btnStyle('#1f7a3a')}">Ir al inicio</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
            <button id="pa-done" style="${btnStyle('#333')}">Ya se facturó, seguir</button>
            <button id="pa-skip" style="${btnStyle('#333')}">Saltar esta</button>
        </div>`;
    // "Ir al inicio" REHACE la factura en curso: si ya salió de ARCA (el driver
    // murió después de generar, p.ej. en Imprimir), usá "Ya se facturó, seguir"
    // para marcarla ok y pasar a la siguiente sin duplicarla.
    el.querySelector('#pa-restart').onclick = () => (location.href = START_URL);
    el.querySelector('#pa-cancel').onclick = cancelAll;
    el.querySelector('#pa-done').onclick = () => inv && shiftAndGoNext(inv, 'ok', 'Generada (confirmada a mano)');
    el.querySelector('#pa-skip').onclick = () => inv && shiftAndGoNext(inv, 'error', 'Saltada manualmente');
}

// Estamos en AFIP pero fuera del comprobante en línea: típicamente la sesión se
// venció y ARCA nos rebotó al portal. No se toca la cola (no se perdió nada):
// sólo hay que volver a entrar por el handoff SSO.
function renderOffRcelPanel(state) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturación a medias</div>
        <div style="opacity:.85">${done}/${total} hechas · <b>${total - done}</b> pendientes</div>
        <div style="margin-top:8px;opacity:.85">
            Saliste del comprobante en línea (se habrá vencido la sesión). La cola
            está intacta: volvé a entrar y sigue donde quedó.
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-back" style="${btnStyle('#1f7a3a')}">Volver y seguir</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-back').onclick = async () => {
        const s = (await getState()) || state;
        s.active = true;
        s.pauseReason = null;
        if (s.attempts && s.queue?.[0]) delete s.attempts[s.queue[0].orderId];
        await setState(s);
        location.href = RCEL_SSO;
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

async function cancelAll() {
    await chrome.storage.local.remove(STORAGE_KEY);
    document.getElementById('pa-arca-panel')?.remove();
}

function btnStyle(bg) {
    return `flex:1;padding:6px 8px;background:${bg};color:#fff;border:0;border-radius:8px;cursor:pointer;font:600 12px system-ui`;
}

// Sin cola el driver no hace nada, y ese silencio es indistinguible de "la
// extensión no está instalada". Un cartelito que se va solo alcanza para saber
// que sí está viva y que lo que falta es mandar la cola desde el admin.
function renderIdleBadge() {
    const el = document.createElement('div');
    el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'background:#0b0b14', 'color:#F5CE4B', 'border:1px solid #F5CE4B', 'border-radius:10px',
        'padding:8px 12px', 'font:600 12px system-ui,sans-serif', 'opacity:.95',
        'transition:opacity .4s',
    ].join(';');
    el.textContent = 'PokeArgentum: extensión activa, sin cola';
    document.documentElement.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 4000);
    setTimeout(() => el.remove(), 4600);
}

// ------------------------------------------------------------------ main -----
(async function main() {
    if (!ON_AFIP) return;

    let state = await getState();
    console.log('[PokeArgentum] driver ARCA cargado', {
        paso: location.pathname,
        enCola: state?.queue?.length ?? 0,
        activo: Boolean(state?.active),
    });
    if (!state) {
        if (ON_RCEL) renderIdleBadge(); // sin batch, pero avisamos que estamos vivos
        return;
    }

    if (!state.queue || !state.queue.length) {
        if (state.active) {
            state.active = false;
            await setState(state);
        }
        if (state.results && state.results.length && ON_RCEL) renderDonePanel(state);
        return;
    }

    // Quedan facturas pero estamos fuera del RCEL: ningún paso va a matchear y
    // el driver se quedaría mudo hasta que alguien mire la pantalla. Avisamos.
    if (!ON_RCEL) {
        renderOffRcelPanel(state);
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

    // Error de configuración (fecha, PV, clase de comprobante): le va a pasar a
    // TODAS, así que se frena la cola entera en vez de quemarla factura por
    // factura. La pantalla de "Fecha inválida" ni siquiera es un paso conocido.
    const fatal = fatalPageError();
    if (fatal) {
        await pauseBatch(state, fatal);
        return;
    }

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
        else if (href.includes('genComDatosReceptor.do')) await stepReceptor(inv, cfg);
        else if (href.includes('gen_com_datos_receptor_bc_extra.jsp')) await stepReceptorExtra(inv);
        else if (href.includes('genComDatosOperacion.do')) await stepOperacion(inv, cfg);
        else if (href.includes('genComResumenDatos.do')) await stepResumen(inv, state);
        else renderUnknownPanel(state, inv);
    } catch (e) {
        console.error('[ARCA driver]', e);
        if (isFatalMessage(e.message)) await pauseBatch(state, e.message);
        else await failCurrent(state, inv, e.message);
    }
})();
