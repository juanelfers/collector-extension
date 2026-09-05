// ============================================================================
// Salvavidas de sesión de ARCA
// ----------------------------------------------------------------------------
// El driver de facturación (all.js) sólo se inyecta en fe.afip.gob.ar. Cuando
// la sesión de clave fiscal se vence a mitad de un batch —y en una cola de
// cientos de facturas, que dura horas, se vence seguro— ARCA rebota la pestaña
// a auth.afip.gob.ar. Ahí el driver ni siquiera carga: no hay panel, no hay
// error, la cola queda intacta en storage y el batch muere en silencio.
//
// Este script corre en auth.afip.gob.ar y no hace nada salvo que haya una cola
// pendiente. Si la hay, muestra el cartel y el botón para volver al RCEL por el
// handoff SSO (entrar de una a /rcel/jsp/* da 403: la sesión la crea el portal).
// ============================================================================

const STORAGE_KEY = 'invoicing';
// Misma entrada que usa el admin en "Abrir ARCA".
const RCEL_SSO = 'https://auth.afip.gob.ar/contribuyente_/login.xhtml?action=SYSTEM&system=rcel';

(async function main() {
    if (!chrome.runtime?.id) return; // extensión recargada: content script huérfano

    const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
    const pending = state?.queue?.length || 0;
    if (!pending) return;

    const done = state?.results?.length || 0;
    const total = done + pending;

    const el = document.createElement('div');
    el.id = 'pa-arca-session';
    el.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
        'background:#0b0b14', 'color:#fff', 'border:1px solid #F5CE4B', 'border-radius:12px',
        'padding:14px 16px', 'width:300px', 'font:13px/1.4 system-ui,sans-serif',
        'box-shadow:0 8px 30px rgba(0,0,0,.5)',
    ].join(';');

    const btn = (bg) => `flex:1;padding:6px 8px;background:${bg};color:#fff;border:0;border-radius:8px;cursor:pointer;font:600 12px system-ui`;
    el.innerHTML = `
        <div style="font-weight:700;color:#F5CE4B;margin-bottom:6px">Facturación a medias</div>
        <div style="opacity:.85">${done}/${total} hechas · <b>${pending}</b> pendientes</div>
        <div style="margin-top:8px;opacity:.85">
            Estás fuera del comprobante en línea: si se venció la sesión, logueate
            acá y volvé, que sigue donde quedó.
        </div>
        ${state.pauseReason ? `
        <div style="margin-top:8px;padding:8px;background:#2a1414;border-radius:8px;color:#ff8a8a">
            ${state.pauseReason}
        </div>` : ''}
        <div style="margin-top:10px;display:flex;gap:8px">
            <button id="pa-sess-go" style="${btn('#1f7a3a')}">Seguir facturando</button>
            <button id="pa-sess-hide" style="${btn('#333')}">Ocultar</button>
        </div>`;
    document.documentElement.appendChild(el);

    el.querySelector('#pa-sess-go').onclick = async () => {
        const { [STORAGE_KEY]: fresh } = await chrome.storage.local.get(STORAGE_KEY);
        if (fresh) {
            fresh.active = true;
            fresh.pauseReason = null;
            // La factura en curso ya gastó intentos contra la sesión caída: sin
            // esto el watchdog de all.js la mata apenas volvemos.
            if (fresh.attempts && fresh.queue?.[0]) delete fresh.attempts[fresh.queue[0].orderId];
            await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
        }
        location.href = RCEL_SSO;
    };
    el.querySelector('#pa-sess-hide').onclick = () => el.remove();
})();
