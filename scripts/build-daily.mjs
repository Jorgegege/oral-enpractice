#!/usr/bin/env node
/**
 * build-daily.mjs — 生成每日跟读计划（GitHub Actions 每日定时运行）
 *
 * 产出：
 *   data/today-<YYYY-MM-DD>.json  当日计划（20 短句总词量≥200 + 2~3 长句≥30词 + 10 新词）
 *   data/corpus.json              全量句库（增量合并新抓取的句子，按稳定 ID 去重）
 *   data/served.json              近 30 天已用句子台账（避免重复）
 *
 * 数据源（全部免费、无需 key，GitHub Actions 内可达）：
 *   - BBC World RSS          时政新闻（当前要闻）
 *   - Wikipedia On This Day  历史同日事件（每日不同）
 *   - Project Gutenberg      公版名著（按日期轮换书目）
 *   - ZenQuotes              名言兜底
 *
 * 用法：
 *   node scripts/build-daily.mjs                 # 用「北京时间今天」为目标日期，抓取外部源
 *   node scripts/build-daily.mjs --local         # 本地模式：不联网，只用现有 corpus 生成计划
 *   node scripts/build-daily.mjs --date 2026-06-01
 *
 * 说明：
 *   - 目标日期取「北京时间」（UTC+8）。Actions cron 在 UTC 22:00（=北京 06:00）运行，
 *     生成的文件日期正好是用户在手机上「早上打开」那天。
 *   - 中文翻译为「尽力而为」：优先 Google gtx 免费端点，失败退 MyMemory，再失败则 zh 为空。
 *   - 确定性：同日重复运行得到相同计划（种子随机以日期为种子）。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CORPUS_FILE = path.join(DATA, 'corpus.json');
const WORDS_FILE = path.join(DATA, 'words.json');
const SERVED_FILE = path.join(DATA, 'served.json');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const LOCAL = argv.includes('--local');
const DATE_ARG = arg('--date'); // YYYY-MM-DD
const SERVED_DAYS = 30;
const SHORT_TARGET = 20;      // 短句条数
const SHORT_MIN_WORDS = 200;  // 短句总词量下限
const LONG_TARGET = 3;        // 长句目标条数（池不足则取 2）
const LONG_MIN_WORDS = 30;    // 长句每句词数下限
const NEW_WORDS = 10;         // 每日新词数
const MAX_TRANSLATE = 60;     // 单次运行最多翻译条数（对免费接口友好）

// ---------- 工具 ----------
function beijingDateNow() {
  // 当前北京时间日期（UTC+8）
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function targetDate() {
  if (DATE_ARG && /^\d{4}-\d{2}-\d{2}$/.test(DATE_ARG)) return DATE_ARG;
  return beijingDateNow();
}

// 稳定 ID：'s' + 归一化文本 8 位 hash（跨次更新可去重）
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}
function stableId(en) {
  return 's' + djb2(normText(en)).toString(36).padStart(8, '0').slice(0, 8);
}

// 种子随机（mulberry32），种子来自日期 → 同日结果确定
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const wordCount = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

// ---------- 网络（带超时 + 重定向） ----------
function fetchText(url, timeoutMs = 30000, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OralPracticeDaily/1.0)' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchText(res.headers.location, timeoutMs, maxBytes).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout: ' + url)));
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 状态加载 ----------
function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.warn(`· 读取 ${path.basename(file)} 失败：${e.message}，用兜底`); }
  return fallback;
}
function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj));
}

// ---------- 中文翻译（尽力而为） ----------
async function translateZh(en) {
  const q = encodeURIComponent(en);
  // 1) Google gtx
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${q}`;
    const raw = await fetchText(url, 15000, 512 * 1024);
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && Array.isArray(arr[0])) {
      const t = arr[0].map((x) => (x && x[0]) || '').join('');
      if (t && t !== en) return t.trim();
    }
  } catch { /* fallthrough */ }
  // 2) MyMemory
  try {
    const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh-CN`;
    const raw = await fetchText(url, 15000, 256 * 1024);
    const j = JSON.parse(raw);
    const t = j && j.responseData && j.responseData.translatedText;
    if (t) return t.trim();
  } catch { /* fallthrough */ }
  return '';
}

// ---------- 句子清洗 ----------
// 从一段文本里切出「适合跟读」的句子：6~28 词（长句候选另保留 30~45 词）
function extractSentences(text, { min = 6, max = 28 } = {}) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/([.!?])\s+/g, '$1| ');
  const out = [];
  for (let part of clean.split('|')) {
    let s = part.trim().replace(/^\d+[\.\)]\s*/, '').trim();
    if (!s || s === '[') continue;
    // 去掉书名号/引用残留
    s = s.replace(/^[“"'\[]+/, '').replace(/[\]"']+$/, '').trim();
    const wc = wordCount(s);
    if (wc < min || wc > max) continue;
    // 必须以字母开头、含字母
    if (!/^[A-Za-z]/.test(s)) continue;
    if (!/[a-zA-Z]{2,}/.test(s)) continue;
    out.push(s);
  }
  return out;
}

// ---------- 各数据源 ----------
async function fromBBC() {
  const url = 'https://feeds.bbci.co.uk/news/world/rss.xml';
  const xml = await fetchText(url, 25000, 1024 * 1024);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const out = [];
  for (const it of items) {
    const t = (m) => { const x = it.match(new RegExp(`<${m}>([\\s\\S]*?)<\\/${m}>`)); return x ? x[1].trim() : ''; };
    const title = t('title').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const desc = t('description').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // 优先用描述（信息量更大），太短则退回标题
    const text = wordCount(desc) >= 8 ? desc : (wordCount(title) >= 8 ? title : '');
    if (!text) continue;
    for (const s of extractSentences(text)) {
      out.push({ en: s, zh: '', cat: 'news', level: 'B1', kind: wordCount(s) >= 30 ? 'long' : 'sentence', source: 'BBC News' });
    }
  }
  return out;
}

async function fromOnThisDay(dateStr) {
  const mm = dateStr.slice(5, 7).replace(/^0/, '') || '1';
  const dd = dateStr.slice(8, 10).replace(/^0/, '') || '1';
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${mm}/${dd}`;
  const raw = await fetchText(url, 25000, 1024 * 1024);
  const j = JSON.parse(raw);
  const out = [];
  for (const ev of j.events || []) {
    const s = String(ev.text || '').replace(/\[\d+\]/g, '').replace(/{{[^}]*}}/g, '').replace(/\s+/g, ' ').trim();
    const wc = wordCount(s);
    if (wc < 8 || wc > 30) continue;
    out.push({ en: s, zh: '', cat: 'onthisday', level: 'B2', kind: 'sentence', source: `Wikipedia · ${ev.year}` });
  }
  return out;
}

