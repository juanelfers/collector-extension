const typeAmount = amount => new Promise((resolve) => {
    const input = document.querySelector('.andes-amount-field__input');

    if (input) {
        input.value = '';
        input.focus();

        [...amount].forEach((char, index, arr) => {
            setTimeout(() => {
                input.value += char;

                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                if (arr.length - 1 === index) {
                    resolve();
                }
            }, index * 100);
        });
    }
});

document.addEventListener('paste', async function (event) {
    const data = JSON.parse(event.clipboardData.getData('text'));
    await typeAmount(data.amount.toString());
    const input = document.querySelector('.andes-form-control__field');
    input.value = data.text;
    input.dispatchEvent(new Event('change', { bubbles: true }));
});