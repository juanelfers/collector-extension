// BringIt · "Mis compras": deja los datos de cada paquete en atributos de su <tr>.
//
// Corre en el MAIN world (ver manifest) porque el registro de cada fila sólo
// existe adentro de React: la tabla es un antd v3 y el <tr> sólo trae
// data-row-key. El content script de bringit.js vive en el mundo aislado y no
// ve las propiedades __reactInternalInstance$… de los nodos, pero sí los
// atributos: por eso este script es sólo un traductor fila → data-pa-*.
//
// El record de la fila es el mismo objeto que devuelve /api/miscompras:
// { id, sendit_id, PckStatus, despachos_id, producto, ... }.

(() => {
    const FIELDS = {
        paCc: (r) => r.id,
        paSendit: (r) => r.sendit_id,
        paStatus: (r) => r.PckStatus,
        paDespacho: (r) => (r.despachos_id > 0 ? r.despachos_id : ''),
        paProducto: (r) => r.producto || r.descripcion || '',
    };

    function recordOf(tr) {
        const key = Object.keys(tr).find((k) => k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$'));
        let fiber = key ? tr[key] : null;
        for (let depth = 0; fiber && depth < 8; depth++) {
            if (fiber.memoizedProps?.record) return fiber.memoizedProps.record;
            fiber = fiber.return;
        }
        return null;
    }

    function annotate() {
        if (!location.hash.startsWith('#/app/miscompras')) return;
        for (const tr of document.querySelectorAll('.mis_compras tr.ant-table-row')) {
            const record = recordOf(tr);
            if (!record) continue;
            for (const [attr, get] of Object.entries(FIELDS)) {
                const value = String(get(record) ?? '');
                // Sólo si cambió: el content script escucha estos atributos y
                // re-escribirlos igual lo haría redibujar en loop.
                if (tr.dataset[attr] !== value) tr.dataset[attr] = value;
            }
        }
    }

    // Microtask y no requestAnimationFrame/setTimeout: con la pestaña en segundo
    // plano rAF no corre y los timers se frenan, y "Mis compras" se abre muchas
    // veces así. El observer ya junta las mutaciones de cada render.
    let queued = false;
    const schedule = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            annotate();
        });
    };

    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('hashchange', schedule);
    schedule();
})();