const GUTENBERG_BOOKS = [
  { id: 1342, title: 'Pride and Prejudice' },
  { id: 84, title: 'Moby-Dick' },
  { id: 98, title: 'Frankenstein' },
  { id: 766, title: 'A Tale of Two Cities' },
  { id: 1228, title: 'Great Expectations' },
  { id: 11, title: 'Alice in Wonderland' },
  { id: 1290, title: 'Jane Eyre' },
  { id: 2552, title: 'The Adventures of Sherlock Holmes' },
  { id: 76, title: 'Adventures of Huckleberry Finn' },
  { id: 345, title: 'The Adventures of Tom Sawyer' },
  { id: 4521, title: 'The Time Machine' },
  { id: 10220, title: 'Dracula' },
];
async function fromGutenberg(dateStr) {
  const seed = djb2('gutenberg-' + dateStr);
  const rng = mulberry32(seed);
  const book = GUTENBERG_BOOKS[seed % GUTENBERG_BOOKS.length];
  // 优先 cache/epub 纯文本，失败退 files 路径
  const urls = [
    `https://www.gutenberg.org/cache/epub/${book.id}/pg${book.id}.txt`,
    `https://www.gutenberg.org/files/${book.id}/${book.id}-0.txt`,
  ];
  let text = '';
  for (const u of urls) { try { text = await fetchText(u, 40000, 1024 * 1024); if (text.length > 5000) break; } catch { /* next */ } }
  if (!text || text.length < 5000) return [];
  text = text.slice(0, 800 * 1024); // 只处理前 800KB，控制体量
  // 跳过版权/头部，从正文找句子
  const start = text.indexOf('\n\n');
  const body = text.slice(start > 0 ? start : 0);
  const sents = extractSentences(body, { min: 6, max: 45 });
  const rng2 = mulberry32(djb2('gutenberg-sel-' + dateStr));
  const picked = seededShuffle(sents, rng2).slice(0, 30);
  return picked.map((s) => ({
    en: s, zh: '', cat: 'literature', level: 'B2',
    kind: wordCount(s) >= 30 ? 'long' : 'sentence',
    source: `Gutenberg · ${book.title}`,
  }));
}

