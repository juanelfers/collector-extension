// Listen to changes in storage
chrome.storage.onChanged.addListener((...data) => {});

// Listen to Pokellextor changes
chrome.webRequest.onCompleted.addListener(
    (...details) => {
        if (details[0].url !== "https://www.pokellector.com/ajax/controllers/collection") return;

        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            const [{ id }] = tabs;
            chrome.tabs.sendMessage(id, { action: "updatedCollection", details });
        });
    },
    { urls: ["<all_urls>"] }
);

chrome.runtime.onInstalled.addListener(() => {
    const urls = [
        'Scarlet-Violet-151',
        'Obsidian-Flames',
        'Paldea-Evolved',
        'Scarlet-Violet-English',
        'Crown-Zenith-Galarian-Gallery',
        'Crown-Zenith',
        'Silver-Tempest',
        'Silver-Tempest-Trainer-Gallery',
        'Lost-Origin',
        'Lost-Origin-Trainer-Gallery',
        'English-Pokemon-Go',
        'Astral-Radiance',
        'Astral-Radiance-Trainer-Gallery',
        'Brilliant-Stars',
        'Evolving-Skies',
        'Chilling-Reign',
        'Vivid-Voltage',
        'Darkness-Ablaze',
        'English-Sword-Shield',
        'Base-Set',
    ].map(u => `https://www.pokellector.com/${u}-Expansion/`);
    
    urls.forEach(url => {
        chrome.tabs.create({
            url,
            active: false
        }, tab => {
            chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, updatedTab) {
                if (tabId === tab.id && changeInfo.status === 'complete') {
                    chrome.tabs.remove(tabId);
                }
            });
        });
    });
});