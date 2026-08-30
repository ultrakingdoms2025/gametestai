import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('../site/node_modules/sharp');

const root = 'site/public/assets/itchio-advertising';
const out = 'site/public/assets/itchio-listing';
fs.mkdirSync(out, { recursive: true });

const logo = 'site/public/assets/aether-nexus-logo.svg';
const cover = `${root}/dragon-citadel/dragon-three-quarter.png`;
const desert = `${root}/citadel/desert-overview.png`;
const orbital = `${root}/station/dome-inside.png`;

const overlay = (width, height, markup) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${markup}</svg>`
);

await sharp(cover)
  .resize(630, 500, { fit: 'cover', position: 'centre' })
  .composite([
    { input: overlay(630, 500, '<rect width="630" height="500" fill="#070c12" fill-opacity=".14"/><rect width="630" height="145" fill="#070c12" fill-opacity=".78"/>'), left: 0, top: 0 },
    { input: await sharp(logo).resize({ width: 520 }).png().toBuffer(), left: 55, top: 16 },
  ])
  .png()
  .toFile(`${out}/cover-630x500.png`);

await sharp(desert)
  .resize(1100, 400, { fit: 'cover', position: 'centre' })
  .composite([{ input: overlay(1100, 400, '<rect width="520" height="190" x="42" y="105" fill="#070c12" fill-opacity=".82"/><text x="72" y="180" fill="#eafcff" font-family="Arial Narrow,Arial,sans-serif" font-size="42" font-weight="700" letter-spacing="7">AETHER</text><text x="72" y="236" fill="#54eaff" font-family="Arial Narrow,Arial,sans-serif" font-size="54" font-weight="700" letter-spacing="5">NEXUS</text><path d="M74 258h320" stroke="#ffb62f" stroke-width="4"/><text x="74" y="284" fill="#9bb2c2" font-family="Arial Narrow,Arial,sans-serif" font-size="12" letter-spacing="4">SEVEN WORLDS / ONE GATEWAY</text>'), left: 0, top: 0 }])
  .png()
  .toFile(`${out}/banner-1100x400.png`);

await sharp(orbital)
  .resize(1920, 1080, { fit: 'cover', position: 'centre' })
  .composite([{ input: overlay(1920, 1080, '<defs><linearGradient id="shade" x2="0" y2="1"><stop stop-color="#070c12" stop-opacity=".12"/><stop offset=".72" stop-color="#070c12" stop-opacity=".18"/><stop offset="1" stop-color="#070c12" stop-opacity=".78"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#shade)"/>'), left: 0, top: 0 }])
  .png()
  .toFile(`${out}/background-1920x1080.png`);

await sharp(desert)
  .resize(960, 540, { fit: 'cover', position: 'centre' })
  .composite([{ input: overlay(960, 540, '<rect x="28" y="28" width="305" height="112" fill="#070c12" fill-opacity=".8"/><text x="48" y="77" fill="#eafcff" font-family="Arial Narrow,Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="4">AETHER NEXUS</text><text x="48" y="111" fill="#54eaff" font-family="Arial Narrow,Arial,sans-serif" font-size="13" letter-spacing="3">ENTER THE NEXUS</text>'), left: 0, top: 0 }])
  .png()
  .toFile(`${out}/embed-background-960x540.png`);

console.log(`Created itch listing assets in ${out}`);
