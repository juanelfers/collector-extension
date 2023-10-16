// Listen to changes in storage
chrome.storage.onChanged.addListener((...data) => {
    console.log('Storage changed', data);
});


// Listen to Pokellextor changes
chrome.webRequest.onCompleted.addListener(
    (...details) => {
        console.log('Details', details)
        if (details[0].url !== "https://www.pokellector.com/ajax/controllers/collection") return;

        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const [{ id }] = tabs;
            chrome.tabs.sendMessage(id, { action: "updatedCollection", details });
        });
    },
    { urls: ["<all_urls>"] }
);