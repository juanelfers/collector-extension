const PokemonCard = {
    init() {
        Manipulator.init({
            cardsContainer: '#main-collection-product-grid',
            cardContainer: '#main-collection-product-grid li',
            cardTitle: '.grid-view-item__title',
            infoContainer: '.normal_main_content',
            sortCards: true
        });

        this.events();
        this.pagination();
    },

    events() {
        const backInStock = document.querySelector('.gBackInStockBtn');
        if (!backInStock) return;

        backInStock.innerHTML = '¡Notificarme cuando haya stock!'
        backInStock.addEventListener('click', () =>
            setTimeout(() => {
                document.querySelector('#email').value = 'juan.elfers@gmail.com'
                document.querySelector('.gSubscribeBtn.gEnableSubscribe').click();
            })
        )
    },

    pagination() {
        const parts = document.querySelector('.pagination-block .parts');
        if (!parts) return;

        const pages = parts.children;
        const lastPage = pages[pages.length - 1]
        const lastPageNumber = +lastPage.innerText;
        const originalHref = lastPage.href;
        parts.innerHTML = '';

        for (let page = 1; page <= lastPageNumber; page++) {
            const href = originalHref.replace(/page=[0-9]+/, 'page=' + page);
            parts.innerHTML += `<a href="${href}" class="item link">${page}</a>`
        }
    }
}

PokemonCard.init();
