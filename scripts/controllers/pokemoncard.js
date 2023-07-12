const PokemonCard = {
    async init() {
        this.collections = await Storage.get();
        this.checkCards()
    },

    checkCards() {
        document.querySelectorAll('#main-collection-product-grid li').forEach(this.processCard.bind(this));
    },

    processCard(card) {
        const title = card.querySelector('.grid-view-item__title').innerText;
        try {
            const [name] = title.split(' (') // .match(/([\w ]+\w)/)[0];
            const [number, collectionCount] = (([n, c]) => [+n.match(/\d+/)[0], +c.match(/\d+/)[0]])(title.match(/\w{0,2}\d+\/\w{0,2}\d+/)[0].split('/'));
            this.fixCard({ card, title }, { name, number, collectionCount });
        } catch (error) {
            console.warn('Error on reading card info', error);
        }
    },

    fixCard({ card: container, title }, card) {
        let foundCard = Storage.findCard(card);

        container.style.background = !foundCard ? '#FFC' : foundCard.hasCard ? '#CFC' : '#CCF';
    }
};

PokemonCard.init();
