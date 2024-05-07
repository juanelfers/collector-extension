const Storage = {
    language: 'spanish',
    events: {
        newData: []
    },

    init() {

    },

    async get(callback = () => { }) {
        this.collections = (await chrome.storage.local.get(['collections'])).collections || {};
        callback(this.collections);
        return this.collections;
    },

    save(collection) {
        this.get().then((collections) => {

            if (!this.hasChanged(collection, collections)) return;

            // if (!confirm(this.getMessage('confirmSave', { collectionName: collection.name }))) return;

            // Create it
            if (!collections[collection.name]) {
                collections[collection.name] = collection;
            }
            else {
                collections[collection.name] = {
                    ...collections[collection.name],
                    ...collection
                };
            }

            chrome.storage.local.set({ collections }).then((newValue) => {});
        });
    },

    hasChanged(collection, collections) {
        return (
            !collections[collection] ||
            JSON.stringify(collection) !== JSON.stringify(collections[collection].name)
        );
    },

    findCard({ name, number, collectionCount }) {
        const { collections } = this;
        let foundCard;

        const collectionsMatch = Object.values(collections).filter((collection) => {
            const quantityMatch = collection.cardQuantity === collectionCount;
            return quantityMatch && collection.cardList.length >= number;
        })

        collectionsMatch.forEach((collection) => {
            const possibleCard = collection.cardList[number - 1];

            const n1 = this.normalizeName(possibleCard.name);
            const n2 = this.normalizeName(name);
            if (n1.includes(n2) || n2.includes(n1)) {
                foundCard = possibleCard;
            }
        });

        if (!foundCard) {
            if (collectionsMatch.length === 1) {
                // container.style.border = '1px solid red';
                foundCard = collectionsMatch[0].cardList[number - 1];
            }
        }

        return foundCard;
    },

    on(event, callback) {
        this.events[event].push(callback);
    },

    off(event, callback) {
        this.events[event] = this.events[event].filter(cb => cb !== callback);
    },

    normalizeName(name) {
        return name.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(lv\s+\d+\)\s*/, '');
    }
};

Storage.init();

window.collectorExtension = {
    Storage
};
