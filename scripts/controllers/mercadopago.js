const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
        .then(() => {
        })
        .catch((err) => {
            console.error('Error al copiar: ', err);
        });
};

document.getElementById(':Rad6le:').addEventListener('click', function () {
    const name = window.prompt('Nombre?');
    const link = document.getElementById(':R6d6le:').value;

    copyToClipboard([
        `Hola ${name}! Gracias por tu compra ⚡`,
        `Te dejo por acá el link de pago 🔗`,
        link    
    ].join('\n'));
});

