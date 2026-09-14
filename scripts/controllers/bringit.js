// BringIt · "Mis compras": ¿el paquete llegó de verdad?
//
// En BringIt "Enviado a Cliente" sólo quiere decir que el paquete salió del
// depósito de Argentina. Si llegó, si quedó esperando en una sucursal o si se
// perdió en el camino, BringIt no lo sabe. Este script le agrega a cada fila
// un estado de llegada abajo del estado de BringIt, y arriba de la tabla un
// resumen con lo que hay que ir a buscar:
//
//   ✓ Recibido 31/08   → Correo lo entregó (o lo marcaste a mano)
//   En sucursal        → intento de entrega / espera en sucursal: hay que ir a retirarlo
//   En camino          → Correo lo tiene en movimiento
//   Sin entregar       → devolución / no entregado
//   Sin seguimiento    → otro transporte (Andreani, moto) o Correo no respondió
//
// De dónde sale: cada paquete enviado cuelga de un DESPACHO (una caja que sale
// de BringIt con uno o más paquetes) y el despacho trae el transporte y su
// número de seguimiento (`GET /api/bring_despachos/{id}`, lo mismo que muestra
// "Datos del Envío"). Si es Correo Argentino, el service worker pregunta el
// estado al formulario público de e-commerce (ver `correo-tracking` en
// service-worker.js). Lo que no es Correo se marca a mano con un click.
//
// Ojo con el "Recibido" nativo de BringIt (menú "…" de la fila): además de
// confirmar la recepción ARCHIVA el paquete y lo saca de esta lista. Este
// script no lo toca; lo que se marca a mano queda en chrome.storage.local.
//
// Los datos de cada fila (id, despacho, estado) los deja en data-pa-* el
// script hermano bringit-page.js, que corre en el MAIN world.

const API = 'https://api.bringitimport.com/api';
const ROOT_SELECTOR = '.mis_compras';
const ROW_SELECTOR = `${ROOT_SELECTOR} tr.ant-table-row`;
const BADGE_CLASS = 'pa-llegada';
const SUMMARY_ID = 'pa-llegada-resumen';

const ENVIADO = 'Enviado a Cliente';
const RECIBIDO_BRINGIT = 'Recibido por Cliente';

// Cuánto vale lo guardado antes de volver a preguntar.
const DESPACHO_SIN_TRACKING_TTL = 30 * 60 * 1000; // recién despachado: el tracking a veces se carga después
const CORREO_TTL = 20 * 60 * 1000; // en camino / en sucursal: cambia en el día
const ERROR_TTL = 5 * 60 * 1000;
const REFRESH_MS = 5 * 60 * 1000;

const storageKey = {
    despacho: (id) => `bringit:despacho:${id}`,
    correo: (tracking) => `bringit:correo:${tracking}`,
    recibido: (ccId) => `bringit:recibido:${ccId}`,
};

const STYLES = {
    recibido: { background: '#237804', color: '#fff', border: '#237804' },
    sucursal: { background: '#d46b08', color: '#fff', border: '#d46b08' },
    camino: { background: '#e6f7ff', color: '#096dd9', border: '#91d5ff' },
    fallido: { background: '#fff1f0', color: '#cf1322', border: '#ffa39e' },
    desconocido: { background: '#fafafa', color: '#595959', border: '#d9d9d9' },
    cargando: { background: '#fafafa', color: '#8c8c8c', border: '#e8e8e8' },
};

// ─── datos ────────────────────────────────────────────────────────────────

// Cada despacho y cada tracking se piden una sola vez por ventana de validez,
// aunque la tabla se redibuje veinte veces. La entrada deja el resultado a la
// vista (`done` / `value`) para pintar sin esperar: NADA en este script espera
// con setTimeout, porque con la pestaña en segundo plano Chrome los frena hasta
// uno por minuto y la tabla tardaba minutos en completarse.
const memo = {
    despachos: new Map(), // id → entry<{ courier, tracking, fecha, savedAt } | { error, savedAt }>
    correo: new Map(), // tracking → entry<estado de Correo>
    recibidos: new Map(), // ccId → 'AAAA-MM-DD' | null
};

