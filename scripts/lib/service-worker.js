chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "get_downloads") {
        chrome.downloads.search({}, (results) => {
            console.log("Archivos en descargas:", results);
            sendResponse(results);
        });
    }
    return true; // Para usar sendResponse de forma asíncrona
});