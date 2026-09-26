// Builds every app icon from the brand masters in src/assets/brand/.
// Small sizes use hand-hinted masters: the full mark's tongue and chamfers
// turn to noise below 64 px.
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ASSETS = path.join(__dirname, '..', 'src', 'assets');
const BRAND = path.join(ASSETS, 'brand');
const MARK_COLOR = '#00d4ff';
const TILE_COLOR = '#0b0f17';

function markPath(file) {
  const svg = fs.readFileSync(path.join(BRAND, file), 'utf8');
  const d = svg.match(/\sd="([^"]+)"/);
  if (!d) throw new Error(`No path in ${file}`);
  return d[1];
}

// The master for a given pixel size.
function masterFor(size) {
  if (size <= 16) return 'mark-16.svg';
  if (size <= 64) return 'mark-32.svg';
  return 'mark.svg';
}

function tileSVG(size) {
  const d = markPath(masterFor(size));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">
  <rect width="512" height="512" rx="112" fill="${TILE_COLOR}"/>
  <path fill="${MARK_COLOR}" fill-rule="evenodd" d="${d}"/>
</svg>`;
}

const png = (size) => sharp(Buffer.from(tileSVG(size))).resize(size, size).png().toBuffer();

// ICO container holding PNG frames; a size of 256 is written as 0.
function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.buffer.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]);
}

async function main() {
  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), await png(size));
  }
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), await png(512));
  fs.writeFileSync(path.join(ASSETS, 'favicon.png'), await png(32));
  const ico = [];
  for (const size of [16, 32, 48, 256]) ico.push({ size, buffer: await png(size) });
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildICO(ico));
  console.log('Icons generated from src/assets/brand/.');
}

main().catch((err) => { console.error(err); process.exit(1); });
