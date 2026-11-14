# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A Chrome extension (Manifest V3) for PokeArgentum, a Pokémon TCG store in Argentina. It automates repetitive workflows: autofilling shipping forms, reading sale data from MercadoLibre, bridging data to tcg-premium admin, and filling ARCA (AFIP) invoice forms.

## Loading the Extension

There is no build step. Load the extension directly in Chrome:
1. Navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this directory

After any code change, click the refresh button on the extension card in `chrome://extensions`.

## Architecture

The extension has three layers:

**Service Worker** (`scripts/lib/service-worker.js`): Handles background tasks (currently: responding to `get_downloads` messages).

**Content Scripts** — each injected into specific URLs defined in `manifest.json`:
- `scripts/all.js` — injected only on `fe.afip.gob.ar`. **Motor de facturación en lote** ("Facturar todo"): toma una cola desde `chrome.storage.local` (key `invoicing`) y recorre los pasos del comprobante (RCEL) generando factura por factura, en loop, hasta vaciar la cola. Elige Factura A (CUIT) o B (DNI) por documento, usa fecha dinámica, espera a que aparezcan los elementos (no `setTimeout` a ciegas), detecta errores y muestra un panel flotante con progreso / Pausar / Cancelar.
- `scripts/lib/storage.js` + `scripts/controllers/tcg-premium.js` — injected on tcg-premium admin, pokeargentum.com, and MercadoLibre sales pages. `storage.js` exposes `window.pokeArgentumExtension.Storage` (backed by `chrome.storage.local`, key `sales`). `tcg-premium.js` listens for `window.postMessage` from the host page: `loadSales` (devuelve ventas scrapeadas), `loadInvoiceQueue` (guarda la cola de facturación en `chrome.storage.local` key `invoicing`) y `getInvoiceResults` (devuelve qué órdenes se facturaron, para que el admin las marque).
- `scripts/controllers/sales.js` — injected on MercadoLibre sale detail pages; scrapes client name/ID, product total, and shipping cost, then saves to `Storage`.
- `scripts/controllers/ml-admin-link.js` — injected on MercadoLibre item pages (`articulo.*` y `www.mercadolibre.com.ar/*`). Planta un link **"Editar en mi admin"** al lado de "Modificar" que abre `<adminBase>/admin/ml/<MLA...>`: esa ruta (repo `konekotekka`) resuelve sola si el ID es un artículo, una carta suelta o un Hot Wheels y redirige a la pantalla donde se edita. Sólo aparece en publicaciones **propias** — la marca es la barra de vendedor ("Modificar / Vender uno igual"), o estar adentro de `/publicaciones/MLA.../` (ahí va como pastilla flotante). El admin sale de `chrome.storage.local` key `adminBase` (default `https://cartas.konekotekka.com.ar`); **Shift + click** abre `localhost:3000` esta vez sola, para probar contra el dev server.
- `scripts/controllers/bringit-page.js` (**MAIN world**) + `scripts/controllers/bringit.js` — injected on `app.bringitimport.com`. En **Mis compras** le agrega a cada paquete "Enviado a Cliente" si **llegó de verdad**: `✓ Recibido dd/mm` / `En sucursal` / `En camino` / `Sin entregar` / `Sin seguimiento`, y arriba de la tabla un resumen con lo que hay que ir a retirar (sucursal + pieza). BringIt no sabe si llegó: cada paquete cuelga de un despacho (`GET api.bringitimport.com/api/bring_despachos/{id}`, Bearer = `localStorage.token` de la página) que trae el tracking del último tramo, y el SW lo consulta en Correo Argentino (`correo-tracking`: POST a `wsFacade.php` `action=ecommerce`, sin captcha; mismo cliente que `pokeargentum-fulldeck/app/api/lib/tracking/correoArgentino.js`). Correo se detecta por el **formato del número**, no por el transporte: BringIt tiene despachos "ANDREANI" con número de Correo. Lo que no es Correo se marca a mano con un click (`chrome.storage.local` `bringit:recibido:<id>`); caché en `bringit:despacho:<id>` (para siempre) y `bringit:correo:<tracking>` (entregado para siempre, lo demás 20 min). `bringit-page.js` sólo traduce el registro de React de cada `<tr>` a `data-pa-*`, porque el mundo aislado no ve las props de React. **Sin setTimeout/rAF en el camino**: con la pestaña en segundo plano Chrome los frena a uno por minuto. Ojo: el "Recibido" nativo de BringIt (menú "…") **archiva** el paquete; la extensión no lo usa. Al lado del chip va el link al seguimiento del transporte con el número cargado (`Correo ↗` = `correoargentino.com.ar/formularios/e-commerce?id=`, `Andreani ↗` = `andreani.com/envio/`); como ese formulario carga el número pero no consulta solo, `scripts/controllers/correo-seguimiento.js` toca "Consultar" al abrir con `?id=`.
- `scripts/controllers/mp.js` — injected on MercadoPage payment link page; on paste of JSON, types the amount character-by-character into the Andes input and fills the description.
- `scripts/controllers/mercadopago.js` — injected on MercadoPago congrats page; on click of a specific button, prompts for a name and copies a payment link message to clipboard.
- `scripts/andreani.js` — injected on TODO `pymes.andreani.com` (el wizard de "Hacer envío → Paquetes" es una SPA: la URL pasa de `/hacer-envio` a `/hacer-envio/paquetes?paso=…` sin recargar, y con el match viejo `/hacer-envio/*` había que recargar para que corriera). Al pegar el JSON del pedido completa lo que el paso actual tenga en pantalla: **paquete** (10×15×10 cm, 1.000 grs, valor declarado = total × dólar con piso $30.000 — los mínimos que el form exige desde 2026-09: suma de lados ≥ 35 cm, peso ≥ 1.000 grs, valor ≥ $30.000), **dirección** (parte `street_address` en Calle + Número — el número de puerta es el último número que no sea piso/dpto/timbre ni "entre X y Y", salvo que venga con "N°"/"nro"/"#" —, `floor_apartment` en Piso + Departamento, y lo que sobra + entre calles + comentarios en Indicaciones; sin número tilda "Sin número") y **destinatario** (DNI y teléfono sólo dígitos: con puntos o "+54 9" el form los rechaza). **Los inputs son controlados por React**: asignar `.value` pinta el texto pero el form lo ignora ("Ingresá un valor") — hay que usar el setter nativo de `HTMLInputElement`, vaciar primero y disparar `input`. Verificado contra el sitio real el 2026-09-16.
- `scripts/correoArgentino.js` — injected on Correo Argentino shipping form; on paste of JSON order data, fills fields differently depending on whether the destination or package section is active.

