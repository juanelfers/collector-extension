function triggerChange(elem) {
    const event = new Event('change', { bubbles: true });
    elem.dispatchEvent(event);
}

const dollarPrice = 1500;
const $ = selector => document.querySelector(selector);

const getData = event => JSON.parse(event.clipboardData.getData('text'));

const pasteShippingData = data => {
    const { customer, address, ...order } = data;
    const codArea = address.phone.slice(-10, -8);
    const phone = address.phone.slice(-8);
    const inBetween = address.between_streets ? `Entre ${address.between_streets}` : '';

    const inputs = [
        ['tipoEntrega', 'domicilio'],
        ['cpCpa', address.postal_code],
        ['nars', `${customer.first_name} ${customer.last_name}`],
        ['correoElectronico', customer.email],
        ['codAreaPaqDom', codArea],
        ['celularPaqDom', phone],
        ['provincia', address.province],
        ['localidad', address.city],
        ['observaciones', inBetween || '' + order.comments || ''],
        ['direCompleta', `${address.street_address} ${address.floor_apartment || ''}`],
    ];

    inputs.forEach(([id, value]) => {
        const input = $(`#${id}`);
        console.log({ input, value })

        if (!input) return;

        input.value = value;
        triggerChange(input);
    });

    const province = address.province.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    Array.from($(`#provincia`).children).forEach(option => {
        if (option.innerText.toLowerCase() === province) {
            $(`#provincia`).value = option.value;
        }
    });
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
