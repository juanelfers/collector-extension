const num = elem => {
    const title = elem.querySelector('.grid-view-item__title').innerText;
    const num = title.match(/\d+\/\d+/);
    if (!num) {
        return Infinity
    }
    return num[0].split('/')[0]
};
const grid = document.querySelector('#main-collection-product-grid');
const elems = Array.from(grid.querySelectorAll('li'));
grid.innerHTML = '';
elems.sort((a, b) => num(a) > num(b) ? 1 : -1)
elems.forEach(e => grid.appendChild(e))


Manipulator.init({
    cardContainer: '#main-collection-product-grid li',
    cardTitle: '.grid-view-item__title',
    infoContainer: '.normal_main_content'
});
