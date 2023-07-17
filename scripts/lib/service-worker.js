chrome.storage.onChanged.addListener((...data) => {
    console.log('Storage changed', data);
});

console.log('Service worker');

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log({tabs})
    const message = {
        action: 'setGlobalVariable',
        variableName: 'miVariableGlobal',
        variableValue: 'valor de la variable global',
    };

    // chrome.tabs.sendMessage(tabs[0].id, message);
});