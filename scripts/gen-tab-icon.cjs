// 从 assets/logo.jpg 抠出人物形象，生成透明底 tab 图标 assets/tab-avatar.png
// 原理：红色背景（r 明显大于 g、b）置为透明，人物（黄/蓝/黑）保留；边缘做轻微羽化。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const src = path.join(ROOT, 'assets/logo.jpg');
const out = path.join(ROOT, 'assets/tab-avatar.png');
const SIZE = 128;

const img = jpeg.decode(fs.readFileSync(src), { useTArray: true });
const w = img.width, h = img.height, d = Buffer.from(img.data);

// 居中裁成正方形
const side = Math.min(w, h);
const ox = Math.floor((w - side) / 2), oy = Math.floor((h - side) / 2);

// 双线性采样 + 抠背景
function sample(x, y) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const i = (y * w + x) * 4;
  return [d[i], d[i + 1], d[i + 2]];
}
function alphaOf(r, g, b) {
  // 红色背景 redness 很大 -> 透明；人物接近 0 或负 -> 不透明
  const redness = r - Math.max(g, b);
  if (redness >= 95) return 0;
  if (redness <= 55) return 255;
  return Math.round(255 * (95 - redness) / 40); // 羽化过渡带
}

const png = new PNG({ width: SIZE, height: SIZE });
const scale = side / SIZE;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 双线性
    const sx = ox + (x + 0.5) * scale - 0.5, sy = oy + (y + 0.5) * scale - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const c00 = sample(x0, y0), c10 = sample(x0 + 1, y0), c01 = sample(x0, y0 + 1), c11 = sample(x0 + 1, y0 + 1);
    const ch = k => Math.round((c00[k] * (1 - fx) + c10[k] * fx) * (1 - fy) + (c01[k] * (1 - fx) + c11[k] * fx) * fy);
    const r = ch(0), g = ch(1), b = ch(2);
    // 左上角黑色三角（背景装饰）去边：位于左上对角区域且偏暗 -> 透明
    const nx = x / SIZE, ny = y / SIZE;
    const inCornerTri = nx < 0.22 && ny < 0.3 * (1 - nx / 0.22);
    const dark = (r + g + b) / 3 < 90;
    const a = inCornerTri && dark ? 0 : alphaOf(r, g, b);
    const di = (y * SIZE + x) * 4;
    png.data[di] = r; png.data[di + 1] = g; png.data[di + 2] = b; png.data[di + 3] = a;
  }
}
fs.writeFileSync(out, PNG.sync.write(png));
console.log('written', out, fs.statSync(out).size, 'bytes', `${SIZE}x${SIZE}`);
