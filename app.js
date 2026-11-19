#!/usr/bin/env node
/**
 * app.js — 本地静态服务器（零依赖，仅需 Node）
 * 用途：本地开发/预览。正式使用走 GitHub Pages，不需要本文件。
 * 用法：node app.js  →  http://localhost:4321
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { res.writeHead(400); return res.end('Bad Request'); }
  if (urlPath === '/') urlPath = '/index.html';

  // 防目录穿越
  const file = path.join(ROOT, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }

  fs.stat(file, (err, st) => {
    if (!err && st.isFile()) {
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    // data 缺失 → 给合法空 JSON，前端自动走缓存/本地兜底
    if (urlPath.startsWith('/data/')) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end('[]');
    }
    // 其余路径回退首页（SPA）
    const idx = path.join(ROOT, 'index.html');
    fs.readFile(idx, (e, b) => {
      if (e) { res.writeHead(404); return res.end('Not Found'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(b);
    });
  });
}).listen(PORT, () => {
  console.log('');
  console.log('  英语口语教练 · 本地已启动');
  console.log('  → http://localhost:' + PORT);
  console.log('  （按 Ctrl+C 停止）');
  console.log('');
});
