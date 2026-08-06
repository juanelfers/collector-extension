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
        chrome.downloads.download({
            url: message.dataUrl,
            filename: `facturas-arca/${message.orderId}.pdf`,
            conflictAction: "overwrite",
        });
        return false;
    }

    // El driver de ARCA va a clickear "Imprimir" (no pudo capturar el PDF por
    // fetch): renombramos la descarga que dispare AFIP para no perder el mapeo
    // orden → archivo.
    if (message.type === "expect-afip-pdf") {
        expectedAfipOrder = message.orderId;
        return false;
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
