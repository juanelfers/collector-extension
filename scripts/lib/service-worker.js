// Último orderId que está por disparar una descarga desde ARCA (fallback del
// botón Imprimir). Variable de módulo: el SW puede dormirse y perderla, pero
// el click → descarga tarda milisegundos, así que en la práctica alcanza.
let expectedAfipOrder = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "get_downloads") {
        chrome.downloads.search({}, (results) => {
            console.log("Archivos en descargas:", results);
            sendResponse(results);
        });
        return true; // sendResponse asíncrono
    }

    // El driver de ARCA capturó el PDF del comprobante: lo bajamos a disco con
    // el nombre de la orden de ML, así subirlo (a mano o con el driver de ML)
    // es matchear por nombre de archivo.
    if (message.type === "save-pdf") {
        chrome.downloads.download(
            {
                url: message.dataUrl,
                filename: `facturas-arca/${message.orderId}.pdf`,
                conflictAction: "overwrite",
                saveAs: false,
            },
            (id) => {
                // En el batch del 2026-09-05 no quedó NINGÚN archivo en disco y
                // no había ni un error a la vista: que al menos se loguee.
                if (chrome.runtime.lastError) console.warn("save-pdf falló", message.orderId, chrome.runtime.lastError.message);
                else console.log("save-pdf ok", message.orderId, id);
            },
        );
        return false;
    }

    // El driver de ARCA va a clickear "Imprimir" (no pudo capturar el PDF por
    // fetch): renombramos la descarga que dispare AFIP para no perder el mapeo
    // orden → archivo.
    if (message.type === "expect-afip-pdf") {
        expectedAfipOrder = message.orderId;
        return false;
    }

    // El driver de ARCA necesita una GLOBAL de la página (idComprobante, que
    // rellena el AJAX de generar). El content script vive en otro mundo y no
    // la ve: se lee desde acá con executeScript en el MAIN world (necesita
    // host_permissions de fe.afip.gob.ar en el manifest).
    // Reemplaza window.alert de la página (MAIN world) por uno que no bloquea:
    // deja el texto en un atributo del <html> y lo loguea. Los alert() de ARCA
    // congelaban la pestaña entera con el driver adentro.
    if (message.type === "patch-alert") {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse(false);
            return false;
        }
        chrome.scripting
            .executeScript({
                target: { tabId },
                world: "MAIN",
                func: (attr) => {
                    if (window.__paAlertPatched) return true;
                    window.__paAlertPatched = true;
                    window.alert = (m) => {
                        document.documentElement.setAttribute(attr, String(m ?? ""));
                        console.warn("[ARCA alert capturado]", m);
                    };
                    return true;
                },
                args: [message.attr || "data-pa-alert"],
            })
            .then(() => sendResponse(true))
            .catch((e) => {
                console.warn("patch-alert falló", e);
                sendResponse(false);
            });
        return true;
    }

    if (message.type === "read-page-var") {
        const tabId = sender.tab?.id;
        if (!tabId) {
            sendResponse(null);
            return false;
        }
        chrome.scripting
            .executeScript({
                target: { tabId },
                world: "MAIN",
                func: (name) => {
                    try {
                        const v = globalThis[name];
                        return v == null ? "" : String(v);
                    } catch {
                        return "";
                    }
                },
                args: [message.name],
            })
            .then((res) => sendResponse(res?.[0]?.result ?? null))
            .catch((e) => {
                console.warn("read-page-var falló", e);
                sendResponse(null);
            });
        return true; // sendResponse asíncrono
    }

    // BringIt · "Mis compras": ¿el despacho de Correo Argentino llegó? Lo
    // pregunta el SW porque la página de BringIt no puede leer una respuesta
    // de correoargentino.com.ar (CORS); acá alcanza con el host_permissions.
    if (message.type === "correo-tracking") {
        fetchCorreoTracking(message.tracking).then(sendResponse);
        return true; // sendResponse asíncrono
    }

    // El bridge pide abrir una pestaña (p.ej. la primera orden de ML a subir).
    if (message.type === "open-tab") {
        chrome.tabs.create({ url: message.url });
        return false;
    }

    // "Reanudar" desde el admin: llevar la pestaña de ARCA (o de ML) que ya
    // está abierta a la URL pedida, para que el driver arranque sin que la
    // persona tenga que ir a buscarla. Si no hay ninguna, se abre una nueva
    // (ARCA por el SSO: /rcel/jsp/* en frío da 403).
    if (message.type === "arca-go" || message.type === "ml-go") {
        const pattern = message.type === "arca-go" ? "https://fe.afip.gob.ar/*" : "https://vendedores.mercadolibre.com.ar/*";
        chrome.tabs.query({ url: pattern }, (tabs) => {
            const tab = tabs && tabs[0];
            if (tab) {
                chrome.tabs.update(tab.id, { url: message.url, active: true });
            } else {
                const url = message.type === "arca-go"
                    ? "https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel"
                    : message.url;
                chrome.tabs.create({ url });
            }
        });
        return false;
    }

    return false;
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const from = `${item.url || ""} ${item.referrer || ""}`;
    if (expectedAfipOrder && /afip\.gob\.ar|arca\.gob\.ar/i.test(from)) {
        suggest({ filename: `facturas-arca/${expectedAfipOrder}.pdf`, conflictAction: "overwrite" });
        expectedAfipOrder = null;
        return;
    }
    suggest();
});

