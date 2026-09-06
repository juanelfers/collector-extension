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

    // El bridge pide abrir una pestaña (p.ej. la primera orden de ML a subir).
    if (message.type === "open-tab") {
        chrome.tabs.create({ url: message.url });
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
