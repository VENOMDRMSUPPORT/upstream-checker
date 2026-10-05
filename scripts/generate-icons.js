// Builds every brand asset the app uses from the VenomGPT brand pack, kept in
// assets-src/brand/:
//
//   emblem-<accent>.png        the emblem for dark surfaces (neon contour)
//   emblem-<accent>-light.png  the emblem for light surfaces (platinum body,
//                              jewel contour)
//   icons/icon-<n>.png         hand-hinted small sizes of the emerald emblem,
//                              sharper at 16-48 px than any downscale
//
// The pack draws the emblem by hand in each of the five accents, so the app
// ships one picture per accent and theme instead of recolouring one master.
//
// Writes:
//   src/assets/brand/emblem-*.png  the same ten, 256 px — sharp at the About
//                                  page's 68 px on a 2x screen. The stylesheet
//                                  picks one by accent and theme; the taskbar
//                                  icon (main.js) is the dark one.
//   src/assets/icon*.png, icon.ico, favicon.png  window, installer and favicon,
//                                  in the default accent (emerald).
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets-src', 'brand');
const ASSETS = path.join(ROOT, 'src', 'assets');
const OUT = path.join(ASSETS, 'brand');

// Must match ACCENTS / DEFAULT_SETTINGS.accent in src/renderer/app.js.
const ACCENTS = ['emerald', 'cyan', 'violet', 'crimson', 'amber'];
const DEFAULT_ACCENT = 'emerald';

const UI_SIZE = 256;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const resize = (file, size) => sharp(file)
  .resize(size, size, { kernel: sharp.kernel.lanczos3 })
  .png({ compressionLevel: 9 })
  .toBuffer();

// ICO container holding PNG frames; a size of 256 is written as 0.
function buildICO(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map((img) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.buffer.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.buffer.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buffer)]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const id of ACCENTS) {
    for (const suffix of ['', '-light']) {
      const name = `emblem-${id}${suffix}.png`;
      fs.writeFileSync(path.join(OUT, name), await resize(path.join(SRC, name), UI_SIZE));
    }
  }

  // The lock screen draws the cyan emblem at 176 px, so it ships its own 512 px
  // copy: the 256 px one above is already soft at that size on a 2x display, and
  // the lock screen is the first thing anyone sees. One extra file beats ten
  // bigger ones, since only this one is shown this large.
  fs.writeFileSync(path.join(OUT, 'emblem-cyan-512.png'), await resize(path.join(SRC, 'emblem-cyan.png'), 512));

  // Window, taskbar and installer icons. The pack's hinted frames where it has
  // them; 512 is the emerald emblem itself.
  const frames = {};
  for (const size of ICO_SIZES) frames[size] = fs.readFileSync(path.join(SRC, 'icons', `icon-${size}.png`));
  frames[512] = await resize(path.join(SRC, `emblem-${DEFAULT_ACCENT}.png`), 512);

  for (const size of [16, 32, 48, 64, 128, 256, 512]) {
    fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), frames[size]);
  }
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), frames[512]);
  fs.writeFileSync(path.join(ASSETS, 'favicon.png'), frames[32]);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'),
    buildICO(ICO_SIZES.map((size) => ({ size, buffer: frames[size] }))));

  console.log('Brand assets generated from assets-src/brand/.');
}

main().catch((err) => { console.error(err); process.exit(1); });
