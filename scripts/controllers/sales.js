const id = window.location.pathname.match(/\/ventas\/(\d+)/)?.pop();

if (id) {
    setTimeout(save, 1000);
}

function save(tries = 1) {
    if (tries > 3) return;

    const payment = document.querySelector('.sc-title-subtitle-action--payment');
    const rowsList = document.querySelectorAll('.sc-account-rows__list');

    if (!payment || !rowsList.length) {
        setTimeout(save.bind(null, tries + 1), 1000);
        // alert('not ready!');
        return;
    }

    const [clientName, clientId] = payment.innerText.split(/\n/).filter(r => r.trim())[1].split(' - ');

    if (!clientName || !clientId) return;

    let productsTotal;
    let shipping;

    const getValue = elem => elem ? +elem.innerText.replace('$ ', '').replace('.', '').replace(',', '.') : 0;

    rowsList.forEach(row => {
        const rowTitle = row.querySelector('.sc-account-rows__row__title');
        if (!rowTitle) return;

        const heading = rowTitle.innerText.trim();
        const valueContainer = row.querySelector('.sc-account-rows__row__group');

        const isProductsPrice = ['Precio del producto', 'Precio de los productos'].includes(heading);
        const isShipping = heading === 'Envíos';

        if (isProductsPrice) {
            productsTotal = getValue(valueContainer);
            console.log({ productsTotal })
        }

        if (isShipping) {
            const ship = getValue(valueContainer);

            console.log({ ship })

            if (ship < 0) return

            if (ship === 0) {
                row.querySelector('.sc-account-rows__click').click();
                shipping = getValue(row.querySelector('.sc-account-rows__row__price--container'));
                console.log({ shipping })
            }

            if (ship > 0) {
                shipping = ship;
            }

            console.log({ shipping })
        }
    });

    const sale = {
        id,
        clientName,
        clientId,
        productsTotal,
        shipping
    };

    // alert(JSON.stringify(sale, null, 4))

    Storage.save(sale)
}