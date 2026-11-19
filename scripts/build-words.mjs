#!/usr/bin/env node
/**
 * build-words.mjs — 生成 data/words.json（COCA top-5000 高频词 + 音标 + 中文释义）
 *
 * 数据源（均为公开免费资源，个人自用）：
 *   - scripts/COCA_Top5000.csv  来自 GitHub: brucewlee/COCA-WordFrequency（已随仓库提交）
 *   - ECDICT ecdict.csv         来自 GitHub: skywind3000/ECDICT（不提交，本地缓存或自动下载）
 *
 * 用法：
 *   node scripts/build-words.mjs
 *
 * 说明：words.json 是相对稳定的静态数据，通常无需频繁重建；
 *      每日内容任务（build-daily.mjs）只读不写。
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const COCA_FILE = path.join(__dirname, 'COCA_Top5000.csv');
const OUT_FILE = path.join(ROOT, 'data', 'words.json');
const ECDICT_CACHE = path.join(__dirname, '.ecdict-cache.csv');
const ECDICT_RAW = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';

// ---------- 最小 CSV 解析器（支持引号字段内逗号/换行） ----------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- 下载（带重定向与超时） ----------
function fetchBuffer(url, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (word-list-builder)' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchBuffer(res.headers.location, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout: ' + url)));
    req.on('error', reject);
  });
}

// ---------- 音标 / 释义清洗 ----------
function normIpa(s) {
  return String(s || '')
    .replace(/[\u04E9\u04D8]/g, '\u0259') // 西里尔字母 schwa → 拉丁 schwa
    .replace(/:/g, '\u02D0')             // ECDICT 长音冒号 → ː
    .replace(/\s+/g, '')
    .trim();
}

function cleanZh(s) {
  // 取第一行释义，去掉 [网络] [医] 等标签前缀
  let line = String(s || '').split(/\n/)[0] || '';
  line = line.replace(/^\s*\[(网络|医|经|化|计|数|法|哲|音|电|机|建|农|史|地|天|物|生|心|人|教|体|军|交|航|动|植|微|虫|菌|环|安|法|贸|财|税|劳|保|会|统|管|行|市|营|销|财|会|计|审|经|济|管|理|人|力|资|源|工|商|法|律|合|同|诉|讼|刑|民|商|行|政|审|宪|国际法|私法|公法)\]\s*/, '');
  line = line.replace(/[\\]{1,2}n.*$/, '');
  return line.trim().slice(0, 60);
}

