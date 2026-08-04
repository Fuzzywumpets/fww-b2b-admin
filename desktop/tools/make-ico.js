// Assemble assets/icon.ico from the per-size PNGs (PNG-in-ICO, Vista+). No deps.
'use strict';
const fs = require('fs');
const path = require('path');

const assets = path.join(__dirname, '..', 'assets');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const images = sizes.map((s) => {
  const data = fs.readFileSync(path.join(assets, `icon-${s}.png`));
  return { size: s, data };
});

const count = images.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(count, 4);

const entries = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
images.forEach((img, i) => {
  const e = entries.subarray(i * 16, i * 16 + 16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width (0 = 256)
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  e.writeUInt8(0, 2);   // color palette
  e.writeUInt8(0, 3);   // reserved
  e.writeUInt16LE(1, 4);  // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.data.length, 8);  // size of image data
  e.writeUInt32LE(offset, 12);          // offset
  offset += img.data.length;
});

const ico = Buffer.concat([header, entries, ...images.map((i) => i.data)]);
fs.writeFileSync(path.join(assets, 'icon.ico'), ico);
console.log(`wrote assets/icon.ico (${ico.length} bytes, ${count} sizes)`);