// ─── Seguimiento de Correo Argentino ─────────────────────────────────────
//
// Mismo cliente que usa la web de PokeArgentum para avisar entregas
// (pokeargentum-fulldeck: app/api/lib/tracking/correoArgentino.js). El
// formulario público https://www.correoargentino.com.ar/formularios/e-commerce
// hace por detrás un POST a wsFacade.php sin reCAPTCHA ni login, y devuelve el
// historial como un fragmento HTML: una tabla Fecha | Planta | Historia |
// Estado cuya PRIMERA fila es el último movimiento. Es un endpoint no oficial
// (y detrás de un WAF): nunca tira, devuelve { ok: false, error }.

const CORREO_ENDPOINT = "https://www.correoargentino.com.ar/sites/all/modules/custom/ca_forms/api/wsFacade.php";

async function fetchCorreoTracking(trackingNumber) {
    const id = String(trackingNumber || "").trim();
    if (!id) return { ok: false, error: "sin tracking" };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(CORREO_ENDPOINT, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            },
            body: new URLSearchParams({ action: "ecommerce", id, producto: "", pais: "" }).toString(),
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const html = await res.text();
        // Pieza inexistente, respuesta vacía o challenge del WAF.
        if (!html.includes("data-title")) return { ok: false, error: "sin resultados" };

        const rows = parseCorreoRows(html);
        if (!rows.length) return { ok: false, error: "sin filas" };

        const piece = (html.match(/pieza:\s*<span[^>]*>([^<]+)<\/span>/i)?.[1] || "").trim();
        return { ok: true, piece, planta: rows[0].planta, fecha: rows[0].fecha, ...classifyCorreo(rows) };
    } catch (err) {
        return { ok: false, error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

// El markup es inválido (los <tr> no cierran): se parsea por celdas, de a 4
// <td data-title="..."> consecutivos por fila.
function parseCorreoRows(html) {
    const decode = (s) =>
        s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&aacute;/g, "á");
    const cells = [...html.matchAll(/<td[^>]*data-title="([^"]*)"[^>]*>([^<]*)<\/td>/g)]
        .map((m) => ({ title: m[1].replace(/:$/, "").toLowerCase(), value: decode(m[2].trim()) }));

    const rows = [];
    for (let i = 0; i + 3 < cells.length; i += 4) {
        const row = {};
        for (const c of cells.slice(i, i + 4)) row[c.title] = c.value;
        rows.push({ fecha: row.fecha || "", planta: row.planta || "", historia: row.historia || "", estado: row.estado || "" });
    }
    return rows;
}

//   delivered  → en manos del cliente (a domicilio o retirado en sucursal)
//   at_branch  → esperando retiro en sucursal (hay que ir a buscarlo)
//   failed     → devolución / no entregado
//   in_transit → en movimiento
//   pending    → sólo preimposición
function classifyCorreo(rows) {
    const top = rows[0];
    const hist = (top.historia || "").toUpperCase();
    const est = (top.estado || "").toUpperCase();
    const text = (top.estado || top.historia || "").trim();

    let status;
    if (est.includes("ENTREGADO") || hist.includes("ENTREGADO") || est.includes("ENTREGA EN SUCURSAL")) status = "delivered";
    // "INTENTO DE ENTREGA" + "EN ESPERA EN SUCURSAL": no lo encontraron, quedó para retirar.
    else if (text.toUpperCase().includes("SUCURSAL")) status = "at_branch";
    else if (hist.includes("INTENTO DE ENTREGA") || hist.includes("DEVOL") || hist.includes("NO ENTREG")) status = "failed";
    else if (hist.includes("PREIMPOSICION") || hist.includes("PREIMPOSICIÓN")) status = "pending";
    else status = "in_transit";

    // "31-08-2026 16:52" → "2026-08-31 16:52"
    const m = (top.fecha || "").match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})/);
    const deliveredAt = status === "delivered" && m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : null;

    return { status, rawStatus: (text || hist).slice(0, 120), deliveredAt };
}
