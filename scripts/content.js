const Extension = {
    cardContainer: 'div.card',

    init () {
        const collection = this.checkCollection();
        console.log({ collection });
    },

    checkCollection () {
        const cards = document.querySelector('.cards');

        if (!cards) return null;

        const cardList = Array.from(document.querySelectorAll(this.cardContainer)).map(card => {
            const [cardNumber, cardName] = card.querySelector('.plaque').innerText.split(' - ');
            const cardImage = card.querySelector('img').src;

            return {
                cardNumber,
                cardName,
                cardImage
            }
        });

        const collectionName = document.querySelector('#siteBody h1').textContent;
        const cardQuantity = +document.querySelectorAll('.cards')?.[0]?.innerText.match(/[0-9]+/)[0];
        const secretCardQuantity = cardList.length - cardQuantity;

        return {
            cardQuantity,
            secretCardQuantity,
            cardList,
        }
    }
};

Extension.init();
