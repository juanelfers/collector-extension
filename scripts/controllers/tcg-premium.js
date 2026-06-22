const TCGPremium = {
    init() {
        console.log('init TCGPremium')
        window.addEventListener('message', (event) => {
            if (event.data.target !== 'pokeargentum-extension') return;
            this.handleMessage(event);
        });
    },

    handleMessage(event) {
        const { data } = event;
        switch (data.event) {
            case 'loadSales':
                this.loadSales();
                break;
            case 'loadInvoiceQueue':
                this.loadInvoiceQueue(data);
                break;
            case 'getInvoiceResults':
                this.sendInvoiceResults();
                break;
        }
    },

    async loadSales() {
        const salesData = await Storage.get();
        console.log({ salesData })
        this.sendSalesData(salesData);
    },

    sendSalesData(sales) {
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'salesData',
                sales
            });
        } catch { }
    },

    // El admin manda la cola de facturación; la guardamos en chrome.storage.local
    // para que el driver de ARCA (all.js) la consuma en fe.afip.gob.ar.
    async loadInvoiceQueue({ queue = [], config = {}, mode = 'auto' }) {
        const state = { active: true, mode, config, queue, results: [], attempts: {} };
        await chrome.storage.local.set({ invoicing: state });
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'invoiceQueueLoaded',
                count: queue.length
            });
        } catch { }
    },

    // El admin pide los resultados (qué órdenes se facturaron) para marcarlas.
    async sendInvoiceResults() {
        const { invoicing } = await chrome.storage.local.get('invoicing');
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'invoiceResults',
                results: invoicing?.results || [],
                pending: invoicing?.queue?.length || 0,
                active: Boolean(invoicing?.active)
            });
        } catch { }
    }
};

TCGPremium.init();
