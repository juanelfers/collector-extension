const PokemonCard = {
    count: 0,

    async init() {
        console.log('Pokemoncard');
        this.collections = await Storage.get();
        this.checkCards();
        console.log('checked')
    },

    checkCards() {
        const allCards = document.querySelectorAll('#main-collection-product-grid li');
        const data = Array.from(allCards).map(this.processCard.bind(this));

        const unknown = data.filter(({ info }) => !info);
        const has = data.filter(({ info }) => info && info.hasCard);
        const notHas = data.filter(({ info }) => info && !info.hasCard);

        console.log({ unknown, has, notHas });

        const message = notHas.length
            ? notHas.length + ` nuevas cartas encontradas!`
            : unknown.length
                ? unknown.length + ` cartas desconocidas encontradas`
                : has.length + ` cartas repetidas encontradas`;
        const summary = document.createElement('div');
        summary.innerHTML = message;

        document.querySelector('.normal_main_content').prepend(summary);
    },

    processCard(card) {
        const title = card.querySelector('.grid-view-item__title').innerText;
        console.log({ card })
        try {
            const [name] = title.split(' (') // .match(/([\w ]+\w)/)[0];
            const [number, collectionCount] = (([n, c]) => [+n.match(/\d+/)[0], +c.match(/\d+/)[0]])(title.match(/\w{0,2}\d+\/\w{0,2}\d+/)[0].split('/'));
            return this.fixCard({ card, title }, { name, number, collectionCount });
        } catch (error) {
            console.warn('Error on reading card info', error);
        }
    },

    fixCard({ card: container, title }, card) {
        const foundCard = Storage.findCard(card);

        container.style.background = !foundCard ? '#FFC' : foundCard.hasCard ? '#CFC' : '#CCF';
        
        if (foundCard && !foundCard.hasCard) {
            this.addLink(foundCard, container);
        }

        return { card, info: foundCard };
    },

    addLink (foundCard, container) {
        const link = document.createElement('a');
        link.href = foundCard.link;
        link.innerHTML = foundCard.link;
        link.target = '_blank';
        container.appendChild(link);
    }
};

PokemonCard.init();