function remember(map, key, load) {
    let entry = map.get(key);
    if (!entry) {
        entry = { done: false, value: undefined };
        entry.promise = load().then((value) => {
            entry.done = true;
            entry.value = value;
            return value;
        });
        map.set(key, entry);
    }
    return entry;
}

const alive = () => Boolean(chrome.runtime?.id);

async function storageGet(key) {
    if (!alive()) return undefined;
    return (await chrome.storage.local.get(key))[key];
}

async function storageSet(key, value) {
    if (!alive()) return;
    if (value == null) await chrome.storage.local.remove(key);
    else await chrome.storage.local.set({ [key]: value });
}

async function bringitGet(path) {
    const token = localStorage.getItem('token');
    if (!token) throw new Error('sin sesión de BringIt');
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.status !== 'success') throw new Error(json?.message || `HTTP ${res.status}`);
    return json.data;
}

/** Transporte y tracking del despacho. El tracking no cambia: una vez cargado se guarda para siempre. */
function getDespacho(id) {
    return remember(memo.despachos, id, async () => {
        const saved = await storageGet(storageKey.despacho(id));
        if (saved && (saved.tracking || Date.now() - saved.savedAt < DESPACHO_SIN_TRACKING_TTL)) return saved;

        try {
            const d = (await bringitGet(`/bring_despachos/${id}?tipo=1`))?.despacho;
            if (!d) throw new Error('despacho vacío');
            const despacho = {
                courier: String(d.correo?.correo || '').trim(),
                tracking: String(d.tracking || '').trim(),
                fecha: String(d.fecha || '').slice(0, 10),
                savedAt: Date.now(),
            };
            await storageSet(storageKey.despacho(id), despacho);
            return despacho;
        } catch (e) {
            console.warn('[BringIt] despacho', id, e.message);
            return saved || { error: e.message, savedAt: Date.now() };
        }
    });
}

// Se decide por el NÚMERO, no por el transporte que figura: BringIt tiene
// despachos cargados como "ANDREANI" con número de Correo (21988/21989, mayo
// 2026) y Correo los da entregados. Formatos: e-commerce de 23 caracteres
// (los de BringIt empiezan con 000109923) y el clásico HC123456789AR.
// Andreani son 15 dígitos o directamente una URL: no matchean.
const isCorreoArgentino = (despacho) => /^(?:\d{9}[A-Z0-9]{14}|[A-Z]{2}\d{9}[A-Z]{2})$/i.test(despacho?.tracking || '');

let correoQueue = Promise.resolve();

/** Estado de Correo para un tracking. Entregado no vence; lo demás se re-pregunta pasado el TTL. */
function getCorreo(tracking) {
    return remember(memo.correo, tracking, async () => {
        const saved = await storageGet(storageKey.correo(tracking));
        if (saved) {
            const age = Date.now() - saved.checkedAt;
            if (saved.status === 'delivered') return saved;
            if (saved.ok && !saved.lastError && age < CORREO_TTL) return saved;
            if ((!saved.ok || saved.lastError) && age < ERROR_TTL) return saved;
        }

        // De a una consulta por vez: Correo está detrás de un WAF y 15 juntas llaman la atención.
        const turn = correoQueue.then(() =>
            alive()
                ? chrome.runtime.sendMessage({ type: 'correo-tracking', tracking }).catch((e) => ({ ok: false, error: e.message }))
                : null,
        );
        correoQueue = turn.catch(() => null);

        const result = (await turn) || { ok: false, error: 'extensión recargada' };
        // Un error no pisa un estado bueno: lo conserva y deja constancia del intento.
        const next = result.ok
            ? { ...result, checkedAt: Date.now() }
            : saved?.ok
                ? { ...saved, lastError: result.error, checkedAt: Date.now() }
                : { ...result, checkedAt: Date.now() };
        await storageSet(storageKey.correo(tracking), next);
        return next;
    });
}

async function getRecibido(ccId) {
    if (memo.recibidos.has(ccId)) return memo.recibidos.get(ccId);
    const value = (await storageGet(storageKey.recibido(ccId))) || null;
    memo.recibidos.set(ccId, value);
    return value;
}

async function setRecibido(ccId, value) {
    memo.recibidos.set(ccId, value);
    await storageSet(storageKey.recibido(ccId), value);
}

