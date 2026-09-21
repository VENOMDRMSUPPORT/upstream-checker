const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ASSETS_DIR = path.join(__dirname, '..', 'src', 'assets');

// Icon SVG — Professional hexagonal shield with checkmark + network nodes
const iconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0a0e1a"/>
      <stop offset="100%" stop-color="#0f1526"/>
    </linearGradient>
    <linearGradient id="shield" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00d4ff"/>
      <stop offset="50%" stop-color="#7b2ff7"/>
      <stop offset="100%" stop-color="#00d4ff"/>
    </linearGradient>
    <linearGradient id="glow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00d4ff" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#7b2ff7" stop-opacity="0.1"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="12" flood-color="#00d4ff" flood-opacity="0.3"/>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  
  <!-- Outer glow ring -->
  <circle cx="256" cy="248" r="160" fill="none" stroke="url(#shield)" stroke-width="2" opacity="0.15"/>
  
  <!-- Hexagonal shield -->
  <g filter="url(#shadow)">
    <path d="M256 100 L380 172 L380 324 L256 396 L132 324 L132 172 Z" 
          fill="none" stroke="url(#shield)" stroke-width="8" stroke-linejoin="round"/>
    <path d="M256 112 L370 178 L370 318 L256 384 L142 318 L142 178 Z" 
          fill="url(#glow)" stroke="none"/>
  </g>
  
  <!-- Network nodes -->
  <circle cx="196" cy="190" r="6" fill="#00d4ff" opacity="0.6"/>
  <circle cx="316" cy="190" r="6" fill="#7b2ff7" opacity="0.6"/>
  <circle cx="196" cy="306" r="6" fill="#7b2ff7" opacity="0.6"/>
  <circle cx="316" cy="306" r="6" fill="#00d4ff" opacity="0.6"/>
  
  <!-- Network lines -->
  <line x1="196" y1="190" x2="256" y2="248" stroke="#00d4ff" stroke-width="2" opacity="0.3"/>
  <line x1="316" y1="190" x2="256" y2="248" stroke="#7b2ff7" stroke-width="2" opacity="0.3"/>
  <line x1="196" y1="306" x2="256" y2="248" stroke="#7b2ff7" stroke-width="2" opacity="0.3"/>
  <line x1="316" y1="306" x2="256" y2="248" stroke="#00d4ff" stroke-width="2" opacity="0.3"/>
  
  <!-- Center checkmark -->
  <path d="M218 248 L244 274 L298 220" 
        fill="none" stroke="url(#shield)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Small pulse dots on check -->
  <circle cx="298" cy="220" r="4" fill="#00d4ff" opacity="0.8"/>
</svg>`;

// App icon SVG (smaller, for titlebar)
const appIconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00d4ff"/>
      <stop offset="100%" stop-color="#7b2ff7"/>
    </linearGradient>
  </defs>
  <path d="M32 6 L54 18 L54 46 L32 58 L10 46 L10 18 Z" 
        fill="none" stroke="url(#g)" stroke-width="3" stroke-linejoin="round"/>
  <path d="M32 10 L50 20 L50 44 L32 54 L14 44 L14 20 Z" 
        fill="url(#g)" fill-opacity="0.1" stroke="none"/>
  <path d="M24 32 L30 38 L42 26" 
        fill="none" stroke="url(#g)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function generateIcons() {
  // Ensure assets dir exists
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  // Generate app icon (PNG) at multiple sizes
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  
  for (const size of sizes) {
    const svg = size > 64 ? iconSVG : appIconSVG;
    const outPath = path.join(ASSETS_DIR, `icon-${size}.png`);
    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`Generated: icon-${size}.png`);
  }

  // Generate main icon PNG (512px)
  const mainIcon = path.join(ASSETS_DIR, 'icon.png');
  await sharp(Buffer.from(iconSVG))
    .resize(512, 512)
    .png()
    .toFile(mainIcon);
  console.log(`Generated: icon.png (512px)`);

  // Generate favicon
  const favicon = path.join(ASSETS_DIR, 'favicon.png');
  await sharp(Buffer.from(appIconSVG))
    .resize(32, 32)
    .png()
    .toFile(favicon);
  console.log(`Generated: favicon.png (32px)`);

  // Generate ICO file (multi-size) using sharp composite
  // Create ICO by combining multiple PNG sizes
  const icoSizes = [16, 32, 48, 256];
  const icoBuffers = [];
  
  for (const size of icoSizes) {
    const buf = await sharp(Buffer.from(iconSVG))
      .resize(size, size)
      .png()
      .toBuffer();
    icoBuffers.push({ size, buffer: buf });
  }

  // Build ICO file manually
  const ico = buildICO(icoBuffers);
  const icoPath = path.join(ASSETS_DIR, 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log(`Generated: icon.ico (${icoBuffers.length} sizes)`);

  console.log('\nAll icons generated successfully!');
}

function buildICO(images) {
  const numImages = images.length;
  
  // ICO header: 6 bytes
  // Reserved (2) + Type (2) + Count (2)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // Reserved
  header.writeUInt16LE(1, 2);      // Type: ICO
  header.writeUInt16LE(numImages, 4); // Count

  // Calculate offsets
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirTableSize = numImages * dirEntrySize;
  const dataOffset = headerSize + dirTableSize;

  let currentOffset = dataOffset;
  const dirEntries = [];
  const imageData = [];

  for (const img of images) {
    const w = img.size === 256 ? 0 : img.size; // 0 means 256
    const h = img.size === 256 ? 0 : img.size;
    
    const entry = Buffer.alloc(16);
    entry.writeUInt8(w, 0);          // Width
    entry.writeUInt8(h, 1);          // Height
    entry.writeUInt8(0, 2);          // Color palette
    entry.writeUInt8(0, 3);          // Reserved
    entry.writeUInt16LE(1, 4);       // Color planes
    entry.writeUInt16LE(32, 6);      // Bits per pixel
    entry.writeUInt32LE(img.buffer.length, 8);  // Data size
    entry.writeUInt32LE(currentOffset, 12);     // Data offset

    dirEntries.push(entry);
    imageData.push(img.buffer);
    currentOffset += img.buffer.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

generateIcons().catch(console.error);
