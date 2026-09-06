const TCGPremium = {
    init() {
        console.log('init TCGPremium')
        window.addEventListener('message', (event) => {
            if (event.data.target !== 'pokeargentum-extension') return;
            this.handleMessage(event);
        });
    },

    handleMessage(event) {
        // Si la extensión se recargó, este script quedó huérfano: window.* le
        // sigue andando pero chrome.* tira "Extension context invalidated".
        // Avisamos a la página para que pida un F5 en vez de fallar mudos.
        if (!chrome.runtime?.id) {
            try {
                window.postMessage({ target: 'tcg-premium-admin', event: 'extensionStale' });
            } catch { }
            return;
        }
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
            case 'getInvoicePdfs':
                this.sendInvoicePdfs(data);
                break;
            case 'startMlUpload':
                this.startMlUpload(data);
                break;
            case 'getMlUploadResults':
                this.sendMlUploadResults();
                break;
            case 'loadArcaConsulta':
                this.loadArcaConsulta(data);
                break;
            case 'getArcaConsulta':
                this.sendArcaConsulta();
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
    // OJO: un batch de cientos de facturas dura horas. Si ya hay uno vivo, NO lo
    // pisamos: se rebota con `invoiceQueueBusy` y que el humano decida. Un batch
    // en PAUSA también cuenta como vivo (la cola sigue ahí, esperando reanudar).
    async loadInvoiceQueue({ queue = [], config = {}, mode = 'auto', force = false }) {
        const { invoicing } = await chrome.storage.local.get('invoicing');
        const pending = invoicing?.queue?.length || 0;
        if (pending && !force) {
            try {
                window.postMessage({
                    target: 'tcg-premium-admin',
                    event: 'invoiceQueueBusy',
                    pending,
                    done: invoicing?.results?.length || 0
                });
            } catch { }
            return;
        }
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

    // PDFs capturados por el driver de ARCA, pendientes de subir a ML, de UNA
    // cuenta. Cada PDF lleva `seller` (la cuenta que facturó). Los que no lo
    // tienen son del batch de konekotekka del 2026-09-05, anterior a la
    // etiqueta: se tratan como de konekotekka. Sin `seller` en el pedido
    // (bridge viejo de pokeargentum.com) se asume pokeargentum.
    async pendingPdfIds(seller) {
        const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
        const wanted = seller || 'pokeargentum';
        return Object.keys(invoicePdfs).filter((id) => {
            const e = invoicePdfs[id];
            if (!e?.dataUrl || e.uploaded) return false;
            return (e.seller || 'konekotekka') === wanted;
        });
    },

    async sendInvoicePdfs({ seller } = {}) {
        const pending = await this.pendingPdfIds(seller);
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'invoicePdfs',
                pending
            });
        } catch { }
    },

    // El admin dispara la subida de facturas a ML: armamos la cola con todos
    // los PDFs pendientes y abrimos la primera orden. De ahí en más el driver
    // (ml-invoices.js) encadena solo, orden por orden.
    // `mlIds`: { [orderId/pack]: idDeOrdenML } — la pantalla de adjuntar de ML
    // sólo acepta el id de ORDEN, y la clave de los PDF es el id del pack. El
    // admin lo manda para completar lo que el driver de ARCA no tenía.
    // `openTab: false` deja la cola armada sin abrir la pestaña (para probar
    // desde una pestaña propia).
    async startMlUpload({ seller, mlIds = {}, openTab = true } = {}) {
        const pending = await this.pendingPdfIds(seller);
        if (pending.length) {
            const { invoicePdfs = {} } = await chrome.storage.local.get('invoicePdfs');
            for (const id of pending) {
                if (mlIds[id] && invoicePdfs[id]) invoicePdfs[id] = { ...invoicePdfs[id], mlOrderId: String(mlIds[id]) };
            }
            await chrome.storage.local.set({
                invoicePdfs,
                mlUpload: { active: true, queue: pending, results: [], attempts: {} }
            });
            const first = invoicePdfs[pending[0]]?.mlOrderId || pending[0];
            if (openTab) {
                chrome.runtime.sendMessage({
                    type: 'open-tab',
                    url: `https://vendedores.mercadolibre.com.ar/emisor/adjuntar-factura?orders_ids=${first}`
                });
            }
        }
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'mlUploadStarted',
                count: pending.length
            });
        } catch { }
    },

    // "Cruzar con ARCA": el admin pide los comprobantes emitidos en un rango del
    // punto de venta. Queda como pedido pendiente en storage; el driver de ARCA
    // (all.js) lo resuelve en la pantalla de Consultas cuando no hay batch
    // corriendo y deja las filas en el mismo objeto (status 'done').
    async loadArcaConsulta({ desde, hasta, puntoDeVenta, seller = null }) {
        const req = { status: 'pending', desde, hasta, puntoDeVenta, seller, rows: [], pages: 0, at: Date.now() };
        await chrome.storage.local.set({ arcaConsulta: req });
        try {
            window.postMessage({ target: 'tcg-premium-admin', event: 'arcaConsultaLoaded' });
        } catch { }
    },

    async sendArcaConsulta() {
        const { arcaConsulta } = await chrome.storage.local.get('arcaConsulta');
        try {
            window.postMessage({ target: 'tcg-premium-admin', event: 'arcaConsulta', consulta: arcaConsulta || null });
        } catch { }
    },

    // Cómo va la subida a ML: hechas, en cola, en vuelo. Para el progreso vivo
    // del admin (y para saber por qué se trabó sin abrir DevTools).
    async sendMlUploadResults() {
        const { mlUpload } = await chrome.storage.local.get('mlUpload');
        try {
            window.postMessage({
                target: 'tcg-premium-admin',
                event: 'mlUploadResults',
                results: mlUpload?.results || [],
                pending: mlUpload?.queue?.length || 0,
                current: mlUpload?.queue?.[0] || null,
                inFlight: mlUpload?.inFlight || null,
                active: Boolean(mlUpload?.active)
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
