/**
 * 英文句子聚合抓取脚本（零第三方依赖，Node 18+ 原生运行）
 *
 * 主存储：Supabase `records` 表，整条句子以 JSON 存在 `data`(jsonb) 字段。
 * 去重基于 Supabase 现有句子（按归一化英文句匹配），重复运行只补新句。
 *
 * 用法：
 *   node fetch-quotes.js --import-local   # 首次迁移：把本地 sentences.json 导入 Supabase（自动去重）
 *   node fetch-quotes.js                  # 从公开源抓取新句，去重后写入 Supabase
 *   node fetch-quotes.js --dry-run        # 只预览将要写入的句子，不入库
 *   node fetch-quotes.js --limit 30       # 每个来源最多取 30 条候选
 *
 * 环境变量（必填，GitHub Actions 配在 Secrets，本地在终端临时设置）：
 *   SUPABASE_URL       例：https://xxx.supabase.co
 *   SUPABASE_ANON_KEY  anon / publishable key（sb_publishable_ 开头）
 *
 * 低风险说明：仅聚合公开演示/免费 API 上的公版名人语录，不抓取教材、新闻正文等受版权保护内容；
 *            单批请求、不高频轮询，建议每天最多跑一次。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SENTENCES_FILE = path.join(__dirname, 'sentences.json');
const TABLE = 'records';

// ---------- 命令行参数 ----------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const IMPORT_LOCAL = argv.includes('--import-local');
const limitIdx = argv.indexOf('--limit');
const PER_SOURCE_LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 60;

// ---------- Supabase 凭证 ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('✗ 缺少环境变量 SUPABASE_URL / SUPABASE_ANON_KEY，无法连接 Supabase。');
  process.exit(1);
}

// ---------- 工具：HTTP（带超时与重试） ----------
function errMessage(err) {
  if (!err) return '未知错误';
  if (err.errors && err.errors.length) {
    return err.errors.map((e) => e.message).filter(Boolean).join('; ') || err.code || err.name;
  }
  return err.message || err.code || err.name;
}

function getJson(url, retry = 2) {
  return new Promise((resolve, reject) => {
    const doRequest = (attempt) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (sentence-corpus-builder)' },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(attempt);
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON 解析失败：${e.message}`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', (err) => {
        if (attempt < retry) doRequest(attempt + 1);
        else reject(err);
      });
    };
    doRequest(0);
  });
}

// ---------- Supabase REST 封装 ----------
function supabaseRequest(method, restPath, body) {
  const u = new URL(SUPABASE_URL.replace(/\/$/, '') + restPath);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(b ? JSON.parse(b) : null);
        else reject(new Error(`Supabase ${method} ${restPath} -> ${res.statusCode}：${b.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Supabase 请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 读取库内已有句子，构建归一化去重集合（兼容旧结构 data.sentence）
async function fetchExistingKeys() {
  const rows = await supabaseRequest('GET', `/rest/v1/${TABLE}?select=data`);
  const keys = new Set();
  (rows || []).forEach((r) => {
    const d = (r && r.data) || {};
    const en = d.en || d.sentence || '';
    if (en) keys.add(normKey(en));
  });
  return keys;
}

// 分批写入，每批 500 条
async function insertEntries(entries) {
  const BATCH = 500;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map((e) => ({ data: e }));
    await supabaseRequest('POST', `/rest/v1/${TABLE}`, batch);
  }
}

// ---------- 句子清洗 / 校验 ----------
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim();
}

// 硬禁词：色情 / 谋杀暴力 / 犯罪 / 粗俗贬损 / 政治敏感（词边界匹配，避免子串误杀）
const BLOCK_RE = /\b(suicide|suicidal|murder|murderer|kill|killed|killing|naked|nude|sexual|sex|panties|ass|butt|damned|stupid|idiot|ignorant|criminal|crime|pathological|capitalist|capitalism|fleece|devil)\b/i;

function normalizeCase(en) {
  let s = String(en).toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/(^|[.!?]\s+)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
  return s
    .replace(/\bi'm\b/g, "I'm").replace(/\bi'll\b/g, "I'll")
    .replace(/\bi've\b/g, "I've").replace(/\bi'd\b/g, "I'd")
    .replace(/\bi\b/g, 'I');
}

function normKey(en) {
  return String(en).toLowerCase()
    .replace(/[^a-z0-9' \-]/g, ' ')
    .replace(/['\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isValid(en) {
  const words = normKey(en).split(' ').filter(Boolean);
  if (words.length < 4 || words.length > 40) return false;
  if (!/[a-zA-Z]/.test(en)) return false;
  if (BLOCK_RE.test(en)) return false;
  if (/[^\x00-\x7F\u2014\u2019\u201C\u201D.,!?;:'"()\-]/.test(en)) return false;
  return true;
}

function levelByWords(n) {
  if (n <= 8) return 'A2';
  if (n <= 15) return 'B1';
  return 'B2';
}

// ---------- 来源适配器（实测可达、公开免费） ----------
const SOURCES = [
  {
    name: 'ZenQuotes',
    async fetch() {
      const data = await getJson('https://zenquotes.io/api/quotes');
      return (Array.isArray(data) ? data : []).map((x) => ({
        en: stripHtml(x.q),
        author: stripHtml(x.a),
      }));
    },
  },
  {
    name: 'DummyJSON',
    async fetch() {
      const out = [];
      for (const skip of [0, 100]) {
        try {
          const data = await getJson(`https://dummyjson.com/quotes?limit=100&skip=${skip}`);
          (data.quotes || []).forEach((x) => out.push({ en: stripHtml(x.quote), author: stripHtml(x.author) }));
        } catch (e) {
          console.warn(`  · DummyJSON 第 ${skip / 100 + 1} 批失败，跳过：${errMessage(e)}`);
        }
      }
      return out;
    },
  },
];

// ---------- 模式一：导入本地 sentences.json ----------
function buildFromLocal(existKeys) {
  const raw = JSON.parse(fs.readFileSync(SENTENCES_FILE, 'utf8'));
  const seen = new Set();
  const entries = [];
  const stats = { invalid: 0, dupExisting: 0, dupRun: 0 };

  raw.forEach((s) => {
    const en = normalizeCase(s.en || '');
    if (!en) { stats.invalid++; return; }
    const k = normKey(en);
    if (existKeys.has(k)) { stats.dupExisting++; return; }
    if (seen.has(k)) { stats.dupRun++; return; }
    seen.add(k);
    entries.push({
      id: s.id || '',
      en,
      zh: s.zh || '',
      cat: s.cat || 'daily',
      level: s.level || levelByWords(k.split(' ').filter(Boolean).length),
      tags: s.tags || [],
      author: s.author || '',
      source: s.source || 'local',
      note: s.note || '',
    });
  });
  return { entries, stats };
}

// ---------- 模式二：公开源抓取 ----------
async function buildFromSources(existKeys) {
  const seen = new Set();
  const entries = [];
  const stats = { fetched: 0, invalid: 0, dupExisting: 0, dupRun: 0 };

  for (const src of SOURCES) {
    let items = [];
    try {
      items = await src.fetch();
    } catch (e) {
      console.warn(`· 来源 ${src.name} 抓取失败，已跳过：[${e.name}] ${errMessage(e)}`);
      continue;
    }
    let kept = 0;
    for (const it of items) {
      if (kept >= PER_SOURCE_LIMIT) break;
      const en = normalizeCase(it.en);
      stats.fetched++;
      if (!isValid(en)) { stats.invalid++; continue; }
      const k = normKey(en);
      if (existKeys.has(k)) { stats.dupExisting++; continue; }
      if (seen.has(k)) { stats.dupRun++; continue; }
      seen.add(k);

      const words = k.split(' ').filter(Boolean);
      entries.push({
        id: '',
        en,
        zh: '',
        cat: 'literature',
        level: levelByWords(words.length),
        tags: ['quote'],
        author: it.author || '',
        source: it.author ? `${src.name} · ${it.author}` : src.name,
        note: '',
      });
      kept++;
    }
    console.log(`· 来源 ${src.name}：新增候选 ${kept} 条`);
  }
  return { entries, stats };
}

// ---------- 主流程 ----------
(async () => {
  console.log(IMPORT_LOCAL ? '== 本地库导入 Supabase ==' : '== 公开源抓取入库 Supabase ==');
  const existKeys = await fetchExistingKeys();
  console.log(`· Supabase 现有句子：${existKeys.size} 条`);

  const { entries, stats } = IMPORT_LOCAL
    ? buildFromLocal(existKeys)
    : await buildFromSources(existKeys);

  // 新抓条目补编号（本地导入沿用原 id）
  const startNum = existKeys.size + 1;
  entries.forEach((e, i) => { if (!e.id) e.id = 'q' + String(startNum + i).padStart(3, '0'); });

  console.log('\n===== 汇总 =====');
  console.log(`不合格：${stats.invalid || 0}｜库内已存在：${stats.dupExisting || 0}｜本次重复：${stats.dupRun || 0}｜待新增：${entries.length}`);

  if (entries.length === 0) {
    console.log('没有需要新增的句子。');
    return;
  }

  console.log('\n--- 预览（前 10 条） ---');
  entries.slice(0, 10).forEach((e) => {
    console.log(`[${e.level}] ${e.en}  —— ${e.author || '佚名'}`);
  });

  if (DRY_RUN) {
    console.log('\n(dry-run) 未写入 Supabase。去掉 --dry-run 即可入库。');
    return;
  }

  await insertEntries(entries);
  console.log(`\n✅ 已写入 Supabase records 表：${entries.length} 条。`);
})().catch((e) => {
  console.error('脚本异常：', e.message || e);
  process.exit(1);
});
