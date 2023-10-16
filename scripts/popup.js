const table = document.querySelector('table tbody');

chrome.storage.local.get(['collections']).then(({ collections }) => {
    if (!collections) return;
    
    Object.values(collections).forEach(collection => {

        const collectionRow = document.createElement('tr');
        collectionRow.innerHTML = `
            <td>${collection.name}</td>
            <td>${collection.cardCount} / ${collection.cardQuantity}</td>
        `;
        table.appendChild(collectionRow);
    });
});