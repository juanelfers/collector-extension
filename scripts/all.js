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

// Orden de los pasos del comprobante. Sirve para darse cuenta de que el humano
// fue para ATRÁS: el driver sólo avanza (Continuar) o vuelve al inicio para la
// siguiente factura, así que caer en un paso anterior sin pasar por el inicio
// es que alguien apretó "< Volver" o la flecha del navegador.
const STEP_ORDER = [
    'buscarPtosVtas.do',
    'genComDatosEmisor.do',
    'genComDatosReceptor.do',
    'gen_com_datos_receptor_bc_extra.jsp',
    'genComDatosOperacion.do',
    'genComResumenDatos.do',
];
const stepIndex = (href) => {
    const i = STEP_ORDER.findIndex((frag) => href.includes(frag));
    return i < 0 ? null : i;
};
const RESUMEN_STEP = STEP_ORDER.length - 1;

// Perfiles por tipo de comprobante. B = valores ya probados. A = best-effort.
// C = monotributo (konekotekka). El desplegable de tipo de comprobante se
// puebla por AJAX después de elegir el punto de venta, igual que en A/B: hay
// que ESPERAR a que aparezca "Factura C" y elegirla. Apretar Continuar antes
// dispara el alert "Tipo de Comprobante obligatorio" (visto en vivo 2026-09-05).
// `idivareceptor: null` = no pisar lo que ARCA autocompleta del padrón al
// validar el CUIT: desde ML no sabemos la condición frente al IVA del comprador.
const TYPE_PROFILES = {
    B: { universoComprobante: '2', idivareceptor: '5' /* consumidor final */, discriminaIva: false },
    A: { universoComprobante: '1', idivareceptor: '1' /* responsable inscripto — TO-VERIFY */, discriminaIva: true },
    C: { universoComprobante: '2', idivareceptor: null, discriminaIva: false },
};
const IVA_21_ID = '5'; // id de alícuota 21% en AFIP (verificado en el DOM real)
const CONSUMIDOR_FINAL_ID = '5'; // condición IVA del receptor cuando el doc es DNI

// ---------------------------------------------------------------- helpers ----
const getState = () => chrome.storage.local.get(STORAGE_KEY).then((r) => r[STORAGE_KEY] || null);
const setState = (state) => chrome.storage.local.set({ [STORAGE_KEY]: state });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
// Tipo y número de documento del receptor. El admin manda `docType` (lo que
// dice ML: DNI/CUIT/CUIL); si no viene, se deduce por el largo.
// TRAMPA vista en vivo 2026-09-05 (factura 20 del batch): compradores que
// cargan su CUIL de 11 dígitos en el campo DNI de ML. Mandarlo como CUIT hace
// que ARCA lo busque en el padrón, no lo encuentre como empresa y pida razón
// social y domicilio (alert "campos obligatorios"). Para una Factura C a
// consumidor final alcanza el DNI, que son los 8 dígitos del medio del CUIL.
// Con 11 dígitos manda la CONDICIÓN DE IVA del comprador, no el prefijo: un RI,
// monotributista o exento (ML lo dice) va con CUIT entero — ARCA sólo le
// ofrece CUIT (factura 67 del batch: RI con 20-29375418-8 → "Tipo de Documento
// inválido" al mandarle DNI). Sólo el consumidor final (o sin dato) va con el
// DNI de adentro del CUIL.
const IVA_CON_CUIT = new Set(['1', '4', '6', '13', '16']);
function receptorDoc(inv) {
    const digits = onlyDigits(inv.clientId);
    const declared = String(inv.docType || '').toUpperCase();
    const cond = String(inv.condicionIva || '');
    if (digits.length === 11) {
        if (IVA_CON_CUIT.has(cond) || declared === 'CUIT') return { type: '80', number: digits };
        const personaFisica = /^(20|23|24|27)/.test(digits);
        if (declared === 'CUIL' || personaFisica) {
            return { type: '96', number: digits.slice(2, 10) }; // DNI adentro del CUIL
        }
        return { type: '80', number: digits }; // CUIT de empresa
    }
    return { type: '96', number: digits };
}
const docTypeFor = (inv) => receptorDoc(inv).type;