**Popup** (`pokeargentum.html` + `scripts/popup.js`): Reads `collections` from `chrome.storage.local` and displays collection name and card counts in a table.

## Data Format

Scripts that react to paste events expect JSON on the clipboard. The shared shape used by shipping scripts:
```json
{
  "customer": { "first_name", "last_name", "national_id", "email" },
  "address": { "street_address", "floor_apartment", "postal_code", "province", "city", "phone", "between_streets" },
  "comments": "",
  "total": 0,
  "items_total": 0
}
```

La facturación en lote vive en `chrome.storage.local` key `invoicing`: `{ active, mode: 'auto'|'confirm', config, queue: [{ orderId, clientId, total, name }], results: [{ orderId, status, detail }], attempts }`. `queue[0]` es la factura en curso (se saca al generarse o fallar). El admin de PokeArgentum la llena vía `loadInvoiceQueue`.

## Key Notes

- `dollar` (1600, el `NEXT_PUBLIC_DOLLAR_PRICE` de PA) en `andreani.js` y `dollarPrice` (1500) en `correoArgentino.js` están hardcodeados — update when the exchange rate changes.
- La fecha de factura ahora es **dinámica** (la manda el admin en `config.fecha`, default hoy). Punto de venta, concepto, actividad (`479101`) y descripción ("Artículos TCG") vienen en `config` con defaults. **TO-VERIFY en vivo**: el perfil de Factura A en `all.js` (`TYPE_PROFILES.A`: universo, condición IVA, alícuota 21% `IVA_21_ID`) y el `selectComprobanteType` no se pudieron probar contra el sitio real de AFIP — confirmar selectores/valores en la primera corrida.
- `triggerChange` helpers are duplicated across scripts (no shared utility) — this is intentional for content script isolation.
- `scripts/lib/storage.js` must be listed before `tcg-premium.js` and `sales.js` in `manifest.json` since those scripts depend on `window.pokeArgentumExtension.Storage`.

## Marcas en tiendas de compra (shop marks)

Marca cada carta suelta en las tiendas donde Juan compra (las 8 de `USA_STORES` de konekotekka más TCGplayer): si ya la tiene, cuántas, a cuánto la vende, cuánto vendió, y el market de TCGplayer que muestra `/admin/compras`.

- `scripts/lib/shop-core.js`: lógica pura, sin DOM ni chrome (`globalThis.PAShopCore`). La cargan el content script, el SW, el popup y los tests. `productKeyFromHref` da la identidad de un link y `deriveMark` decide la marca.
- `scripts/lib/shop-data.js`: lado SW, cargado con `importScripts` desde `service-worker.js` adentro de un `try` para que un error acá no tumbe ARCA. Tiene su propio listener y sólo atiende `shop-lookup`, `shop-status`, `shop-refresh` y `shop-settings-changed`.
- `scripts/controllers/shop-marks.js` + `shop-marks.css`: content script.
- Datos: `GET` y `POST` a `<adminBase>/api/admin/compras/extension/{snapshot,lookup}` con la cookie de sesión del admin. Sin tokens en la extensión.

