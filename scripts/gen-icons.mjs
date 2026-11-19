#!/usr/bin/env node
/**
 * gen-icons.mjs — 纯 Node 生成 PWA 图标 PNG（无 canvas / 无依赖）
 * 设计：绿色底（#2F6B5E 全出血方形）+ 白色语音气泡 + 三个绿色圆点
 * 输出：icons/icon-192.png / icon-512.png / apple-touch-icon.png / maskable-512.png
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'icons');

const BG = [47, 107, 94, 255];   // #2F6B5E
const WHITE = [255, 255, 255, 255];
const DOT = [47, 107, 94, 255];  // 气泡内圆点 = 底色（负空间）

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 无过滤
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 几何 ----------
function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const dx = Math.max(x0 + r - px, 0, px - (x1 - r));
  const dy = Math.max(y0 + r - py, 0, py - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}
function inCircle(px, py, cx, cy, r) { const dx = px - cx, dy = py - cy; return dx * dx + dy * dy <= r * r; }
function sign(p1x, p1y, p2x, p2y, p3x, p3y) { return (p1x - p3x) * (p2y - p3y) - (p2x - p3x) * (p1y - p3y); }
function inTri(px, py, a, b, c) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1]);
  const d2 = sign(px, py, b[0], b[1], c[0], c[1]);
  const d3 = sign(px, py, c[0], c[1], a[0], a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
// 采样某点颜色（归一化坐标 0~1）
function sampleColor(nx, ny) {
  const W = 1, x = nx * W, y = ny * W;
  // 语音气泡（圆角矩形）
  const bx0 = 0.22, by0 = 0.26, bx1 = 0.78, by1 = 0.64, br = 0.09;
  // 尾巴三角
  const ta = [0.30, 0.64], tb = [0.44, 0.64], tc = [0.24, 0.80];
  let inBubble = inRoundedRect(x, y, bx0, by0, bx1, by1, br) || inTri(x, y, ta, tb, tc);
  if (inBubble) {
    // 三个圆点
    const cy = (by0 + by1) / 2;
    const r = 0.038;
    if (inCircle(x, y, 0.37, cy, r) || inCircle(x, y, 0.50, cy, r) || inCircle(x, y, 0.63, cy, r)) return DOT;
    return WHITE;
  }
  return BG;
}
function makeIcon(size, ss = 3) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 超采样平滑边缘
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (px + (sx + 0.5) / ss) / size;
          const ny = (py + (sy + 0.5) / ss) / size;
          const c = sampleColor(nx, ny);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = ss * ss;
      const o = (py * size + px) * 4;
      rgba[o] = Math.round(r / n); rgba[o + 1] = Math.round(g / n);
      rgba[o + 2] = Math.round(b / n); rgba[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, rgba);
}

// ---------- 输出 ----------
fs.mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of targets) {
  const png = makeIcon(size);
  fs.writeFileSync(path.join(OUT, name), png);
  console.log(`✓ ${name} (${size}x${size}, ${(png.length / 1024).toFixed(1)}KB)`);
}
console.log('✓ 图标生成完成');