// El tipo sale de la config de la cuenta emisora. 'auto' (o vacío) = A/B por
// documento del cliente, que es lo de siempre para un responsable inscripto.
function invoiceType(inv, cfg = {}) {
    const forced = inv.tipoComprobante || cfg.tipoComprobante;
    if (forced && forced !== 'auto' && TYPE_PROFILES[forced]) return forced;
    // Regla de la contadora de Poke (doc "PROCESO DE FACTURACION", 2026-09):
    // A sólo si el comprador es Responsable Inscripto; monotributista y
    // consumidor final van con B. Un monotributista trae CUIT y antes caía en A.
    return String(inv.condicionIva || '') === '1' ? 'A' : 'B';
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
// Los alert() de ARCA ("Los siguientes campos son obligatorios…") congelan la
// pestaña: el driver queda mudo y hasta el DevTools deja de responder. Al
// cargar, se le pide al service worker que reemplace window.alert en el MAIN
// world por uno que deja el texto en un atributo del <html>; acá se lee como
// error de la factura (ver continueAndWatch).
const ALERT_ATTR = 'data-pa-alert';
async function patchPageAlert() {
    try {
        await chrome.runtime.sendMessage({ type: 'patch-alert', attr: ALERT_ATTR });
    } catch (e) {
        console.warn('[ARCA driver] no pude parchear alert()', e);
    }
}
const pendingAlert = () => document.documentElement.getAttribute(ALERT_ATTR) || null;

function clickContinue() {
    const btn = findContinue();
    if (!btn) throw new Error('No se encontró el botón "Continuar"');
    document.documentElement.removeAttribute(ALERT_ATTR);
    btn.click();
}

// Continuar y mirar un momento si ARCA rebotó con un alert (validación que no
// navega). Si lo hizo, la factura falla con ese texto en vez de quedar muda.
async function continueAndWatch({ wait = 1500 } = {}) {
    clickContinue();
    const start = Date.now();
    while (Date.now() - start < wait) {
        const msg = pendingAlert();
        if (msg) throw new Error(`ARCA: ${msg.replace(/\s+/g, ' ').slice(0, 200)}`);
        await sleep(150);
    }
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
// OJO: en monotributo (konekotekka) el desplegable "Tipo de Comprobante" ES
// `universoComprobante` (verificado en vivo 2026-09-05: se puebla por AJAX con
// "2=Factura C, 3=Nota de Débito C, …"). Saltearlo por nombre hacía que nunca
// apareciera "Factura C" y el batch se frenaba con "ARCA no ofrece…".
function findComprobanteOption(type) {
    const re = new RegExp(`factura\\s*${type}\\b`, 'i');
    for (const sel of document.querySelectorAll('select')) {
        if (sel.name === 'puntoDeVenta') continue;
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
    // En las cuentas vistas hasta ahora (monotributo Y responsable inscripto,
    // verificado 2026-09-05) `universoComprobante` ES el desplegable de tipo de
    // comprobante, con los ids reales de ARCA (RI: 26=Factura A, 19=Factura B).
    // Sólo se toca si tiene una opción con el valor del perfil; si no, ponerle
    // un valor inexistente lo deja en blanco y dispara un change al vacío.
    const universo = document.querySelector('[name=universoComprobante]');
    const uv = profile.universoComprobante;
    if (universo && uv && [...universo.options].some((o) => o.value === uv)) setValue(universo, uv);
    await selectComprobanteType(invoiceType(inv, cfg));
    await continueAndWatch();
}

async function stepEmisor(cfg) {
    const fc = await waitFor('#fc');
    setValue(fc, cfg.fecha || todayDDMMYYYY());
    setValue(document.querySelector('#idconcepto'), cfg.concepto || '1');
    // La actividad asociada SÓLO acepta las que ese CUIT tiene dadas de alta
    // (konekotekka no tiene la 479101: ver SELLER_FISCAL.actividad en el
    // admin). Si no está en la lista, ARCA deja pasar el comprobante sin
    // actividad, pero mejor avisar que fallar en silencio.
    const acti = document.querySelector('#actiAsociadaId');
    const wanted = cfg.actividad || '479101';
    if (acti?.options && ![...acti.options].some((o) => o.value === wanted)) {
        console.warn('[ARCA driver] este CUIT no tiene la actividad', wanted, 'opciones:',
            [...acti.options].map((o) => o.value).filter(Boolean));
    } else {
        setValue(acti, wanted);
    }
    await continueAndWatch();
}

// Espera a que un <select> tenga opciones reales (ARCA las trae por AJAX).
async function waitForOptions(sel, { timeout = 6000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (sel?.options && [...sel.options].some((o) => o.value)) return true;
        await sleep(150);
    }
    return false;
}

async function stepReceptor(inv, cfg) {
    const profile = profileFor(inv, cfg);
    const iva = await waitFor('#idivareceptor');
    // ARCA inicializa el formulario con su propio JS después de pintarlo: si
    // se llena demasiado pronto, lo pisa y Continuar tira el alert "campos
    // obligatorios" (visto en vivo 2026-09-05 en la factura 20 de un batch;
    // las 19 anteriores pasaron por timing). Un respiro y verificación.
    await sleep(700);
    // Sin condición fija en el perfil (C), usamos la que manda el admin —
    // ML nos dice el taxpayer_type del comprador. Si tampoco viene: DNI es
    // consumidor final, y con CUIT no tocamos nada (la trae ARCA del padrón).
    const cond = profile.idivareceptor
        ?? inv.condicionIva
        ?? (docTypeFor(inv) === '96' ? CONSUMIDOR_FINAL_ID : null);
    const tipoDoc = document.querySelector('#idtipodocreceptor');
    const nroDoc = document.querySelector('#nrodocreceptor');
    const { type: docType, number: nro } = receptorDoc(inv);

    for (let intento = 0; intento < 3; intento++) {
        if (cond) setValue(iva, cond);
        // El desplegable de tipo de documento se puebla por AJAX DESPUÉS de
        // elegir la condición de IVA: hay que esperarlo o queda vacío.
        await waitForOptions(tipoDoc);
        setValue(tipoDoc, docType);
        setValue(nroDoc, nro);
        await sleep(900); // AFIP valida el doc por AJAX (y, en A, trae la razón social)
        const ok = (!cond || iva.value === cond) && tipoDoc.value === docType && onlyDigits(nroDoc.value) === nro;
        if (ok) break;
        console.warn('[ARCA driver] receptor no quedó cargado, reintento', intento + 1, {
            iva: iva.value, tipoDoc: tipoDoc.value, nro: nroDoc.value,
        });
        await sleep(500);
        if (intento === 2) {
            // Apretar Continuar así dispara el alert de ARCA, que congela la
            // pestaña. Mejor frenar y que una persona mire (o salte).
            throw new Error(`Receptor no aceptado por ARCA (IVA ${iva.value || '—'}, tipo doc ${tipoDoc.value || '—'}, nro ${nroDoc.value || '—'})`);
        }
    }
    // Contado. Click de verdad, no `checked = true`: es lo que ARCA valida
    // (registrarSiNingunaCondicionDeVenta) y lo que imprime el PDF. El resumen
    // muestra "Condiciones de Venta null" IGUAL, a mano también: es de ARCA.
    const pago = document.querySelector('#formadepago1');
    if (pago && !pago.checked) pago.click();
    await continueAndWatch();
}

async function stepReceptorExtra(inv) {
    setValue(document.querySelector('#idtipodocreceptor'), receptorDoc(inv).type);
    setValue(document.querySelector('#nrodocreceptor'), receptorDoc(inv).number);
    const dom = document.querySelector('#domicilioreceptor');
    if (dom && inv.address) dom.value = inv.address;
    await sleep(400);
    tryClickContinue();
}

// Neto de una Factura A tal que neto + IVA(21%) redondeado dé EXACTAMENTE el
// total cobrado. Redondear total/1.21 a secas falla de a un centavo cada tanto
// (24.499,99 → neto 20.247,93 → 20.247,93 + 4.252,07 = 24.500,00): se prueban
// los vecinos y se queda el que cierra; si ninguno, el más cercano.
function netoFor(total) {
    const c = (n) => Math.round(n * 100) / 100;
    const base = c(total / 1.21);
    const cands = [base, c(base - 0.01), c(base + 0.01)];
    const exact = cands.find((n) => Math.round((n + c(n * 0.21)) * 100) === Math.round(total * 100));
    return (exact ?? base).toFixed(2);
}

async function stepOperacion(inv, cfg) {
    const desc = await waitFor('#detalle_descripcion1');
    setValue(desc, cfg.descripcion || 'Artículos TCG');
    setValue(document.querySelector('#detalle_cantidad1'), '1');
    setValue(document.querySelector('#detalle_medida1'), '7'); // 7 = unidades (98 era "otras unidades")

    const total = Number(inv.total) || 0;
    const precio = document.querySelector('#detalle_precio1');
    if (profileFor(inv, cfg).discriminaIva) {
        // Factura A: se carga el NETO; AFIP agrega el IVA encima.
        setValue(precio, netoFor(total));
    } else {
        // Factura B y C: precio bruto (IVA incluido).
        setValue(precio, total.toFixed(2));
    }
    // Siendo RI la alícuota es obligatoria SIEMPRE, también en B (ahí ARCA la
    // usa para calcular el IVA contenido, no lo suma). En C el select no existe
    // y esto queda en no-op, así konekotekka sigue igual.
    const ivaSel = document.querySelector('#detalle_tipo_iva1, [name=detalleTipoIVA]');
    if (ivaSel) setValue(ivaSel, IVA_21_ID);
    await continueAndWatch();
}

async function stepResumen(inv, state) {
    const genEl = document.querySelector('#btngenerar');
    const genBtn = genEl && genEl.offsetParent !== null ? genEl : null; // oculto = ya generó

    // En modo "confirmar", frenamos antes de generar y esperamos al usuario.
    if (state.mode === 'confirm' && genBtn) {
        renderConfirmPanel(state, inv);
        return;
    }

    if (genBtn) {
        await generateAndFinish(state, inv);
        return;
    }

    // Llegamos acá con el comprobante ya generado (recarga de la página después
    // de generar): capturar el PDF y pasar a la siguiente.
    await finishGenerated(state, inv, { timeout: 0 });
}

// "Confirmar Datos..." → modal jQuery UI → "Confirmar". OJO, verificado en vivo
// 2026-09-05: ese Confirmar NO navega. generarComprobante() pega por AJAX, la
// página se actualiza en el lugar ("✔ Comprobante Generado", aparece
// "Imprimir...") y el id queda en la global `idComprobante`. Como el content
// script sólo corre al cargar una página, antes de esto el driver se quedaba
// mudo mostrando "Generar" con la factura YA emitida — y el siguiente click la
// duplicaba. Ahora se espera el desenlace en la misma página.
async function generateAndFinish(state, inv) {
    document.querySelector('#btngenerar')?.click();
    const confirmBtn = await waitForDialogConfirm();
    if (!confirmBtn) {
        renderStuckPanel(state, inv, 'No apareció el modal de "Confirmar" de ARCA.');
        return;
    }
    confirmBtn.click();
    renderPanel(state, inv, 'Generando en ARCA…');
    await finishGenerated(state, inv, { timeout: 90000 });
}

// Estado "comprobante generado" en la MISMA página del resumen: el botón de
// generar desaparece y aparecen "Imprimir..." / "Comprobante Generado".
function isGenerated() {
    // Después de generar, ARCA no borra #btngenerar: lo ESCONDE (visto en vivo
    // 2026-09-05, offsetParent null). Sólo cuenta si está visible.
    const gen = document.querySelector('#btngenerar');
    if (gen && gen.offsetParent !== null) return false;
    if (/comprobante\s+generado/i.test(document.body?.innerText || '')) return true;
    return [...document.querySelectorAll('input[type=button]')].some((b) => /imprimir/i.test(b.value || ''));
}

// Espera el desenlace de la generación sin navegar. Devuelve true (generado),
// 'error' (ARCA mostró un error) o false (se acabó el tiempo sin señal).
async function waitForGenerated({ timeout = 90000, interval = 400 } = {}) {
    const start = Date.now();
    for (;;) {
        if (isGenerated()) return true;
        const err = afipError() || fatalPageError();
        if (err) return 'error';
        if (Date.now() - start >= timeout) return false;
        await sleep(interval);
    }
}

async function finishGenerated(state, inv, { timeout = 90000 } = {}) {
    const outcome = await waitForGenerated({ timeout });
    if (outcome === 'error') {
        const msg = afipError() || fatalPageError() || 'ARCA mostró un error al generar';
        if (isFatalMessage(msg)) await pauseBatch(state, msg);
        else await failCurrent(state, inv, msg);
        return;
    }
    if (!outcome) {
        // Sin señal clara NO se avanza ni se reintenta solo: reintentar acá es
        // exactamente cómo se duplica una factura.
        renderStuckPanel(state, inv, 'ARCA no confirmó que el comprobante se haya generado.');
        return;
    }
    // NUNCA "Imprimir": navega la pestaña al PDF y mata el batch.
    const captured = await capturePdf(inv);
    await completeCurrent(state, inv, 'ok', captured === true ? null : `Generada, pero no pude capturar el PDF: ${captured}`);
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
// El id del comprobante recién generado vive en una GLOBAL de la página
// (`var idComprobante;` que rellena el AJAX de generarComprobante). El content
// script corre en otro mundo y no la ve: se le pide a la página que la copie a
// un atributo del <html> con un <script> inline (ARCA no manda CSP que lo
// frene). Plan B: que haya quedado escrita en el HTML.
// Se reintenta un rato: "Comprobante Generado" puede pintarse ANTES de que el
// callback del AJAX asigne la global. Cada intento deja el motivo en `why`
// para que llegue al detalle del resultado (no hay consola que mirar en un
// batch que navega cada 5 segundos).
async function readIdComprobante(why = []) {
    for (let i = 0; i < 12; i++) {
        // 1) El service worker lo lee en el MAIN world (executeScript).
        try {
            const v = await chrome.runtime.sendMessage({ type: 'read-page-var', name: 'idComprobante' });
            if (/^\d+$/.test(String(v || ''))) return String(v);
            if (i === 0) why.push(`sw:${JSON.stringify(v)}`);
        } catch (e) {
            if (i === 0) why.push(`sw-err:${e?.message || e}`);
        }
        // 2) <script> inline que copia la global a un atributo del <html>.
        const inline = readIdInline();
        if (inline) return inline;
        if (i === 0) why.push('inline:vacío');
        await sleep(300);
    }
    why.push('agotado');
    return null;
}

function readIdInline() {
    try {
        const attr = 'data-pa-idcomprobante';
        document.documentElement.removeAttribute(attr);
        const s = document.createElement('script');
        s.textContent = `document.documentElement.setAttribute(${JSON.stringify(attr)}, String(typeof idComprobante !== 'undefined' && idComprobante ? idComprobante : ''));`;
        document.documentElement.appendChild(s);
        s.remove();
        const v = document.documentElement.getAttribute(attr);
        if (/^\d+$/.test(v || '')) return v;
    } catch (e) {
        console.warn('[ARCA driver] no pude leer idComprobante de la página', e);
    }
    const idm = document.documentElement.innerHTML.match(/idComprobante\s*=\s*['"]?(\d+)/);
    return idm ? idm[1] : null;
}

// Id interno de ARCA del último comprobante generado (va al resultado).
let lastIdComprobante = null;

// Devuelve true si capturó; si no, un string con el motivo (va al detalle).
async function capturePdf(inv) {
    const why = [];
    try {
        const id = await readIdComprobante(why);
        lastIdComprobante = id;
        if (!id) {
            console.warn('[ARCA driver] sin idComprobante: no capturo el PDF de', inv.orderId, why);
            return `sin idComprobante (${why.join(' ')})`;
        }
        const url = new URL(`imprimirComprobante.do?c=${id}`, location.href).href;
        // Timeout: ARCA a veces deja el request colgado para siempre y el batch
        // muere acá. Abortar corta también la lectura del body; cae al catch,
        // devuelve false y la factura sigue como "generada sin PDF".
        const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(20000) });
        if (!res.ok) return `HTTP ${res.status} al bajar el PDF`;
        const buf = await res.arrayBuffer();
        // Magia %PDF al principio; si vino HTML (otra página intermedia), plan B.
        const head = new Uint8Array(buf.slice(0, 4));
        if (String.fromCharCode(...head) !== '%PDF') return 'la descarga no era un PDF';

        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const dataUrl = `data:application/pdf;base64,${btoa(bin)}`;

        const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
        // `seller`: la cuenta que facturó. La subida a ML filtra por esto para
        // no adjuntar facturas de konekotekka logueado como pokeargentum.
        const st = await getState();
        // `mlOrderId`: el id de ORDEN de ML. La clave (`orderId`) es el id del
        // pack cuando la venta es un pack, y la pantalla de adjuntar factura de
        // ML sólo acepta el id de la orden (202 de 276 ventas de Poke en agosto
        // 2026 tenían pack ≠ orden). Lo manda el admin en la cola.
        invoicePdfs[inv.orderId] = {
            dataUrl,
            at: Date.now(),
            uploaded: false,
            seller: st?.config?.seller || null,
            mlOrderId: inv.mlOrderId || null,
        };
        await chrome.storage.local.set({ invoicePdfs });
        // Copia en disco sólo si el admin lo pide (config.saveToDisk): Chrome
        // abre cada PDF descargado y a Juan le quedaban decenas de pestañas
        // comiendo RAM. Para subir a ML alcanza con el storage.
        if (st?.config?.saveToDisk) chrome.runtime.sendMessage({ type: 'save-pdf', orderId: inv.orderId, dataUrl });
        console.log('[PokeArgentum] PDF capturado', inv.orderId, `${Math.round(bytes.length / 1024)}KB`);
        return true;
    } catch (e) {
        console.warn('[PokeArgentum] no se pudo capturar el PDF', e);
        return `error: ${e?.message || e}`;
    }
}

// ----------------------------------------------------- avanzar / terminar ----
// Título del comprobante según ARCA ("FACTURA B", 'FACTURA A con Leyenda "Pago
// en CBU Informada"'). Va al resultado: el admin lo muestra y una leyenda
// inesperada se ve sin abrir el PDF.
function comprobanteTitle() {
    const m = (document.body?.innerText || '').match(/GENERACI[ÓO]N DE COMPROBANTES\s*-\s*([^\n]+)/i);
    return m ? m[1].trim() : null;
}

async function shiftAndGoNext(inv, status, detail, extra = {}) {
    const fresh = (await getState()) || {};
    fresh.results = [...(fresh.results || []), { orderId: inv.orderId, status, detail: detail || null, at: Date.now(), ...extra }];
    fresh.queue = (fresh.queue || []).slice(1);
    fresh.step = 0;
    fresh.manual = false;
    await setState(fresh);
    location.href = START_URL;
}
const completeCurrent = (state, inv, status, detail) => shiftAndGoNext(inv, status, detail, { tipo: comprobanteTitle(), idComprobante: lastIdComprobante || null });
const failCurrent = (state, inv, detail) => shiftAndGoNext(inv, 'error', detail);
// "Saltar" apretado por una persona: no es un error, pero tampoco quedó hecha.
const skipCurrent = (state, inv) => shiftAndGoNext(inv, 'skipped', 'Saltada a mano');

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

function renderPanel(state, inv, note) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    const tipo = invoiceType(inv, state.config || {});
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturando ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · Factura ${tipo}</div>
        <div style="opacity:.85">Doc ${onlyDigits(inv.clientId)} · $${Number(inv.total).toFixed(2)}</div>
        ${note ? `<div style="margin-top:6px;opacity:.8">${note}</div>` : ''}
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
        s.step = 0;
        s.manual = false;
        await setState(s);
        location.href = START_URL;
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

// Lo que ARCA muestra en el resumen (paso 4), leído de la página: así la
// revisión se hace en el panel sin recorrer la pantalla. Cada campo sale de
// la línea "Etiqueta valor" del texto; si ARCA cambia el layout, queda vacío.
function readResumen() {
    const text = document.body?.innerText || '';
    const line = (label) => {
        const m = text.match(new RegExp(`^\\s*${label}\\s+(.+)$`, 'mi'));
        return m ? m[1].trim() : '';
    };
    const doc = text.match(/^\s*(CUIT|CUIL|DNI|Pasaporte|CDI|LE|LC)\s+(\d[\d.\-]*)\s*$/mi);
    return {
        titulo: comprobanteTitle() || '',
        pv: line('Punto de Venta'),
        docTipo: doc ? doc[1].toUpperCase() : '',
        doc: doc ? onlyDigits(doc[2]) : '',
        razonSocial: (text.match(/^\s*Razón Social\s+(.+)$/gmi) || []).map((l) => l.replace(/^\s*Razón Social\s+/i, '').trim())[1] || '',
        condicionIva: line('Condición frente al IVA'),
        condicionVenta: line('Condiciones de Venta'),
        neto: line('Importe Neto Gravado:'),
        iva21: line('IVA 21%:'),
        ivaContenido: line('IVA Contenido:'),
        total: line('Importe Total:'),
    };
}

const money = (n) => Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderConfirmPanel(state, inv) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    const tipo = invoiceType(inv, state.config || {});
    const r = readResumen();
    // El título de ARCA tiene que ser el tipo pedido. Una leyenda ("con Leyenda
    // 'Pago en CBU Informada'", RG 1575 para RI nuevos) o una letra distinta se
    // marcan en rojo: es lo primero que hay que mirar antes de generar.
    const esperado = new RegExp(`^factura\\s*${tipo}\\b`, 'i');
    const tituloOk = !r.titulo || esperado.test(r.titulo);
    const leyenda = /leyenda/i.test(r.titulo);
    const totalOk = !r.total || Math.abs(Number(String(r.total).replace(/[$\s.]/g, '').replace(',', '.')) - Number(inv.total)) < 0.01;
    const fila = (k, v, warn) => v ? `<div style="display:flex;gap:8px;justify-content:space-between${warn ? ';color:#ff8a8a' : ''}"><span style="opacity:.6">${k}</span><span style="text-align:right">${v}</span></div>` : '';
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Revisá la factura ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · pedida Factura ${tipo} · $${money(inv.total)}</div>
        ${inv.name ? `<div style="opacity:.7">${inv.name}</div>` : ''}
        <div style="margin-top:8px;padding:8px;background:#151526;border-radius:8px;font-size:12px;line-height:1.5">
            ${fila('ARCA', r.titulo, !tituloOk || leyenda)}
            ${fila('PV', r.pv, false)}
            ${fila(r.docTipo || 'Doc', r.doc, false)}
            ${fila('Receptor', r.razonSocial, false)}
            ${fila('IVA', r.condicionIva, false)}
            ${fila('Venta', r.condicionVenta, false)}
            ${fila('Neto', r.neto, false)}
            ${fila('IVA 21%', r.iva21, false)}
            ${fila('IVA cont.', r.ivaContenido, false)}
            ${fila('Total', r.total, !totalOk)}
        </div>
        ${!tituloOk ? `<div style="margin-top:6px;color:#ff8a8a">ARCA armó otro tipo de comprobante que el pedido.</div>` : ''}
        ${leyenda ? `<div style="margin-top:6px;color:#ffb86b">Lleva leyenda: es lo que ARCA habilita para este CUIT/punto de venta.</div>` : ''}
        ${!totalOk ? `<div style="margin-top:6px;color:#ff8a8a">El total de ARCA no es el de la venta.</div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-gen" style="${btnStyle('#1f7a3a')}">Generar</button>
            <button id="pa-skip" style="${btnStyle('#7a1f1f')}">Saltar</button>
        </div>`;
    // La persona ya revisó: se genera, se confirma el modal y se espera el
    // desenlace en la misma página (ARCA no navega al generar).
    el.querySelector('#pa-gen').onclick = () => generateAndFinish(state, inv);
    el.querySelector('#pa-skip').onclick = () => skipCurrent(state, inv);
}

// ARCA no dio señal de generación (o no abrió el modal). No se reintenta solo.
function renderStuckPanel(state, inv, reason) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Mirá ARCA ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · $${Number(inv.total).toFixed(2)}</div>
        <div style="margin-top:8px;padding:8px;background:#2a1414;border-radius:8px;color:#ff8a8a">${reason}</div>
        <div style="margin-top:6px;opacity:.8">Fijate en la pantalla si el comprobante salió. No la vuelvo a generar sola.</div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-done" style="${btnStyle('#1f7a3a')}">Salió, seguir</button>
            <button id="pa-retry" style="${btnStyle('#333')}">No salió, rehacer</button>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
            <button id="pa-skip" style="${btnStyle('#333')}">Saltar esta</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>`;
    el.querySelector('#pa-done').onclick = async () => {
        const captured = await capturePdf(inv);
        await completeCurrent(state, inv, 'ok', captured === true ? null : `Generada, pero no pude capturar el PDF: ${captured}`);
    };
    el.querySelector('#pa-retry').onclick = async () => {
        const s = (await getState()) || state;
        s.step = 0;
        s.manual = false;
        await setState(s);
        location.href = START_URL;
    };
    el.querySelector('#pa-skip').onclick = () => skipCurrent(state, inv);
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

function renderDonePanel(state) {
    const el = ensurePanel();
    const results = state.results || [];
    const ok = results.filter((r) => r.status === 'ok').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const err = results.length - ok - skipped;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Listo ✅</div>
        <div>${ok} facturadas${skipped ? ` · ${skipped} saltada${skipped === 1 ? '' : 's'}` : ''}${err ? ` · <span style="color:#ff8a8a">${err} con error</span>` : ''}</div>
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
    el.querySelector('#pa-restart').onclick = async () => {
        const s = (await getState()) || state;
        s.step = 0;
        s.manual = false;
        await setState(s);
        location.href = START_URL;
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
    el.querySelector('#pa-done').onclick = async () => {
        if (!inv) return;
        // Si todavía estamos parados en el comprobante generado, el PDF se
        // puede rescatar; si no, queda marcada ok sin PDF (se sube a mano).
        const captured = isGenerated() ? await capturePdf(inv) : 'no estaba en el comprobante generado';
        await shiftAndGoNext(inv, 'ok', captured === true ? 'Confirmada a mano' : `Confirmada a mano, sin PDF (${captured})`);
    };
    el.querySelector('#pa-skip').onclick = () => inv && shiftAndGoNext(inv, 'skipped', 'Saltada a mano');
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
        s.step = 0;
        s.manual = false;
        await setState(s);
        location.href = RCEL_SSO;
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
}

// Modo manual: el humano apretó "< Volver" para corregir algo. El driver no
// toca la página ni aprieta Continuar; recién cuando vuelve al resumen retoma
// (y muestra el panel de revisar, sea cual sea el modo: lo que se corrigió a
// mano lo mira una persona antes de generar).
function renderManualPanel(state, inv) {
    const el = ensurePanel();
    const { done, total } = progressOf(state);
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Corrigiendo a mano ${done + 1}/${total}</div>
        <div style="opacity:.85">Orden <b>${inv.orderId}</b> · $${Number(inv.total).toFixed(2)}</div>
        <div style="margin-top:8px;opacity:.85">
            Volviste atrás: la extensión no toca nada. Avanzá con "Continuar"
            hasta el resumen y ahí retoma.
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-auto" style="${btnStyle('#1f7a3a')}">Seguir solo desde acá</button>
            <button id="pa-cancel" style="${btnStyle('#7a1f1f')}">Cancelar</button>
        </div>
        <div style="margin-top:8px;display:flex;gap:8px">
            <button id="pa-skip" style="${btnStyle('#333')}">Saltar esta</button>
        </div>`;
    el.querySelector('#pa-auto').onclick = async () => {
        const s = (await getState()) || state;
        s.manual = false;
        await setState(s);
        renderPanel(s, inv);
        try {
            await runStep(location.href, inv, s.config || {}, s);
        } catch (e) {
            console.error('[ARCA driver]', e);
            await failCurrent(s, inv, e.message);
        }
    };
    el.querySelector('#pa-cancel').onclick = cancelAll;
    el.querySelector('#pa-skip').onclick = () => skipCurrent(state, inv);
}

// Guardia del botón "< Volver" de ARCA: antes de que el botón haga lo suyo se
// deja anotado en el storage que ahora maneja el humano. Sin esto, la página
// anterior carga, el driver se re-ejecuta, la rellena y aprieta Continuar: el
// Volver "no anda". Se intercepta en fase de captura para ganarle al onclick
// inline; el click se repite después de guardar, con un flag para no volver a
// entrar acá.
const VOLVER_RE = /^\s*<?\s*volver\s*$/i;
let volverBypass = false;
function armVolverGuard() {
    document.addEventListener('click', async (e) => {
        if (volverBypass) return;
        const btn = e.target?.closest?.('input[type=button], input[type=submit], button, a');
        if (!btn || !VOLVER_RE.test(btn.value || btn.textContent || '')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const s = await getState();
        if (s) {
            s.manual = true;
            await setState(s);
        }
        volverBypass = true;
        btn.click();
        volverBypass = false;
    }, true);
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

// Qué paso del comprobante es esta página, y ejecutarlo.
async function runStep(href, inv, cfg, state) {
    if (href.includes('buscarPtosVtas.do')) await stepStart(inv, cfg);
    else if (href.includes('genComDatosEmisor.do')) await stepEmisor(cfg);
    else if (href.includes('genComDatosReceptor.do')) await stepReceptor(inv, cfg);
    else if (href.includes('gen_com_datos_receptor_bc_extra.jsp')) await stepReceptorExtra(inv);
    else if (href.includes('genComDatosOperacion.do')) await stepOperacion(inv, cfg);
    else if (href.includes('genComResumenDatos.do')) await stepResumen(inv, state);
    else if (href.includes('index_bis.jsp')) stepEmpresa(state, inv);
    else if (href.includes('menu_ppal.jsp')) location.href = START_URL;
    else renderUnknownPanel(state, inv);
}

// "Seleccione la Empresa a representar": es la primera pantalla después del
// login. Con una sola empresa se entra sola; con varias, que elija la persona
// (el CUIT que factura importa).
function stepEmpresa(state, inv) {
    const btns = [...document.querySelectorAll('input[type=button], input[type=submit], button')]
        .filter((b) => b.offsetParent !== null && !/salir/i.test(b.value || b.textContent || ''));
    if (btns.length === 1) btns[0].click();
    else renderUnknownPanel(state, inv);
}

// ------------------------------------------------- consulta de ARCA -----
// "Cruzar con ARCA": el admin pide los comprobantes emitidos en un rango
// (Consultas → Consulta de comprobantes) para cruzarlos por documento +
// importe contra las ventas y marcar las que ya están facturadas sin que
// una persona tenga que mirar la tabla. Pedido y resultado viven en
// chrome.storage.local bajo `arcaConsulta`:
//   { status: 'pending'|'done'|'error', desde, hasta, puntoDeVenta, rows, pages, error, at }
// El driver, sin batch activo, lleva la pestaña a la pantalla de consulta,
// llena el formulario, aprieta Buscar y junta las filas (siguiendo el
// paginador si lo hay). Cada fila: { fecha, tipo, nro, docTipo, doc, cae, importe }.
const CONSULTA_KEY = 'arcaConsulta';
const CONSULTA_URL = '/rcel/jsp/filtrarComprobantesGenerados.do';
const getConsulta = () => chrome.storage.local.get(CONSULTA_KEY).then((r) => r[CONSULTA_KEY] || null);
const setConsulta = (c) => chrome.storage.local.set({ [CONSULTA_KEY]: c });

// Input de texto que sigue a una etiqueta ("Desde", "Hasta"). ARCA no les pone
// id estable a los campos de fecha, así que se buscan por el texto de al lado.
function inputAfterLabel(label) {
    const re = new RegExp(`^\\s*${label}\\s*:?\\s*$`, 'i');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!re.test(n.textContent)) continue;
        let el = n.parentElement;
        for (let up = 0; el && up < 4; up++, el = el.parentElement) {
            const cand = [...el.querySelectorAll('input[type=text]')];
            if (cand.length) return cand[0];
            const sib = el.nextElementSibling;
            if (sib?.matches?.('input[type=text]')) return sib;
            const inner = sib?.querySelector?.('input[type=text]');
            if (inner) return inner;
        }
    }
    return null;
}

async function consultaFill(c) {
    // Nombres reales del formulario (vistos 2026-09-05): fechaEmisionDesde,
    // fechaEmisionHasta, puntoDeVenta, idTipoComprobante, idTipoDocumento. La
    // etiqueta queda de respaldo por si ARCA los renombra.
    const texts = [...document.querySelectorAll('input[type=text]')];
    const desde = document.querySelector('[name=fechaEmisionDesde]') || inputAfterLabel('Desde') || texts[0];
    const hasta = document.querySelector('[name=fechaEmisionHasta]') || inputAfterLabel('Hasta') || texts[1];
    if (!desde || !hasta) throw new Error('No encontré los campos de fecha de la consulta');
    setValue(desde, c.desde);
    setValue(hasta, c.hasta);
    // OJO: el select de tipo de comprobante también tiene una opción con value
    // "2" (Nota de Débito A): elegirlo por "tiene una opción con ese número"
    // buscaba notas de débito y daba 0 (pasó en la primera corrida). Va por
    // nombre y, de respaldo, por el texto de la opción ("0002-Azcuenaga…").
    const pv = onlyDigits(c.puntoDeVenta || '');
    if (pv) {
        const sel = document.querySelector('select[name=puntoDeVenta]')
            || [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => new RegExp(`^0*${pv}\\s*-`).test(o.textContent.trim())));
        if (!sel) throw new Error(`No encontré el punto de venta ${pv} en la consulta`);
        setPuntoDeVenta(sel, pv);
    }
    await sleep(300);
    const btn = [...document.querySelectorAll('input[type=button], input[type=submit], button')].find((b) => /buscar/i.test(b.value || b.textContent || ''));
    if (!btn) throw new Error('No encontré el botón Buscar de la consulta');
    btn.click();
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;
function consultaParseRows() {
    const rows = [];
    for (const tr of document.querySelectorAll('tr')) {
        const cells = [...tr.children].filter((td) => /^t[dh]$/i.test(td.tagName)).map((td) => td.innerText.trim());
        if (cells.length < 7 || !DATE_RE.test(cells[0])) continue;
        const ver = tr.querySelector('a[href*="imprimir"], a[href*="Comprobante"], input[onclick*="imprimir"]');
        const href = ver?.getAttribute?.('href') || ver?.getAttribute?.('onclick') || '';
        const idm = href.match(/c=(\d+)/);
        const imp = String(cells[6]).trim();
        // ARCA lista "26909.99" (punto decimal); si alguna vez viene "26.909,99" también se lee.
        const importe = /,\d{1,2}$/.test(imp) ? Number(imp.replace(/\./g, '').replace(',', '.')) : Number(imp.replace(/,/g, ''));
        rows.push({
            fecha: cells[0],
            tipo: cells[1],
            nro: cells[2],
            docTipo: cells[3],
            doc: onlyDigits(cells[4]),
            cae: onlyDigits(cells[5]),
            importe: Number.isFinite(importe) ? importe : 0,
            idComprobante: idm ? idm[1] : null,
        });
    }
    return rows;
}

// Paginador (si ARCA lo muestra): "Siguiente", "Próxima", ">" o ">>".
function consultaNextPage() {
    const cands = [...document.querySelectorAll('a, input[type=button], input[type=submit], button')]
        .filter((el) => el.offsetParent !== null && !el.disabled)
        .filter((el) => /^(siguiente|pr[oó]xim[ao]|>|>>|»)\s*$/i.test((el.value || el.textContent || '').trim()));
    return cands[0] || null;
}

async function consultaCollect(c) {
    const rows = consultaParseRows();
    const seen = new Set((c.rows || []).map((r) => `${r.nro}|${r.tipo}`));
    const fresh = rows.filter((r) => !seen.has(`${r.nro}|${r.tipo}`));
    c.rows = [...(c.rows || []), ...fresh];
    c.pages = (c.pages || 0) + 1;
    const next = fresh.length && c.pages < 200 ? consultaNextPage() : null;
    if (next) {
        await setConsulta(c);
        next.click();
        return;
    }
    c.status = 'done';
    c.at = Date.now();
    await setConsulta(c);
    renderConsultaPanel(c);
}

function renderConsultaPanel(c) {
    const el = ensurePanel();
    const n = (c.rows || []).length;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Consulta lista ✅</div>
        <div style="opacity:.85">${n} comprobante${n === 1 ? '' : 's'} del PV ${c.puntoDeVenta || '—'} entre ${c.desde} y ${c.hasta}.</div>
        <div style="margin-top:6px;opacity:.8">Volvé al admin: ahí se cruzan contra las ventas y se marcan solas.</div>
        <div style="margin-top:10px"><button id="pa-close" style="${btnStyle('#333')}">Cerrar</button></div>`;
    el.querySelector('#pa-close').onclick = () => el.remove();
}

function renderConsultaBusy(note) {
    const el = ensurePanel();
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Consultando ARCA…</div>
        <div style="opacity:.85">${note}</div>`;
}

// Devuelve true si esta carga de página la consumió la consulta.
async function runConsulta(c) {
    const href = location.href;
    try {
        if (href.includes('filtrarComprobantesGenerados.do')) {
            renderConsultaBusy(`Buscando comprobantes del PV ${c.puntoDeVenta || '—'} entre ${c.desde} y ${c.hasta}.`);
            await consultaFill(c);
        } else if (href.includes('buscarComprobantesGenerados.do')) {
            renderConsultaBusy('Leyendo la tabla…');
            await consultaCollect(c);
        } else if (href.includes('index_bis.jsp')) {
            stepEmpresa({ results: [], queue: [{}] }, null);
        } else {
            location.href = CONSULTA_URL;
        }
    } catch (e) {
        console.error('[ARCA consulta]', e);
        c.status = 'error';
        c.error = e.message;
        await setConsulta(c);
    }
    return true;
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
    // "Cruzar con ARCA" pendiente y sin batch corriendo: esta pestaña se usa
    // para la consulta. Con un batch activo, la consulta espera a que termine.
    const consulta = ON_RCEL ? await getConsulta() : null;
    const consultaViva = consulta?.status === 'pending' && Date.now() - (consulta.at || 0) < 2 * 3600 * 1000;
    if (consultaViva && !(state?.active && state.queue?.length)) {
        await runConsulta(consulta);
        return;
    }
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
    const idx = stepIndex(location.href);
    armVolverGuard();
    await patchPageAlert();

    // Fuimos para atrás sin pasar por el inicio: eso lo hace un humano (Volver
    // o la flecha del navegador), nunca el driver. Pasa a modo manual aunque
    // el botón no se haya podido interceptar.
    if (!state.manual && idx != null && state.step != null && idx < state.step) {
        state.manual = true;
    }

    if (state.manual) {
        if (idx === RESUMEN_STEP && document.querySelector('#btngenerar')) {
            // De vuelta en el resumen: retoma, pero lo que se tocó a mano lo
            // revisa una persona antes de generar, sea cual sea el modo.
            state.manual = false;
            state.step = idx;
            await setState(state);
            renderConfirmPanel(state, inv);
            return;
        }
        if (idx != null) state.step = idx;
        await setState(state);
        renderManualPanel(state, inv);
        return;
    }

    // Watchdog anti-loop: si una factura reprocesa demasiados pasos, la saltamos.
    state.attempts = state.attempts || {};
    state.attempts[inv.orderId] = (state.attempts[inv.orderId] || 0) + 1;
    if (idx != null) state.step = idx;
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
        await runStep(location.href, inv, cfg, state);
    } catch (e) {
        console.error('[ARCA driver]', e);
        if (isFatalMessage(e.message)) await pauseBatch(state, e.message);
        else await failCurrent(state, inv, e.message);
    }
})();