async function fromZenQuotes() {
  const url = 'https://zenquotes.io/api/random?count=10';
  const raw = await fetchText(url, 20000, 512 * 1024);
  const arr = JSON.parse(raw);
  const out = [];
  for (const it of arr) {
    const s = String(it.q || '').replace(/\s+/g, ' ').trim();
    const wc = wordCount(s);
    if (wc < 6 || wc > 30) continue;
    out.push({ en: s, zh: '', cat: 'quote', level: 'B1', kind: 'sentence', source: `ZenQuotes · ${it.a || ''}` });
  }
  return out;
}

// ---------- 每日计划选择 ----------
function buildPlan(corpus, servedIds, words, dateStr) {
  const rng = mulberry32(djb2('plan-' + dateStr));
  const inServed = new Set(servedIds);
  // 可用池：排除近 30 天用过的
  let pool = corpus.filter((x) => x.en && !inServed.has(x.id));
  // 池太小则放宽（允许复用）
  const relax = pool.length < SHORT_TARGET + 5;
  if (relax) pool = corpus.filter((x) => x.en);

  const shortPool = seededShuffle(pool.filter((x) => wordCount(x.en) >= 4 && wordCount(x.en) <= 22), rng);
  const longPool = seededShuffle(pool.filter((x) => wordCount(x.en) >= LONG_MIN_WORDS), rng);

  // 短句：取 SHORT_TARGET 条，保证总词量 ≥ SHORT_MIN_WORDS
  const short = [];
  let totalWords = 0;
  for (const s of shortPool) {
    if (short.length >= SHORT_TARGET) break;
    short.push(s); totalWords += wordCount(s.en);
  }
  // 总词量不足 → 用更长的未选句替换最短的已选句
  if (totalWords < SHORT_MIN_WORDS && short.length) {
    const chosen = new Set(short.map((x) => x.id));
    const upgrades = shortPool.filter((x) => !chosen.has(x.id)).sort((a, b) => wordCount(b.en) - wordCount(a.en));
    short.sort((a, b) => wordCount(a.en) - wordCount(b.en)); // 短的在前
    for (const up of upgrades) {
      if (totalWords >= SHORT_MIN_WORDS) break;
      if (!short.length) break;
      const weakest = short[0];
      if (wordCount(up.en) <= wordCount(weakest.en)) continue;
      totalWords += wordCount(up.en) - wordCount(weakest.en);
      short.shift(); short.push(up);
    }
  }
  // 长句：取 2~3 条
  const longN = Math.min(LONG_TARGET, Math.max(2, longPool.length));
  const long = longPool.slice(0, longN);

  // 新词：按「日期窗口」轮转，连续 10 个不重叠，绕一圈约 433 天
  const ipaWords = words.filter((w) => w.i);
  const dayIndex = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 86400000);
  const offset = ((dayIndex % ipaWords.length) + ipaWords.length) % ipaWords.length;
  const newWords = [];
  for (let k = 0; k < NEW_WORDS && ipaWords.length; k++) {
    newWords.push(ipaWords[(offset + k) % ipaWords.length]);
  }

  const slim = (x) => ({ id: x.id, en: x.en, zh: x.zh || '', cat: x.cat, level: x.level, note: x.note || '' });
  return {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    short: short.map(slim),
    long: long.map(slim),
    words: newWords,
    meta: {
      shortCount: short.length,
      shortTotalWords: totalWords,
      longCount: long.length,
      newWords: newWords.length,
      relaxed: relax,
    },
  };
}