`chrome.storage.local`: `shop:settings` (`enabled`, `variant` a/b/c, `dimOwned`, `panelCollapsed`: sin elegir no existe, y el panel arranca plegado con menos de 1000 px de ancho, porque abierto tapa "Add to cart"; lo que elige Juan gana), `shop:snapshot` (stock y ventas propias, unos 3 MB; vencido a los 15 min se contesta igual y se refresca atrás), `shop:snapshotFailedAt` (el límite de 30 s después de un snapshot fallido, para que no se reinicie con el SW; un refresh que contesta lo borra, y una fecha en el futuro también se borra sin frenar nada, porque el reloj volvió atrás y esa fecha no dice nada), `shop:status`, `shop:cacheBase` (de qué `adminBase` vienen los cachés: si cambia se tiran, para que lo de un dev server no sobreviva), `shop:lookup:<store>:<key>` (identidad y market: 24 h si resolvió, 6 h si no; guarda con qué se preguntó, y un unknown sólo se vuelve a preguntar por un `productId`, `setName` o `title` que todavía no probó). "Actualizar ahora" también borra los `shop:lookup:*`, y un lookup que ya estaba en camino no escribe su respuesta vieja (`lookupEpoch`); un refresh del snapshot en camino sí sigue valiendo (`cacheEpoch`, que sólo sube al cambiar de admin).

**Nada escucha `chrome.storage.onChanged`**: ese evento le entrega a cada listener el valor viejo y el nuevo de cada escritura de toda la extensión, PDFs de ARCA incluidos. El SW avisa a las pestañas de las tiendas con `chrome.tabs.sendMessage(tabId, { type: 'shop:changed', what: 'snapshot' | 'settings' })`, y el popup le pide ese aviso con `shop-settings-changed`.

Reglas que no hay que romper: `own` ausente es "no sé", **nunca** "no la tenés" (estado `loading`). `own` de más de 48 h o sin fecha cuenta como ausente, y `status.ownTooOld` se lo dice a la página; las 48 h corren desde `ownAt` del snapshot (cuándo contestó PA de verdad, porque KT puede servir su última copia), nunca más tarde que ahora. Un set sin mapear (`mapped: false`) dice "Set sin mapear" por lo mismo, y sin mapa (`mapped: null`) "No figura en tu stock" con badge `?`. También da `mapped: null` un producto en `unsettled` del snapshot, los que una línea de stock sin producto podría ser: con filas se lee "Tenés N", sin filas no se puede afirmar "No la tenés". `unsettled` viaja con `own`: si `own` no vino, queda la lista de la copia que queda. Si la publicación nombra una impresión que el catálogo no tiene (`result.printing` sin fila y sin `here`): `printingMissing`, sin market, tendencia ni "más barata" porque serían de otra impresión, y el detalle dice "TCGplayer no lista la versión Normal"; el stock se lee igual. Copias sólo en español se leen "1 ES", no "Tenés 1", porque `es.*` comparte product_id con la inglesa. Si la publicación es de una impresión de la que no hay stock y de la otra sí: `otherPrintingOnly`, "Tenés 1 normal, 0 rev", no se apaga, y `reorderNote` si esa impresión era para reponer. Las ventas son sólo web: ML no deja fila en `Sales`. El SW puede morir en cualquier momento: nada importante vive sólo en una variable de módulo y no se persiste ningún "refrescando".

Tests: desde la raíz del repo, `node --test tests/shop-core.test.mjs`. Alcanza con Node: no hay `package.json` ni nada que instalar. Con `chrome` y `fetch` falsos y un reloj virtual, corre el SW de verdad en un contexto `vm`, así que no sale a la red ni abre un navegador.

### Prueba en vivo

Los tests no abren una tienda. Para ver las marcas en una hay que armar un harness que no vive en este repo. Necesita:

- **Chrome for Testing**, no el Chrome de Juan: está en `~/.cache/puppeteer/chrome/`. Con `--load-extension=<este repo>`, `--disable-extensions-except=<este repo>`, `--remote-debugging-port=<puerto>` y `--user-data-dir=<perfil temporal>`, y se maneja por CDP. Para cargar un cambio de la extensión se cierra ese Chrome por PID y se abre con el mismo perfil; nunca `chrome.runtime.reload`, que descarga para siempre una extensión de `--load-extension`.
- **Un backend en `localhost:3000`**, que ya está en `host_permissions`. Con el puerto libre, un script copiado a la raíz de konekotekka y corrido desde ahí con `node --env-file=.env.local --import ./scripts/lib/alias.mjs <script>.mjs`. Contesta los dos endpoints: `lookup` con el `lookupItems` real de `lib/compras/extensionLookup.mjs` sobre Supabase de producción, sólo lectura, y `snapshot` con un JSON guardado, que sale de `scripts/compras/extensionLookupCheck.mjs --snapshot <archivo>`. No se llama a la ruta real del snapshot porque `getMetaCards` escribe. Para los casos de error tiene que poder contestar 403, demorarse y mandar `own: null` a pedido.
- **`adminBase`** en `http://localhost:3000`, escrito en `chrome.storage.local` desde el SW por CDP.

Al terminar: `taskkill /F /T /PID <pid>` del Chrome y del server, **nunca por nombre** (el watcher de etiquetas es un node.exe), y borrar el perfil temporal y la copia del script en konekotekka.
