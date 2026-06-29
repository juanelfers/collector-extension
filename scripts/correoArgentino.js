function triggerChange(elem) {
    const event = new Event('change', { bubbles: true });
    elem.dispatchEvent(event);
}

const dollarPrice = 1500;
const $ = selector => document.querySelector(selector);

const getData = event => JSON.parse(event.clipboardData.getData('text'));

const normalize = str => (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// CABA llega como "Ciudad Autónoma de Buenos Aires" pero en el form de Correo es "CAPITAL FEDERAL".
const provinceAliases = {
    'ciudad autonoma de buenos aires': 'capital federal',
    'caba': 'capital federal',
};

// Selecciona la provincia matcheando por nombre (el value del option es una letra: B, C, K...)
// y dispara change: necesario para domicilio y, en sucursal, para que el form cargue las sucursales.
const selectProvince = (selectEl, provinceName) => {
    if (!selectEl) return;
    const target = provinceAliases[normalize(provinceName)] || normalize(provinceName);
    const option = Array.from(selectEl.children).find(o => normalize(o.innerText) === target);
    if (!option) return;
    selectEl.value = option.value;
    triggerChange(selectEl);
};

const fillInputs = inputs => {
    inputs.forEach(([id, value]) => {
        const input = $(`#${id}`);
        if (!input) return;
        input.value = value;
        triggerChange(input);
    });
};

const pasteShippingData = data => {
    const { customer, address, ...order } = data;
    const codArea = address.phone.slice(-10, -8);
    const phone = address.phone.slice(-8);
    const inBetween = address.between_streets ? `Entre ${address.between_streets}` : '';

    const name = `${customer.first_name} ${customer.last_name}`;
    const isBranch = order.shipping_modality === 'branch';

    // Primero el tipo de entrega: el form muestra/oculta el grupo de campos correspondiente.
    fillInputs([['tipoEntrega', isBranch ? 'sucursal' : 'domicilio']]);

    if (isBranch) {
        // Entrega en sucursal: el form usa IDs con sufijo 2 / Suc.
        // sucursalDestino2 NO se completa: se llena dinámicamente al elegir la provincia y el
        // pedido solo trae la dirección del cliente (sucursal más cercana), así que la elegís a mano.
        fillInputs([
            ['nars2', name],
            ['correoElectronico2', customer.email],
            ['codAreaPaqSuc', codArea],
            ['celularPaqSuc', phone],
        ]);
        selectProvince($('#provincia2'), address.province);
    } else {
        // Entrega a domicilio.
        fillInputs([
            ['cpCpa', address.postal_code],
            ['nars', name],
            ['correoElectronico', customer.email],
            ['codAreaPaqDom', codArea],
            ['celularPaqDom', phone],
            ['localidad', address.city],
            ['observaciones', [inBetween, order.comments].filter(Boolean).join('. ')],
            ['direCompleta', `${address.street_address} ${address.floor_apartment || ''}`],
        ]);
        selectProvince($('#provincia'), address.province);
    }
};

const pastePackageData = data => {
    $('#peso').value = 0.100;
    triggerChange($('#peso'));

    $('#valorContenido').value = data.items_total * dollarPrice;
    triggerChange($('#valorContenido'));

    $('#medidasFrecuentes').value = 54756;
    triggerChange($('#medidasFrecuentes'));
};

document.addEventListener('paste', function (event) {
    const data = getData(event);

    if ($('#eDestino').classList.contains('d-none')) {
        pastePackageData(data);
    } else {
        pasteShippingData(data);
    }
});