// ---------- ECDICT 未覆盖的高频词兜底表（专有名词/月份/星期/缩写等） ----------
// 格式：词 -> [音标, 中文]
const FALLBACK = {
  i: ['aɪ', 'pron. 我'],
  american: ['əˈmɛrɪkən', 'adj. 美国的 n. 美国人'],
  north: ['nɔːrθ', 'n. 北；北方 adj. 北部的'],
  ok: ['ˈoʊˈkeɪ', 'int. 好的，可以（=okay）'],
  tv: ['ˈtiːˈviː', 'n. 电视（=television）'],
  september: ['sɛpˈtɛmbɚ', 'n. 九月'],
  et: ['ɛt', 'prep. 和（拉丁语，如 et al. 等人）'],
  sunday: ['ˈsʌndi', 'n. 星期日'],
  june: ['dʒuːn', 'n. 六月'],
  friday: ['ˈfraɪdeɪ', 'n. 星期五'],
  november: ['noʊˈvɛmbɚ', 'n. 十一月'],
  july: ['dʒuˈlaɪ', 'n. 七月'],
  october: ['ɑːkˈtoʊbɚ', 'n. 十月'],
  saturday: ['ˈsætərdeɪ', 'n. 星期六'],
  april: ['ˈeɪprəl', 'n. 四月'],
  god: ['ɡɑːd', 'n. 上帝，神'],
  christian: ['ˈkrɪstʃən', 'adj. 基督教的 n. 基督徒'],
  christmas: ['ˈkrɪsməs', 'n. 圣诞节'],
  monday: ['ˈmʌndeɪ', 'n. 星期一'],
  chinese: ['ˌtʃaɪˈniːz', 'adj. 中国的 n. 中文；中国人'],
  british: ['ˈbrɪtɪʃ', 'adj. 英国的 n. 英国人'],
  january: ['ˈdʒænjueri', 'n. 一月'],
  am: ['ˈeɪˈɛm', 'n. 上午（a.m.）'],
  tuesday: ['ˈtuːzdeɪ', 'n. 星期二'],
  european: ['juːˈrɑːpɪən', 'adj. 欧洲的 n. 欧洲人'],
  african: ['əˈfrɪkən', 'adj. 非洲的 n. 非洲人'],
  thursday: ['ˈθɜːrzdeɪ', 'n. 星期四'],
  french: ['frɛntʃ', 'adj. 法国的 n. 法语'],
  december: ['dɪˈsɛmbɚ', 'n. 十二月'],
  wednesday: ['ˈwɛnzdeɪ', 'n. 星期三'],
  core: ['kɔːr', 'n. 核心；果核'],
  pm: ['ˈpiːˈɛm', 'n. 下午（p.m.）'],
  conservative: ['kənˈsɜːrvətɪv', 'adj. 保守的 n. 保守派'],
  russian: ['ˈrʌʃən', 'adj. 俄罗斯的 n. 俄语'],
  soviet: ['soʊˈviːət', 'adj. 苏维埃的'],
  english: ['ˈɪŋɡlɪʃ', 'adj. 英国的 n. 英语'],
  jewish: ['ˈdʒuːɪʃ', 'adj. 犹太人的 n. 犹太人'],
  indian: ['ˈɪndiən', 'adj. 印度的 n. 印度人'],
  february: ['ˈfɛbjueri', 'n. 二月'],
  'e-mail': ['ˈiːmeɪl', 'n. 电子邮件'],
  app: ['æp', 'n. 手机应用程序'],
  german: ['ˈdʒɜːrmən', 'adj. 德国的 n. 德语'],
  japanese: ['ˌdʒæpəˈniːz', 'adj. 日本的 n. 日语'],
  israeli: ['ˌɪzreɪˈɛli', 'adj. 以色列的 n. 以色列人'],
  muslim: ['ˈmʌslɪm', 'adj. 穆斯林的 n. 穆斯林'],
  dna: ['ˌdiː ˈɛn ˈeɪ', 'n. DNA，脱氧核糖核酸'],
  iraqi: ['əˈrækɪ', 'adj. 伊拉克的 n. 伊拉克人'],
  spanish: ['ˈspænɪʃ', 'adj. 西班牙的 n. 西班牙语'],
  arab: ['ˈæræb', 'adj. 阿拉伯的 n. 阿拉伯人'],
  'mm-hmm': ['m', 'int. 嗯'],
  islamic: ['ɪˈslæmɪk', 'adj. 伊斯兰的'],
  aids: ['eɪdz', 'n. 艾滋病（AIDS）'],
  asian: ['ˈeɪʒən', 'adj. 亚洲的 n. 亚洲人'],
  mexican: ['mɛˈkɪkən', 'adj. 墨西哥的 n. 墨西哥人'],
  palestinian: ['ˌpælstiˈniːən', 'adj. 巴勒斯坦的 n. 巴勒斯坦人'],
  islam: ['ˈɪsləm', 'n. 伊斯兰教'],
  pc: ['ˌpiː ˈsiː', 'n. 个人电脑（=computer）'],
  'health-care': ['ˈhɛlθ kɛr', 'n. 医疗保健'],
  italian: ['ɪˈteɪliən', 'adj. 意大利的 n. 意大利语'],
  canadian: ['kəˈneɪdiən', 'adj. 加拿大的 n. 加拿大人'],
  latin: ['ˈleɪtɪn', 'adj. 拉丁的 n. 拉丁语'],
  pole: ['poʊl', 'n. 杆；桩；（the Poles）波兰人'],
  olympic: ['oʊˈlɪmpɪk', 'adj. 奥林匹克的'],
  irish: ['ˈɪrɪʃ', 'adj. 爱尔兰的 n. 爱尔兰语'],
  cd: ['ˌsiː ˈdiː', 'n. 光盘（=CD）'],
  doc: ['dɑːk', 'n. 博士；医生；文档'],
  korean: ['kɔːrˈiːən', 'adj. 韩国的 n. 韩语'],
  roman: ['ˈroʊmən', 'adj. 罗马的 n. 罗马人'],
  hispanic: ['hɪˈspænɪk', 'adj. 拉丁美洲的；西语裔的'],
  't-shirt': ['ˈtiː ʃɜːrt', 'n. T恤'],
  saint: ['seɪnt', 'n. 圣徒；（前缀）圣'],
  creator: ['kriˈeɪtər', 'n. 创造者；创作者'],
  greek: ['ɡriːk', 'adj. 希腊的 n. 希腊语'],
  christianity: ['krɪˈstɪnəti', 'n. 基督教'],
  iranian: ['ˌɪreɪˈniːən', 'adj. 伊朗的 n. 伊朗人'],
  halloween: ['ˈhæləʊɪn', 'n. 万圣节（前夕）'],
  dutch: ['dʌtʃ', 'adj. 荷兰的 n. 荷兰语'],
  syrian: ['sɪˈriːən', 'adj. 叙利亚的 n. 叙利亚人'],
};

