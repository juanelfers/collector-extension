const TCGPremium = {
    init() {
        window.addEventListener('message', (event) => {
            if (event.data.target !== 'tcg-premium-extension') return;
            this.handleMessage(event);
        });
    },

    handleMessage() {
        const { data } = event;

        switch (data.event) {
            case 'pageReady':
                this.pageReady();
                break;

            case 'updateCollectionFront':
                this.updateCollectionFront(data.collection, data.card);
                break;

            case 'updateCollectionDateAndGroup':
                this.updateCollectionDateAndGroup(data.collection, data.date, data.group);
                break;
        }
    },

    async pageReady() {
        const collections = await Storage.get();
        this.sendCollections(collections);
    },

    async updateCollectionDateAndGroup(collection, date, group) {
        const collections = await Storage.get();
        collections[collection].date = date;
        collections[collection].group = group;
        Storage.save(collections[collection]);
    },

    async updateCollectionFront(collection, card) {
        const collections = await Storage.get();        
        collections[collection].frontPage = card;
        Storage.save(collections[collection]);
    },

    sendCollections(collections) {
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'collections',
                collections
            });
        } catch { }
    }
};

TCGPremium.init();