// ---------- 主流程 ----------
async function main() {
  const dateStr = targetDate();
  console.log(`· 目标日期：${dateStr}（${LOCAL ? '本地模式，不联网' : '联网抓取'}）`);
  const corpus = loadJson(CORPUS_FILE, []);
  const words = loadJson(WORDS_FILE, []);
  const served = loadJson(SERVED_FILE, {});
  console.log(`· 现有句库：${corpus.length} 句 / 词库：${words.length} 词`);

  // 1) 抓取外部源（本地模式跳过）
  let newAdded = 0;
  if (!LOCAL) {
    const known = new Set(corpus.map((x) => x.id));
    const candidates = [];
    const sources = [
      ['BBC', () => fromBBC()],
      ['OnThisDay', () => fromOnThisDay(dateStr)],
      ['Gutenberg', () => fromGutenberg(dateStr)],
      ['ZenQuotes', () => fromZenQuotes()],
    ];
    for (const [name, fn] of sources) {
      try {
        const items = await fn();
        let added = 0;
        for (const it of items) {
          const id = stableId(it.en);
          if (known.has(id)) continue;
          known.add(id);
          it.id = id;
          it.date = dateStr;
          it.tags = [];
          corpus.push(it);
          candidates.push(it);
          added++;
        }
        console.log(`  · [${name}] 抓到 ${items.length} 句，新增 ${added} 句`);
        newAdded += added;
      } catch (e) {
        console.warn(`  · [${name}] 抓取失败：${e.message}`);
      }
    }

    // 2) 尽力而为翻译（只翻译本次新增）
    let translated = 0;
    for (const c of candidates) {
      if (translated >= MAX_TRANSLATE) break;
      if (!c.zh) {
        c.zh = await translateZh(c.en);
        if (c.zh) translated++;
        await sleep(120);
      }
    }
    console.log(`· 翻译完成：${translated}/${candidates.length} 句`);
  }

  // 3) 清理 served 台账（只留近 30 天）
  const allServedDates = Object.keys(served).sort();
  const cutoff = new Date(Date.now() + 8 * 3600 * 1000 - SERVED_DAYS * 86400000).toISOString().slice(0, 10);
  for (const d of allServedDates) if (d < cutoff) delete served[d];
  const servedIds = new Set(Object.values(served).flat());

  // 4) 生成当日计划
  const plan = buildPlan(corpus, servedIds, words, dateStr);
  const usedIds = [...plan.short, ...plan.long].map((x) => x.id);
  served[dateStr] = [...new Set(usedIds)];

  // 5) 落盘
  const todayFile = path.join(DATA, `today-${dateStr}.json`);
  saveJson(todayFile, plan);
  saveJson(CORPUS_FILE, corpus);
  saveJson(SERVED_FILE, served);

  console.log(`✓ 今日计划：${plan.meta.shortCount} 短句（共 ${plan.meta.shortTotalWords} 词）+ ${plan.meta.longCount} 长句 + ${plan.meta.newWords} 新词`);
  console.log(`  · ${path.relative(ROOT, todayFile)}`);
  if (newAdded) console.log(`  · 句库新增 ${newAdded} 句，现共 ${corpus.length} 句`);
}

main().catch((e) => { console.error('脚本异常：', e.stack || e.message || e); process.exit(1); });
