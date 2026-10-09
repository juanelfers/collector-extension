// Correo Argentino · seguimiento de e-commerce abierto con `?id=…`.
//
// El formulario público ya trae el número cargado en el input cuando la URL
// tiene `?id=` (lo pone el server), pero no consulta hasta tocar "Consultar".
// El link "Correo ↗" de BringIt (bringit.js) abre esta página: acá se toca el
// botón solo para caer directo en el historial. Sin reCAPTCHA de por medio.

(() => {
    const id = new URLSearchParams(location.search).get('id');
    const input = document.getElementById('numero');
    const boton = document.getElementById('btsubmit');
    if (!id || !input?.value || !boton) return;
    boton.click();
})();
