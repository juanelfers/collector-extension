// Builds icons/*.png. No package.json here: it borrows sharp and the brand art from the
// sibling repo pokeargentum-fulldeck.
//
//   node tools/build-icons.cjs
//
// 48 and 128: the brand's vector Pikachu (pokeargentum-fulldeck/public/bimi/logo-icon.svg),
// cropped to the head, in a rounded square with an ink outline.
// 16 and 32: its line art is mush at that size, so the same face redrawn with shapes that
// survive 16 px. `icon-off-*` is the gray toolbar icon the SW shows while the marks are off.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FULLDECK = path.join(ROOT, '..', 'pokeargentum-fulldeck');
const sharp = require(path.join(FULLDECK, 'node_modules', 'sharp'));
const OUT = path.join(ROOT, 'icons');
const INK = '#090611';

const brand = fs.readFileSync(path.join(FULLDECK, 'public', 'bimi', 'logo-icon.svg'), 'utf8');
const inner = brand.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');

function brandIcon(size) {
    const stroke = size <= 48 ? 2.5 : 5;
    const inset = stroke / 2;
    const r = size * 0.22;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><clipPath id="c"><rect x="${inset}" y="${inset}" width="${size - stroke}" height="${size - stroke}" rx="${r}"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="${size}" height="${size}" fill="#EEC35A"/>
    <svg x="0" y="0" width="${size}" height="${size}" viewBox="360 190 600 600" preserveAspectRatio="xMidYMid slice">${inner}</svg>
  </g>
  <rect x="${inset}" y="${inset}" width="${size - stroke}" height="${size - stroke}" rx="${r}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>
</svg>`;
}

function smallFace({ gray = false } = {}) {
    const yellow = gray ? '#d6d6d6' : '#FFD576';
    const bg = gray ? '#bdbdbd' : '#EEC35A';
    const red = gray ? '#8a8a8a' : '#D2343F';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><clipPath id="c"><rect x="1" y="1" width="30" height="30" rx="7"/></clipPath></defs>
  <g clip-path="url(#c)">
    <rect width="32" height="32" fill="${bg}"/>
    <path d="M4.5 17 L2.5 1.5 L13 11 Z" fill="${yellow}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M2.5 1.5 L3.6 9.8 L8.2 6.6 Z" fill="${INK}"/>
    <path d="M27.5 17 L29.5 1.5 L19 11 Z" fill="${yellow}" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M29.5 1.5 L28.4 9.8 L23.8 6.6 Z" fill="${INK}"/>
    <ellipse cx="16" cy="21.5" rx="13.2" ry="11" fill="${yellow}" stroke="${INK}" stroke-width="1.8"/>
    <path d="M8.6 19.2 Q10.8 16.4 13 19.2" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round"/>
    <path d="M19 19.2 Q21.2 16.4 23.4 19.2" fill="none" stroke="${INK}" stroke-width="1.9" stroke-linecap="round"/>
    <circle cx="6.6" cy="24" r="2.9" fill="${red}"/>
    <circle cx="25.4" cy="24" r="2.9" fill="${red}"/>
    <path d="M13.2 23.2 Q16 28.4 18.8 23.2 Z" fill="${INK}"/>
  </g>
  <rect x="1" y="1" width="30" height="30" rx="7" fill="none" stroke="${INK}" stroke-width="1.6"/>
</svg>`;
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    for (const size of [48, 128]) await sharp(Buffer.from(brandIcon(size))).png().toFile(path.join(OUT, `icon-${size}.png`));
    for (const size of [16, 32]) {
        const density = (72 * size * 4) / 32; // rendered 4x and scaled down: crisper edges
        await sharp(Buffer.from(smallFace()), { density }).resize(size, size).png().toFile(path.join(OUT, `icon-${size}.png`));
        await sharp(Buffer.from(smallFace({ gray: true })), { density }).resize(size, size).png().toFile(path.join(OUT, `icon-off-${size}.png`));
    }
    console.log('icons in', OUT);
})();
