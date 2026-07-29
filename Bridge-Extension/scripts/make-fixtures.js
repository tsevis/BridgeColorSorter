#!/usr/bin/env node
/**
 * Build a disposable folder of small PNGs for scale testing.
 *
 *   node scripts/make-fixtures.js [dir] [count]
 *   node scripts/make-fixtures.js ~/Desktop/BridgeColorSorter-Scale 400
 *
 * A dozen fixtures verify correctness; only a few hundred verify behaviour.
 * Every serious fault in this project - the Bridge crash, the sort quality
 * problems, the selection that reported success while doing nothing - appeared
 * only at scale.
 *
 * Point Bridge at the generated folder to time analysis, XMP writing, renaming
 * and undo. NEVER benchmark those against real work: they rewrite files.
 * Each image is two colour bands with a randomised hue, split and value, so
 * the palettes are non-trivial and the hues spread evenly round the wheel.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = process.argv[2] || '/Users/tsevis/Desktop/BridgeColorSorter-Scale';
const COUNT = Number(process.argv[3] || 400);
const SIZE = 96;

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(pixels, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const p = pixels[y * w + x];
      raw[o++] = p[0]; raw[o++] = p[1]; raw[o++] = p[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r;
  if (h < 60) r = [c, x, 0]; else if (h < 120) r = [x, c, 0];
  else if (h < 180) r = [0, c, x]; else if (h < 240) r = [0, x, c];
  else if (h < 300) r = [x, 0, c]; else r = [c, 0, x];
  return r.map((u) => Math.round((u + m) * 255));
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let seed = 1;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

for (let i = 0; i < COUNT; i++) {
  // Two colour bands per image, so the palettes are non-trivial.
  const hueA = (i * 360 / COUNT + rand() * 20) % 360;
  const hueB = (hueA + 40 + rand() * 60) % 360;
  const a = hsvToRgb(hueA, 0.5 + rand() * 0.45, 0.25 + rand() * 0.6);
  const b = hsvToRgb(hueB, 0.4 + rand() * 0.5, 0.2 + rand() * 0.7);
  const split = Math.floor(SIZE * (0.3 + rand() * 0.4));

  const px = new Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) px[y * SIZE + x] = y < split ? a : b;
  }
  fs.writeFileSync(
    path.join(OUT, `scale_${String(i).padStart(4, '0')}.png`),
    png(px, SIZE, SIZE)
  );
}

console.log(`${COUNT} PNGs in ${OUT}`);
