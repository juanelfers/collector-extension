# Collector Extension

> A Chrome extension for Pokémon TCG collectors. Import your collection once and
> the extension highlights which cards you **already own** while you browse card
> shops — so you never buy a double by accident.

![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)

## How it works

1. Reads your collection from **[Pokellector](https://www.pokellector.com/)** and
   stores it locally in the extension.
2. On every supported store, a content script compares the cards on the page
   against your collection and **marks the ones you already have**.

### Supported sites

- **Source:** Pokellector
- **Stores:** TrollAndToad, Misato Comics, Magic Lair, PokemonCard (.com.ar), tcg-premium

## Installation (load unpacked)

1. Clone this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the project folder.
4. Browse to Pokellector to sync your collection, then visit any supported store.

## Tech stack

- **Manifest V3** Chrome extension
- Vanilla **JavaScript** — background service worker + per-site content scripts
- `chrome.storage` for the local collection cache

The per-store logic is split into small controllers under
[`scripts/controllers/`](./scripts/controllers/), one file per supported site.

## License

[MIT](./LICENSE) © Juan Elfers