// ---------- 主流程 ----------
async function main() {
  if (!fs.existsSync(COCA_FILE)) {
    console.error('✗ 缺少 scripts/COCA_Top5000.csv');
    process.exit(1);
  }
  // 1) COCA 词频
  const cocaRows = parseCsv(fs.readFileSync(COCA_FILE, 'utf8'));
  const head = cocaRows[0].map((h) => h.trim().replace(/^\ufeff/, ''));
  const iRank = head.indexOf('rank');
  const iLemma = head.indexOf('lemma');
  const coca = cocaRows.slice(1)
    .map((r) => ({ rank: parseInt(r[iRank], 10) || 0, lemma: (r[iLemma] || '').trim() }))
    .filter((x) => x.lemma && x.rank > 0)
    .sort((a, b) => a.rank - b.rank);
  console.log(`· COCA 词条：${coca.length}`);

  // 2) ECDICT（本地缓存优先，否则下载）
  let ecdictPath = null;
  for (const p of [path.join(__dirname, 'ecdict.csv'), ECDICT_CACHE]) {
    if (fs.existsSync(p)) { ecdictPath = p; break; }
  }
  if (!ecdictPath) {
    console.log('· 下载 ECDICT ecdict.csv（约 66MB，一次性）…');
    const buf = await fetchBuffer(ECDICT_RAW, 600000);
    ecdictPath = ECDICT_CACHE;
    fs.writeFileSync(ecdictPath, buf);
    console.log(`· 已缓存到 ${path.relative(ROOT, ecdictPath)}`);
  }
  const ecdictText = fs.readFileSync(ecdictPath, 'utf8');
  const eRows = parseCsv(ecdictText);
  const eHead = eRows[0].map((h) => h.trim());
  const iW = 0, iPh = eHead.indexOf('phonetic'), iTr = eHead.indexOf('translation');
  const dict = new Map();
  for (const r of eRows.slice(1)) {
    const w = (r[iW] || '').trim();
    if (!w || dict.has(w)) continue;
    dict.set(w, {
      ipa: normIpa(r[iPh] || ''),
      zh: cleanZh(iTr >= 0 ? r[iTr] || '' : ''),
    });
  }
  console.log(`· ECDICT 词条：${dict.size}`);

  // 3) 合成 words.json（短键：w 词 / i 音标 / z 中文 / r 频次排名）
  //    COCA 中同一 lemma 会按词性出现多行 → 按 lemma 去重，保留最小 rank（最高频）
  const byLemma = new Map();
  for (const c of coca) {
    const key = c.lemma.toLowerCase();
    if (!byLemma.has(key) || c.rank < byLemma.get(key).rank) byLemma.set(key, c);
  }
  const entries = [];
  let hitIpa = 0, hitZh = 0, hitFallback = 0;
  for (const c of [...byLemma.values()].sort((a, b) => a.rank - b.rank)) {
    let d = dict.get(c.lemma) || dict.get(c.lemma.toLowerCase());
    if (!d && FALLBACK[c.lemma.toLowerCase()]) {
      const [ipa, zh] = FALLBACK[c.lemma.toLowerCase()];
      d = { ipa: ipa, zh };
      hitFallback++;
    }
    if (!d) continue;
    if (d.ipa) hitIpa++;
    if (d.zh) hitZh++;
    entries.push({ w: c.lemma, i: d.ipa, z: d.zh, r: c.rank });
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(entries));
  console.log(`✓ 已生成 ${path.relative(ROOT, OUT_FILE)}：${entries.length} 词（唯一 lemma ${byLemma.size}，音标覆盖 ${hitIpa}，中文覆盖 ${hitZh}，兜底补入 ${hitFallback}）`);
}

main().catch((e) => { console.error('脚本异常：', e.message || e); process.exit(1); });
