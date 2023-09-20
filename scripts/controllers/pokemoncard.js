(async () => {
    const num = elem => {
        const title = elem.querySelector('.grid-view-item__title').innerText;
        const num = title.match(/\d+\/\d+/);
        if (!num) {
            return Infinity
        }
        return num[0].split('/')[0]
    };

    const grid = document.querySelector('#main-collection-product-grid');
    if (!grid) return;

    await Manipulator.init({
        cardContainer: '#main-collection-product-grid li',
        cardTitle: '.grid-view-item__title',
        infoContainer: '.normal_main_content'
    });

    const elems = Array.from(grid.querySelectorAll('li'));
    grid.innerHTML = '';
    elems.sort((a, b) => a.classList.contains('has-card') ? 1 : (num(a) > num(b) ? 1 : -1))
    elems.forEach(e => grid.appendChild(e))
})();

const PokemonCard = {
    init() {
        setTimeout(() => {
            this.events();
            this.pagination();
        }, 1000)
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
        const pages = document.querySelector('.pagination-block .parts').children;
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
