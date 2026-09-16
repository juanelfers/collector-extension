// Andreani pymes — "Hacer envío → Paquetes". Se pega el JSON del pedido (el que
// copia "Copiar datos de orden" en el admin de PA) en cualquier paso del wizard y
// se completa lo que ese paso tenga en pantalla. Verificado contra el sitio real
// el 2026-09-16 con Claude in Chrome.
//
// El wizard es una SPA: la URL pasa de /hacer-envio a /hacer-envio/paquetes?paso=…
// sin recargar, así que el script se inyecta en TODO pymes.andreani.com y decide
// en el momento del paste si está dentro de "Hacer envío".
//
// Mínimos que exige el form desde 2026-09 (lo dice el mensaje de error):
//   - la suma de los tres lados no puede bajar de 35 cm (10 + 15 + 10 = 35 justo)
//   - peso mínimo 1.000 grs (el campo va en GRAMOS: "Hasta 50.000")
//   - valor declarado mínimo $30.000

const dollar = 1600; // NEXT_PUBLIC_DOLLAR_PRICE de PA
const PAQUETE = { alto: 10, ancho: 15, largo: 10, pesoGrs: 1000, valorMinimo: 30000 };

const $ = selector => document.querySelector(selector);

// Los inputs son controlados por React: asignar `.value` a mano pinta el texto
// pero el form no se entera ("Ingresá un valor" al dar Siguiente, aunque se vea
// escrito). Hay que usar el setter nativo y disparar `input`; y como React sólo
// avisa si el valor CAMBIÓ respecto de lo que él cree que hay, primero se vacía.
const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

const fill = (id, value) => {
    const input = $(`#${id}`);
    if (!input || value == null || value === '') return false;
    input.focus();
    nativeSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    nativeSetter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
};

const fillAll = pairs => pairs.filter(([id, value]) => fill(id, value)).map(([id]) => id);

// Pegar cualquier otra cosa en la página (un CP, un nombre) no es asunto nuestro.
const getData = event => {
    try {
        const data = JSON.parse(event.clipboardData.getData('text'));
        return data && typeof data === 'object' && data.customer && data.address ? data : null;
    } catch {
        return null;
    }
};

const digits = value => String(value ?? '').replace(/\D/g, '');

