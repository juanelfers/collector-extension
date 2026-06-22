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
- `scripts/controllers/mp.js` — injected on MercadoPage payment link page; on paste of JSON, types the amount character-by-character into the Andes input and fills the description.
- `scripts/controllers/mercadopago.js` — injected on MercadoPago congrats page; on click of a specific button, prompts for a name and copies a payment link message to clipboard.
- `scripts/andreani.js` — injected on Andreani shipping form; on paste of JSON order data, fills all shipping fields.
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

- `dollar` / `dollarPrice` hardcoded to `1500` in `andreani.js` and `correoArgentino.js` — update when the exchange rate changes.
- La fecha de factura ahora es **dinámica** (la manda el admin en `config.fecha`, default hoy). Punto de venta, concepto, actividad (`479101`) y descripción ("Artículos TCG") vienen en `config` con defaults. **TO-VERIFY en vivo**: el perfil de Factura A en `all.js` (`TYPE_PROFILES.A`: universo, condición IVA, alícuota 21% `IVA_21_ID`) y el `selectComprobanteType` no se pudieron probar contra el sitio real de AFIP — confirmar selectores/valores en la primera corrida.
- `triggerChange` helpers are duplicated across scripts (no shared utility) — this is intentional for content script isolation.
- `scripts/lib/storage.js` must be listed before `tcg-premium.js` and `sales.js` in `manifest.json` since those scripts depend on `window.pokeArgentumExtension.Storage`.
