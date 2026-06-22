const Storage = {
    dataKey: 'sales',
    language: 'spanish',
    events: {
        newData: []
    },

    async init() {
        await this.get();
    },

    async get(callback = () => { }) {
        this.sales = (await chrome.storage.local.get([this.dataKey])).sales || {};
        callback(this.sales);
        return this.sales;
    },

    save(sale) {
        this.get().then((sales) => {
            sales[sale.id] = sale;
            chrome.storage.local.set({ sales }).then((newValue) => { });
        });
    },

    on(event, callback) {
        this.events[event].push(callback);
    },

    off(event, callback) {
        this.events[event] = this.events[event].filter(cb => cb !== callback);
    }
};

Storage.init();

window.pokeArgentumExtension = {
    Storage
};