// ─── estado de llegada ────────────────────────────────────────────────────

const ddmm = (s) => {
    const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}` : '';
};

const MARCAR = 'Click para marcarlo como recibido.';

/**
 * Qué mostrar para una fila. Precedencia: BringIt ya lo tiene como recibido →
 * lo marcaste a mano → lo que diga Correo → sin datos.
 */
function llegadaDe({ status, recibido, despachoId, despacho, correo }) {
    if (status === RECIBIDO_BRINGIT) {
        return { kind: 'recibido', label: '✓ Recibido', title: 'Confirmado como recibido en BringIt' };
    }

    if (recibido) {
        return {
            kind: 'recibido',
            label: `✓ Recibido ${ddmm(recibido)}`,
            title: `Lo marcaste como recibido el ${ddmm(recibido)}. Click para desmarcar.`,
            manual: true,
        };
    }

    if (!despachoId) {
        return { kind: 'desconocido', label: 'Sin seguimiento', title: `BringIt no le asignó despacho.\n${MARCAR}`, canMark: true };
    }

    if (!despacho) return { kind: 'cargando', label: 'Consultando…', title: 'Buscando el despacho en BringIt' };

    if (despacho.error) {
        return {
            kind: 'desconocido',
            label: 'Sin seguimiento',
            title: `BringIt no devolvió el despacho (${despacho.error}).\n${MARCAR}`,
            canMark: true,
        };
    }

    const via = [
        [despacho.courier || 'Transporte desconocido', despacho.tracking].filter(Boolean).join(' · '),
        despacho.fecha && `Despachado el ${ddmm(despacho.fecha)}`,
    ].filter(Boolean).join('\n');

    if (!isCorreoArgentino(despacho)) {
        return {
            kind: 'desconocido',
            label: 'Sin seguimiento',
            title: `${via}\nNo se puede consultar solo. ${MARCAR}`,
            link: /^https?:\/\//.test(despacho.tracking) ? despacho.tracking : null,
            canMark: true,
        };
    }

    if (!correo) return { kind: 'cargando', label: 'Consultando…', title: `Preguntando a Correo Argentino\n${via}` };

    if (!correo.ok) {
        return {
            kind: 'desconocido',
            label: 'Sin datos de Correo',
            title: `Correo no respondió (${correo.error || 'error'}).\n${via}\n${MARCAR}`,
            canMark: true,
        };
    }

    const detalle = [
        `Correo Argentino: ${correo.rawStatus || correo.status}`,
        correo.planta && `Planta: ${correo.planta}`,
        correo.fecha && `Último movimiento: ${correo.fecha}`,
        correo.piece && `Pieza: ${correo.piece}`,
        via,
        despacho.courier && !/correo/i.test(despacho.courier) && `(BringIt lo figura como ${despacho.courier}, pero el número es de Correo)`,
        correo.lastError && `(última consulta falló: ${correo.lastError})`,
    ].filter(Boolean).join('\n');

    switch (correo.status) {
        case 'delivered':
            return { kind: 'recibido', label: `✓ Recibido ${ddmm(correo.deliveredAt)}`, title: detalle };
        case 'at_branch':
            return { kind: 'sucursal', label: 'En sucursal', title: `${detalle}\n\nHay que ir a retirarlo. ${MARCAR}`, canMark: true };
        case 'failed':
            return { kind: 'fallido', label: 'Sin entregar', title: `${detalle}\n\n${MARCAR}`, canMark: true };
        default:
            return { kind: 'camino', label: 'En camino', title: `${detalle}\n\n${MARCAR}`, canMark: true };
    }
}

// ─── dibujo ───────────────────────────────────────────────────────────────

function estadoColumnIndex(root) {
    const heads = [...root.querySelectorAll('.ant-table-thead th')];
    const i = heads.findIndex((th) => th.textContent.trim() === 'Estado');
    return i >= 0 ? i : 4;
}

function badgeFor(tr, estadoIndex) {
    const td = tr.children[estadoIndex];
    if (!td) return null;
    let badge = td.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
        badge = document.createElement('div');
        badge.className = BADGE_CLASS;
        badge.style.marginTop = '4px';
        badge.addEventListener('click', onBadgeClick);
        td.append(badge);
    }
    return badge;
}

function paint(badge, tr, llegada) {
    const key = [tr.dataset.paCc, llegada.kind, llegada.label, llegada.title, llegada.link].join('|');
    if (badge.dataset.key === key) return;

    Object.assign(badge.dataset, {
        key,
        cc: tr.dataset.paCc,
        sendit: tr.dataset.paSendit || '',
        manual: llegada.manual ? '1' : '',
        canMark: llegada.canMark ? '1' : '',
    });
    badge.title = llegada.title;
    badge.replaceChildren();

    const style = STYLES[llegada.kind];
    const chip = document.createElement('span');
    chip.textContent = llegada.label;
    Object.assign(chip.style, {
        display: 'inline-block',
        padding: '0 7px',
        lineHeight: '20px',
        fontSize: '12px',
        fontWeight: llegada.kind === 'recibido' || llegada.kind === 'sucursal' ? '600' : '400',
        borderRadius: '4px',
        border: `1px solid ${style.border}`,
        background: style.background,
        color: style.color,
        cursor: llegada.manual || llegada.canMark ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
    });
    badge.append(chip);

    // Andreani trae el link de seguimiento en vez del número.
    if (llegada.link) {
        const a = document.createElement('a');
        a.href = llegada.link;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'seguir ↗';
        Object.assign(a.style, { marginLeft: '6px', fontSize: '12px' });
        badge.append(a);
    }
}

async function onBadgeClick(e) {
    if (e.target.closest('a')) return;
    const { cc, sendit, manual, canMark } = e.currentTarget.dataset;
    if (!cc || (!manual && !canMark)) return;
    e.stopPropagation();

    const quien = sendit || cc;
    if (manual) {
        if (!confirm(`¿Desmarcar ${quien} como recibido?`)) return;
        await setRecibido(cc, null);
    } else {
        if (!confirm(`¿Marcar ${quien} como recibido?`)) return;
        await setRecibido(cc, new Date().toLocaleDateString('sv-SE')); // AAAA-MM-DD en hora local
    }
    schedule();
}

const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function paintSummary(root, rows) {
    const enviados = rows.filter((r) => r.status === ENVIADO && r.llegada);
    const wrapper = root.querySelector('.ant-table-wrapper');
    let summary = document.getElementById(SUMMARY_ID);

    if (!enviados.length || !wrapper) {
        summary?.remove();
        return;
    }

    if (!summary) {
        summary = document.createElement('div');
        summary.id = SUMMARY_ID;
        Object.assign(summary.style, {
            margin: '0 0 12px',
            padding: '10px 14px',
            borderRadius: '6px',
            border: '1px solid #e8e8e8',
            background: '#fff',
            fontSize: '13px',
            lineHeight: '1.7',
            color: '#262626',
        });
    }
    if (summary.nextElementSibling !== wrapper) wrapper.before(summary);

    const de = (kind) => enviados.filter((r) => r.llegada.kind === kind);
    const [recibidos, sucursal, camino, fallidos, sinDatos, cargando] = ['recibido', 'sucursal', 'camino', 'fallido', 'desconocido', 'cargando'].map(de);

    const partes = [`<b>${enviados.length}</b> enviados a vos en esta página`, `<b style="color:#237804">${recibidos.length}</b> recibidos`];
    if (sucursal.length) partes.push(`<b style="color:#d46b08">${sucursal.length}</b> esperando en sucursal`);
    if (camino.length) partes.push(`<b style="color:#096dd9">${camino.length}</b> en camino`);
    if (fallidos.length) partes.push(`<b style="color:#cf1322">${fallidos.length}</b> sin entregar`);
    if (sinDatos.length) partes.push(`<b>${sinDatos.length}</b> sin seguimiento`);
    if (cargando.length) partes.push(`${cargando.length} consultando…`);

    const lista = (list, color) =>
        list.map((r) => `<b style="color:${color}">${escapeHtml(r.sendit)}</b> ${escapeHtml(r.producto)}`).join(' · ');

    let html = `📦 ${partes.join(' · ')}`;
    if (!sucursal.length && !camino.length && !fallidos.length && !sinDatos.length && !cargando.length) html += ' · todo llegó ✓';

    if (sucursal.length) {
        const plantas = [...new Set(sucursal.map((r) => r.correo?.planta).filter(Boolean))];
        const piezas = [...new Set(sucursal.map((r) => r.correo?.piece).filter(Boolean))];
        const donde = plantas.length ? ` en ${escapeHtml(plantas.join(', '))}` : '';
        const pieza = piezas.length ? ` — pieza ${escapeHtml(piezas.join(', '))}` : '';
        html += `<br><b style="color:#d46b08">Para retirar${donde}</b>${pieza}: ${lista(sucursal, '#d46b08')}`;
    }
    if (fallidos.length) html += `<br><b style="color:#cf1322">Sin entregar</b>: ${lista(fallidos, '#cf1322')}`;

    if (summary.dataset.html !== html) {
        summary.dataset.html = html;
        summary.innerHTML = html;
    }
}

// ─── loop ─────────────────────────────────────────────────────────────────

async function rowState(tr, estadoIndex) {
    const status = tr.dataset.paStatus;
    const row = { status, cc: tr.dataset.paCc, sendit: tr.dataset.paSendit, producto: tr.dataset.paProducto };

    if (status !== ENVIADO && status !== RECIBIDO_BRINGIT) {
        tr.querySelector(`.${BADGE_CLASS}`)?.remove();
        return row;
    }

    const recibido = await getRecibido(row.cc);
    const despachoId = tr.dataset.paDespacho;
    let despacho = null;
    let correo = null;

    // Se pinta lo que ya se sabe; lo que falte, cuando llegue, dispara otro sync.
    if (status === ENVIADO && !recibido && despachoId) {
        const despachoEntry = getDespacho(despachoId);
        if (!despachoEntry.done) {
            despachoEntry.promise.then(schedule);
        } else {
            despacho = despachoEntry.value;
            if (isCorreoArgentino(despacho)) {
                const correoEntry = getCorreo(despacho.tracking);
                if (correoEntry.done) correo = correoEntry.value;
                else correoEntry.promise.then(schedule);
            }
        }
    }

    row.correo = correo;
    row.llegada = llegadaDe({ status, recibido, despachoId, despacho, correo });
    const badge = badgeFor(tr, estadoIndex);
    if (badge) paint(badge, tr, row.llegada);
    return row;
}

async function sync() {
    if (!alive()) return;
    const root = document.querySelector(ROOT_SELECTOR);
    if (!location.hash.startsWith('#/app/miscompras') || !root) {
        document.getElementById(SUMMARY_ID)?.remove();
        return;
    }

    const estadoIndex = estadoColumnIndex(root);
    const trs = [...document.querySelectorAll(ROW_SELECTOR)].filter((tr) => tr.dataset.paCc);
    const rows = await Promise.all(trs.map((tr) => rowState(tr, estadoIndex)));
    paintSummary(root, rows);
}

// Un sync por vez; lo que pida otro mientras corre se junta en una sola vuelta más.
let running = false;
let dirty = false;
function schedule() {
    if (running) {
        dirty = true;
        return;
    }
    running = true;
    queueMicrotask(async () => {
        try {
            do {
                dirty = false;
                await sync();
            } while (dirty);
        } catch (e) {
            console.warn('[BringIt] sync', e);
        } finally {
            running = false;
        }
    });
}

// Los data-pa-* los escribe bringit-page.js cada vez que React dibuja una fila nueva.
new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-pa-cc', 'data-pa-status', 'data-pa-despacho'],
});
window.addEventListener('hashchange', schedule);

// Con la pestaña abierta, "en sucursal" / "en camino" cambian: soltar lo vencido y volver a preguntar.
setInterval(() => {
    for (const [tracking, { done, value: c }] of memo.correo) {
        if (done && c.status !== 'delivered' && Date.now() - c.checkedAt > (c.ok && !c.lastError ? CORREO_TTL : ERROR_TTL)) {
            memo.correo.delete(tracking);
        }
    }
    for (const [id, { done, value: d }] of memo.despachos) {
        if (done && (d.error || !d.tracking)) memo.despachos.delete(id);
    }
    schedule();
}, REFRESH_MS);

schedule();
