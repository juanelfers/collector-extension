const Manipulator = {
    count: 0,
    config: null,

    async init(config) {
        this.config = config;
        this.collections = await Storage.get();
        this.checkCards();
        console.log('checked')
        this.appendCSS();
    },

    appendCSS() {
        const css = document.createElement('style');
        css.innerHTML = `
            .tag {
                position: absolute;
                top: 0;
                left: 0;
                padding: 5px 10px;
                color: white;
                border-radius: 3px;
            }
            .has-card .tag {
                background: #F33;
            }
            .not-has-card .tag {
                background: #39F;
            }
            .missing-card .tag {
                background: #F63;
            }
            .has-card {
                filter: grayscale(1);
            }
        `;
        document.body.appendChild(css);
    },

    checkCards() {
        const allCards = document.querySelectorAll(this.config.cardContainer);
        const data = Array.from(allCards).map(this.processCard.bind(this));

        const unknown = data.filter(({ info }) => !info);
        const has = data.filter(({ info }) => info && info.hasCard);
        const notHas = data.filter(({ info }) => info && !info.hasCard);

        console.log({ unknown, has, notHas });

        const button = document.createElement('button');
        const newCards = unknown.length + notHas.length;
        const message = newCards
            ? newCards + ` nuevas cartas encontradas!` + button
            : unknown.length
                ? unknown.length + ` cartas desconocidas encontradas` + button
                : has.length + ` cartas repetidas encontradas`;
        const summary = document.createElement('div');
        summary.innerHTML = message;

        document.querySelector(this.config.infoContainer).prepend(summary);
    },

    processCard(card) {
        const title = card.querySelector(this.config.cardTitle).innerText;
        console.log({ card })
        try {
            const [name] = title.split(/ – | \(/) // .match(/([\w ]+\w)/)[0];
            const [number, collectionCount] = (([n, c]) => [+n.match(/\d+/)[0], +c.match(/\d+/)[0]])(title.match(/\w{0,2}\d+\/\w{0,2}\d+/)[0].split('/'));
            console.log({name, number, collectionCount})
            return this.fixCard({ card, title }, { name, number, collectionCount });
        } catch (error) {
            console.warn('Error on reading card info', error);
            return card;
        }
    },

    fixCard({ card: container, title }, card) {
        const foundCard = Storage.findCard(card);

        container.classList.add(!foundCard
            ? 'missing-card' : foundCard.hasCard
            ? 'has-card'
            : 'not-has-card'
        );

        const text = !foundCard
            ? 'Missing info' : foundCard.hasCard
            ? 'Repetida' : 'Buy!'
        this.addTag(container, text);

        return { card, info: foundCard };
    },

    addTag(container, text) {
        // const link = document.createElement('a');
        // link.href = foundCard.link;
        // link.innerHTML = foundCard.link;
        // link.target = '_blank';
        // container.appendChild(link);

        // 
        container.style.position = 'relative';
        const div = document.createElement('div');
        div.classList.add('tag');
        div.innerHTML = text;
        container.appendChild(div);
    }
};
