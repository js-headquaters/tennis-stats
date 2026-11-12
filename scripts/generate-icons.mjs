// One-off, deterministic generator for the PWA icons in public/icons/.
// Uses only Node built-ins (zlib) so the app gains no image dependencies.
// Run with `npm run icons` and commit the resulting PNGs.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Colours from src/styles/tokens.css (softened lime, page background, text).
const LIME = [0xe5, 0xf2, 0x9b];
const PAPER = [0xf8, 0xf9, 0xf5];
const INK = [0x34, 0x3a, 0x34];

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 2; // 8-bit truecolour, opaque (iOS flattens alpha anyway)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A tennis ball: an ink disc with two lime seam arcs, centred on a lime (or paper) square.
 * `ballRadius` is a fraction of the icon size; the maskable variant keeps it inside the 80% safe zone.
 */
function paint(size, { ballRadius, background }) {
  const SS = 4; // supersampling per axis for anti-aliasing
  const rgb = Buffer.alloc(size * size * 3);
  const r = ballRadius, seamR = 0.86 * r, seamOffset = 1.22 * r, seamHalfWidth = 0.065 * r;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size - 0.5;
          const y = (py + (sy + 0.5) / SS) / size - 0.5;
          let colour = background;
          if (Math.hypot(x, y) <= r) {
            const left = Math.abs(Math.hypot(x + seamOffset, y) - seamR);
            const right = Math.abs(Math.hypot(x - seamOffset, y) - seamR);
            colour = Math.min(left, right) <= seamHalfWidth ? LIME : INK;
          }
          for (let i = 0; i < 3; i++) acc[i] += colour[i];
        }
      }
      for (let i = 0; i < 3; i++) rgb[(py * size + px) * 3 + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  return encodePng(size, rgb);
}

const icons = [
  ['icon-192.png', 192, { ballRadius: 0.36, background: LIME }],
  ['icon-512.png', 512, { ballRadius: 0.36, background: LIME }],
  ['icon-maskable-512.png', 512, { ballRadius: 0.28, background: LIME }],
  ['apple-touch-icon-180.png', 180, { ballRadius: 0.33, background: PAPER }],
];
mkdirSync(outDir, { recursive: true });
for (const [name, size, options] of icons) {
  writeFileSync(join(outDir, name), paint(size, options));
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
