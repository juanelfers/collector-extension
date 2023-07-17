const Pokellector = {
    cardContainer: 'div.card',
    language: 'spanish',

    init() {
        const { location } = window;
        const collection = this.checkCollection();
        collection && Storage.save(collection)

        console.log({ location, collection });
    },
    
    checkCollection() {
        const cards = document.querySelector('.cards');

        if (!cards) return null;

        let cardCount = 0;
        const cardList = Array.from(document.querySelectorAll(this.cardContainer)).map(card => {
            const hasCard = card.classList.contains('checked');
            const [number, name] = (([number, name]) => [number.slice(1), name])(card.querySelector('.plaque').innerText.split(' - '));
            const image = card.querySelector('img').dataset.src;
            const link = card.querySelector('a').href;

            if (hasCard) cardCount++;

            return {
                number,
                name,
                link,
                image,
                hasCard,
            };
        });

        const name = document.querySelector('#siteBody h1').textContent;
        const cardQuantity = +document.querySelectorAll('.cards')?.[0]?.innerText.match(/[0-9]+/)[0];
        const secretCardQuantity = cardList.length - cardQuantity;

        return {
            name,
            cardQuantity,
            secretCardQuantity,
            cardList,
            cardCount
        };
    },

    getMessage(message, data) {
        return {
            confirmSave: {
                english: `Do you wish to update the list for the collection ${data.collectionName}?`,
                spanish: `Desea actualizar la lista para la colección ${data.collectionName}?`,
            }
        }[message][this.language];
    }
};

Pokellector.init();
