const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 本地兜底语料：Supabase 未配置或读取失败时使用
const LOCAL_FALLBACK = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'sentences.json'), 'utf8')
);

/* ---------- Supabase 客户端（可选；缺凭证/缺依赖时回退本地） ---------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('· 语料来源：Supabase records 表');
  } catch (e) {
    console.warn('· 未安装 @supabase/supabase-js，回退本地 sentences.json：', e.message);
    supabase = null;
  }
} else {
  console.warn('· 未配置 SUPABASE_URL / SUPABASE_ANON_KEY，使用本地 sentences.json');
}

// Supabase 行 { id, data: {...} } 展开成前端需要的扁平句子对象
function rowToEntry(row) {
  const d = (row && row.data) || {};
  return { ...d, id: d.id || String(row.id) };
}

// 拉取全量词库：Supabase 优先，失败/未配置回退本地 json
async function loadCorpus() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('records')
        .select('*')
        .order('id');
      if (error) throw error;
      const entries = (data || []).map(rowToEntry).filter((s) => s.en);
      if (entries.length) return entries;
      console.warn('· Supabase 表为空，回退本地 sentences.json');
    } catch (e) {
      console.warn('· 读取 Supabase 失败，回退本地 sentences.json：', e.message);
    }
  }
  return LOCAL_FALLBACK;
}

/* ---------- 本地持久化（data/store.json） ----------
 * 单用户本地使用，整份学习状态存到一个 JSON 文件；
 * 收藏、错题、历史、分钟数、导入句、设置重启后都不丢失。
 */
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const DEFAULT_STATE = {
  fav: [], wrong: [], history: {}, minutes: {}, imported: [],
  settings: { accent: 'US', rate: 0.9 }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  ensureDataDir();
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      return Object.assign({}, DEFAULT_STATE, parsed, {
        settings: Object.assign({}, DEFAULT_STATE.settings, parsed.settings || {})
      });
    }
  } catch (e) {
    console.error('读取本地状态失败，已使用空状态：', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function writeState(state) {
  try {
    ensureDataDir();
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    // 云端无持久磁盘时写入会失败，忽略即可；学习记录仍保存在浏览器 localStorage
    console.warn('· 后端状态持久化不可用（将仅存浏览器本地）：', e.message);
  }
}

/* ---------- 每日计划抽取 ---------- */
const SHORT_TARGET = 15; // 每日短句
const LONG_TARGET = 5;   // 每日末尾中长句
const levelRank = { B2: 2, B1: 1, A2: 0 };

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function hashCode(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function normalizeWords(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9' \-]/g, ' ')
    .replace(/['\-]/g, ' ')
    .trim().split(/\s+/).filter(Boolean);
}

// 按日期种子，稳定抽取当日计划：15 短句 + 5 长句
function buildTodayPlan(corpus) {
  const seed = hashCode(todayKey());
  const isLong = s => s.kind === 'passage' || s.kind === 'long';
  const shortPool = corpus.filter(s => !isLong(s))
    .sort((a, b) => (levelRank[b.level] || 0) - (levelRank[a.level] || 0));
  const longPool = corpus.filter(isLong);

  const cats = [...new Set(shortPool.map(s => s.cat))];
  const rot = cats.length ? seed % cats.length : 0;
  const rotated = cats.slice(rot).concat(cats.slice(0, rot));

  const plan = [];
  let ci = 0, guard = 0;
  while (plan.length < SHORT_TARGET && shortPool.length && guard < 400) {
    const cat = rotated[ci % rotated.length];
    const cand = shortPool.find(s => s.cat === cat && !plan.includes(s));
    if (cand) plan.push(cand);
    ci++; guard++;
    if (ci % rotated.length === 0 && plan.length < SHORT_TARGET) {
      const r = shortPool.find(s => !plan.includes(s));
      if (r) plan.push(r);
    }
  }
  const base = longPool.length ? seed % longPool.length : 0;
  for (let k = 0; k < LONG_TARGET && longPool.length; k++) {
    plan.push(longPool[(base + k) % longPool.length]);
  }

  const unique = new Set();
  plan.forEach(s => normalizeWords(s.en).forEach(w => unique.add(w)));
  return { date: todayKey(), plan, uniqueWordCount: unique.size };
}

// 全量词库（前端启动时拉取，再按本地记录抽取当日计划）
app.get('/api/all', async (req, res) => {
  try {
    const corpus = await loadCorpus();
    res.json(corpus);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 今日计划（后端按种子算好，备用接口）
app.get('/api/today', async (req, res) => {
  try {
    const corpus = await loadCorpus();
    res.json(buildTodayPlan(corpus));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 读取持久化的学习状态
app.get('/api/state', (req, res) => {
  res.json(readState());
});

// 整份保存学习状态（收藏 / 错题 / 历史 / 分钟数 / 导入句 / 设置）
app.put('/api/state', (req, res) => {
  const incoming = req.body && typeof req.body === 'object' ? req.body : {};
  const state = Object.assign({}, DEFAULT_STATE, incoming, {
    settings: Object.assign({}, DEFAULT_STATE.settings, incoming.settings || {})
  });
  writeState(state);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});