// ---------------------------------------------------------------------------
// Dirección: el pedido trae "Av. Corrientes 1234" en un solo campo y Andreani
// pide Calle y Número por separado. Se busca el número de puerta entre todos los
// números del texto:
//   - si alguno viene precedido por "N°" / "nro" / "#" / "altura", es ése
//   - se descartan los que son piso/dpto/timbre/torre/etc. ("dpto 5"), los de
//     "entre X y Y" y los pegados a una letra ("3B", "2°")
//   - de los que quedan gana el ÚLTIMO, así "Calle 12 345" y "Av. 9 de Julio 1234"
//     salen bien y una calle numerada (La Plata) no se confunde con la altura
// Lo que sobra después del número ("3B", "dpto 5") no se pierde: va a Indicaciones.
const NUMBER_PREFIX = /(?:^|\s)(?:n[°ºo]?\.?|nro\.?|n[uú]m(?:ero)?\.?|#|altura)\s*$/i;
const NOT_A_DOOR = /(?:^|\s)(?:piso|p\.?|dpto\.?|depto\.?|dto\.?|departamento|of\.?|oficina|local|uf|unidad|torre|casa|lote|manzana|mz\.?|km\.?|timbre|entre|e\/|y)\s*$/i;

const splitStreet = raw => {
    const text = String(raw ?? '').trim();
    const candidates = [];
    // "5.678" (con punto de miles) es un solo número.
    for (const match of text.matchAll(/\d+(?:\.\d{3})*/g)) {
        const start = match.index;
        const end = start + match[0].length;
        const before = text.slice(0, start);
        const gluedToLetter = /^[a-zA-Z°º]/.test(text.slice(end));
        if (gluedToLetter) continue;
        candidates.push({ start, end, prefixed: NUMBER_PREFIX.test(before), excluded: NOT_A_DOOR.test(before) });
    }

    const pick = candidates.find(c => c.prefixed)
        ?? [...candidates].reverse().find(c => !c.excluded);

    if (!pick) return { calle: text, numero: '', resto: '' };

    const calle = text.slice(0, pick.start).replace(NUMBER_PREFIX, '').replace(/[\s,\-]+$/, '').trim();
    const numero = text.slice(pick.start, pick.end).replace(/\./g, '');
    const resto = text.slice(pick.end).replace(/^[\s,\-]+/, '').trim();
    return { calle: calle || text, numero, resto };
};

// "3B" / "3 B" / "3° B" / "Piso 3 Dto B" / "PB" → piso + departamento.
const splitFloor = raw => {
    const text = String(raw ?? '').replace(/\b(?:piso|dpto|depto|dto|departamento|unidad)\.?\s*/gi, ' ').replace(/[°º]/g, ' ').trim();
    if (!text) return { piso: '', unidad: '' };
    const match = text.match(/^(pb|\d+)(?:er|ro|do|to|mo|vo|no)?\b\s*[\s,\-\/]*\s*(.*)$/i);
    if (!match) return { piso: '', unidad: text };
    return { piso: match[1].toUpperCase(), unidad: match[2].trim() };
};

const tickSinNumero = () => {
    const label = Array.from(document.querySelectorAll('label, span, p')).find(el => el.innerText?.trim() === 'Sin número');
    const checkbox = label?.closest('div')?.querySelector('input[type=checkbox]');
    if (checkbox && !checkbox.checked) checkbox.click();
    return Boolean(checkbox);
};

// ---------------------------------------------------------------------------
const fillPaquete = order => fillAll([
    ['input_alto', PAQUETE.alto],
    ['input_ancho', PAQUETE.ancho],
    ['input_largo', PAQUETE.largo],
    ['input_peso', PAQUETE.pesoGrs],
    ['input_valorDeclarado', Math.max(PAQUETE.valorMinimo, Math.round((Number(order.total) || 0) * dollar))],
]);

const fillDireccion = (address, order) => {
    if (!$('#input_calle')) return [];
    const { calle, numero, resto } = splitStreet(address.street_address);
    const { piso, unidad } = splitFloor(address.floor_apartment);
    const obs = [
        resto,
        address.between_streets ? `entre ${address.between_streets}` : '',
        order.comments,
    ].filter(Boolean).join(' - ');

    const filled = fillAll([
        ['input_calle', calle],
        ['input_numero', numero],
        ['input_piso', piso],
        ['input_unidad', unidad],
        ['input_observacionesAdicionales', obs],
    ]);
    if (!numero && tickSinNumero()) filled.push('sin-numero');
    return filled;
};

// DNI y teléfono sólo aceptan dígitos: "30.123.456" y "+54 9 11 1234-5678" rebotan.
const fillDestinatario = (customer, address) => fillAll([
    ['input_nombre', customer.first_name],
    ['input_apellido', customer.last_name],
    ['input_dni', digits(customer.national_id)],
    ['input_telefono', digits(address.phone)],
    ['input_email', customer.email],
]);

document.addEventListener('paste', event => {
    if (!location.pathname.startsWith('/hacer-envio')) return;
    const data = getData(event);
    if (!data) return;

    // Que el JSON no caiga adentro del input que tenga el foco.
    event.preventDefault();

    const { customer, address, ...order } = data;
    const filled = [
        ...fillPaquete(order),
        ...fillDireccion(address, order),
        ...fillDestinatario(customer, address),
    ];
    console.log('[andreani] paso', new URLSearchParams(location.search).get('paso'), '→ completado:', filled);
    if (!filled.length) console.warn('[andreani] este paso no tiene ningún campo que sepa completar');
});
