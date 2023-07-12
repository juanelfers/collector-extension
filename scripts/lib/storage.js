const Storage = {
    language: 'spanish',

    init() {

    },

    get() {
        return chrome.storage.local.get(['collections']).then(({ collections }) => {
            this.collections = collections || {};
            return this.collections;
        })
    },

    save(collection) {
        this.get().then((collections) => {
            console.log('Collections', collections);

            if (!this.hasChanged(collection, collections)) return;

            // if (!confirm(this.getMessage('confirmSave', { collectionName: collection.name }))) return;

            collections[collection.name] = collection;

            chrome.storage.local.set({ collections }).then((newValue) => {
                console.log("Value is set", newValue);
            });
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

        const collectionsMatch = Object.values(collections).filter((collection) => {
            const quantityMatch = collection.cardQuantity === collectionCount;
            return quantityMatch && collection.cardList.length >= number;
        })

        collectionsMatch.forEach((collection) => {
            const possibleCard = collection.cardList[number - 1];

            if (possibleCard.cardName.trim().toLowerCase() === name.trim().toLowerCase()) {
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
    }
};

Storage.init();
