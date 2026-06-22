const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text)
        .then(() => {
        })
        .catch((err) => {
            console.error('Error al copiar: ', err);
        });
};
