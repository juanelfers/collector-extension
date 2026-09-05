function triggerChange(elem) {
    const event = new Event('change', { bubbles: true });
    elem.dispatchEvent(event);
}

const dollarPrice = 1500;
const $ = selector => document.querySelector(selector);

// Pegar cualquier otra cosa en esta página (un texto, una dirección suelta) no es
// asunto de este script: devuelve null y el listener se hace a un lado.
const getData = event => {
    try {
        return JSON.parse(event.clipboardData.getData('text'));
    } catch {
        return null;
    }
};

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

// El teléfono llega entero y a veces con formato ("+54 9 11 1234-5678"); el form lo
// pide partido en código de área y número. Si el pedido no lo trae (o viene corto),
// se completa todo lo demás y el teléfono se carga a mano: mejor eso que reventar.
const splitPhone = raw => {
    const digits = String(raw ?? '').replace(/\D/g, '');
    return digits.length < 10 ? ['', ''] : [digits.slice(-10, -8), digits.slice(-8)];
};

const pasteShippingData = data => {
    const { customer, address, ...order } = data;

    // Un pedido sin dirección (retiro, venta cargada a mano, venta vieja sin backup
    // del checkout) llega como JSON válido igual. No hay nada que completar acá.
    if (!customer || !address) {
        console.warn('[correo] el JSON pegado no trae customer/address: no se completa nada', data);
        return;
    }

    const [codArea, phone] = splitPhone(address.phone);
    const inBetween = address.between_streets ? `Entre ${address.between_streets}` : '';

    const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
    const isBranch = order.shipping_modality === 'branch';

    console.log('[correo] v2 — shipping_modality:', order.shipping_modality, '→', isBranch ? 'SUCURSAL' : 'DOMICILIO');

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
    if (!data || typeof data !== 'object') return;

    // El paso de destino oculto significa que estamos en el de paquete.
    const destino = $('#eDestino');
    if (!destino) return;

    if (destino.classList.contains('d-none')) {
        pastePackageData(data);
    } else {
        pasteShippingData(data);
    }
});
