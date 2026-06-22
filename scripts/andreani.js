const dollar = 1500;

console.log({ dollar })

function triggerChange(elem) {
    const events = ['change', 'blur'];

    events.forEach(event => {
        elem.dispatchEvent(new Event(event, { bubbles: true }));
    });
}

document.addEventListener('paste', function (event) {
    const { customer, address, ...order } = JSON.parse(event.clipboardData.getData('text'));
    console.log('Paste')
    const obs = [(address.between_streets ? 'entre ' + address.between_streets : ''), order.comments].filter(Boolean).join(' - ')
    const inputs = [
        ['input_alto', 3],
        ['input_ancho', 15],
        ['input_largo', 10],
        ['input_peso', 100],
        ['input_valorDeclarado', order.total * dollar],
        // [':r6:', address.postal_code],
        ['input_calle', address.street_address],
        ['input_numero', address.street_address.match(/\d+/g)?.join(' ')],
        ['input_piso', address.floor_apartment],
        ['input_unidad', address.floor_apartment],
        ['input_observacionesAdicionales', obs],
        // ['', ],
        ['input_nombre', customer.first_name],
        ['input_apellido', customer.last_name],
        ['input_dni', customer.national_id],
        ['input_telefono', address.phone],
        ['input_email', customer.email],
        // ['', ],
    ];
    inputs.forEach(([id, value]) => {
        const input = document.querySelector(`#${id}`);
        if (input) {
            input.value = value;
            triggerChange(input);
        }
    });

    // hacer un trigger change de cp o provincia
});

/*
Somos PokeArgentum Fulldeck!
-----------------------------------------------
*/

