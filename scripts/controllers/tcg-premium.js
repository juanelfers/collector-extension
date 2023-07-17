const TCGPremium = {
    init() {
        window.addEventListener('message', (event) => {
            if (event.data.target !== 'tcg-premium') return;
            this.handleMessage(event);
        });
    },

    handleMessage() {
        const { data } = event;

        if (data.event === 'pageReady') {
            this.showData();
        }
    },

    showData() {
        Storage.get().then(collections => {
            this.sendCollections(collections)
        })
    },

    sendCollections(collections) {
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                collections
            });
        } catch {}
    }
};

TCGPremium.init();
