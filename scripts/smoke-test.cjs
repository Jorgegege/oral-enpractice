// 英语口语教练 · 前端冒烟测试（开发/CI 用，非运行时依赖）
// 用法：npm install 后 `node scripts/smoke-test.cjs`（或 `npm test`）
// 作用：用 jsdom 无头加载 index.html，验证页面初始化无运行时错误、
//       5 个 Tab 全部渲染、跟读弹层可开可关、录音→音素反馈流程不抛错、字幕双语解析正确。
// 若本机未安装 jsdom 则优雅跳过（退出码 0），不影响普通使用。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function dataFile(rel) {
  const p = path.join(ROOT, rel);
  if (fs.existsSync(p)) return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(p, 'utf8')) };
  return { ok: false, status: 404, json: async () => { throw new Error('404 ' + rel); } };
}

// 模拟 SpeechRecognition：start() 后回传一个固定 final 文本再触发 onend
class MockSR {
  start() {
    setTimeout(() => {
      if (this._onresult) this._onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'i think this is a great day to practice speaking english today' } }] });
      if (this._onend) this._onend();
    }, 30);
  }
  stop() {} abort() {}
  set onresult(fn) { this._onresult = fn; }
  set onend(fn) { this._onend = fn; }
  set onerror(fn) { this._onerror = fn; }
}

function loadJSDOM() {
  try { const m = require('jsdom'); return m.JSDOM || m; } catch (e) {}
  const candidates = [
    'C:/Users/Admin/.workbuddy/binaries/node/versions/22.22.2-6/node_modules/@tencent/slidep/node_modules/jsdom',
  ];
  for (const p of candidates) { try { const m = require(p); return m.JSDOM || m; } catch (e) {} }
  return null;
}

const JSDOM = loadJSDOM();
if (!JSDOM) {
  console.log('⚠️ 未找到 jsdom，跳过冒烟测试（CI 会 `npm install` 后运行）。');
  process.exit(0);
}

const scriptErrors = [];
const consoleErrors = [];

const dom = new JSDOM(html, {
  url: 'http://localhost:4321/#/home',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = (url) => {
      const rel = String(url).replace(/^https?:\/\/[^/]+\//, '');
      return Promise.resolve(dataFile(rel));
    };
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    window.speechSynthesis = { getVoices: () => [{ name: 'en-US', lang: 'en-US' }], speak() {}, cancel() {}, pause() {}, resume() {}, onvoiceschanged: null };
    window.SpeechRecognition = MockSR;
    window.webkitSpeechRecognition = MockSR;
    window.HTMLElement.prototype.scrollIntoView = function () {}; // jsdom 未实现
    window.addEventListener('error', (e) => scriptErrors.push(e.message || 'unknown'));
    const origErr = window.console.error;
    window.console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); origErr.apply(window.console, a); };
  }
});

const { window } = dom;
const { document } = window;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitFor(fn, timeout = 6000, interval = 50) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      let r; try { r = fn(); } catch (e) {}
      if (r) { clearInterval(t); resolve(r); }
      else if (Date.now() - start > timeout) { clearInterval(t); reject(new Error('timeout')); }
    }, interval);
  });
}

(async () => {
  const results = {};
  const errors = [];

  try {
    await waitFor(() => !document.querySelector('#view .loading') && document.querySelector('#headerDate').textContent.trim() !== '—');
  } catch (e) { errors.push('init timeout'); }

  results['headerDate'] = document.querySelector('#headerDate').textContent.trim();
  results['标题 Oral practice'] = (document.querySelector('.brand-title') || { textContent: '' }).textContent.trim() === 'Oral practice';
  results['头像按钮存在'] = document.querySelector('#avatarBtn') !== null;
  results['首页进度条按目标'] = /今日目标/.test((document.querySelector('#view .progress-wrap') || { textContent: '' }).textContent);
  results['底部图标已更新'] = (document.querySelector('#tabbar .tab .ico') || { textContent: '' }).textContent.trim() === '🌱';
  const homeText = document.querySelector('#view').textContent;
  results['home 有「今日短句」'] = homeText.includes('今日短句');
  results['home 有「挑战长句」'] = homeText.includes('挑战长句');
  results['home 有「今日新词」'] = homeText.includes('今日新词');
  results['tabbar 按钮数'] = document.querySelectorAll('#tabbar .tab').length;
  results['home 句子卡片数'] = document.querySelectorAll('#view [data-open]').length;
  results['home 单词卡数'] = document.querySelectorAll('#view .word-card').length;

  const go = (h) => { window.location.hash = h; window.dispatchEvent(new window.Event('hashchange')); };
  go('#/library'); await sleep(80);
  results['library 渲染(搜索框+chips)'] = document.querySelector('#libSearch') !== null && document.querySelectorAll('#libFilter .chip').length;
  results['library 列表非空'] = (document.querySelector('#libList') || { textContent: '' }).textContent.length > 0;

  go('#/review'); await sleep(80);
  results['review 渲染'] = document.querySelector('#view').textContent.length > 0;

  go('#/stats'); await sleep(80);
  results['stats 渲染'] = document.querySelector('#view').textContent.length > 10;

  go('#/more'); await sleep(80);
  results['more 有字幕导入区'] = document.querySelector('#subText') !== null && document.querySelector('#btnImportSub') !== null;
  results['设备使用说明双 tab'] = document.querySelectorAll('#helpSeg button').length === 2;
  const sGoal = document.querySelector('#sentenceGoal'), wGoal = document.querySelector('#wordGoal');
  results['句子/单词目标滑块'] = !!sGoal && !!wGoal && sGoal.max === '100' && wGoal.max === '100';
  try {
    sGoal.value = 33; sGoal.dispatchEvent(new window.Event('input'));
    results['目标滑块可修改'] = document.querySelector('#sentenceGoalVal').textContent === '33';
    sGoal.value = 20; sGoal.dispatchEvent(new window.Event('input'));
  } catch (e) { results['目标滑块可修改'] = false; errors.push('goal slider: ' + e.message); }
  try {
    const androidBtn = document.querySelector('#helpSeg button[data-p="android"]');
    androidBtn.click(); await sleep(30);
    results['说明 tab 可切换'] = document.querySelector('#helpSteps').textContent.indexOf('Chrome') > -1
      && document.querySelector('#helpSeg button[data-p="android"]').classList.contains('on');
  } catch (e) { results['说明 tab 可切换'] = false; errors.push('help tab: ' + e.message); }

  // 字幕解析（标准 SRT：条目间空行；验证 en/zh 分离与 source 透传）
  try {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nI really like this show a lot.\n我真的非常喜欢这个节目\n\n2\n00:00:03,500 --> 00:00:05,000\nThe acting was amazing.\n表演太精彩了';
    const parsed = window.parseSubtitles(srt, 'test.srt');
    const ok = parsed.length === 2 && parsed.every(p => p.en && p.zh && p.source === 'test.srt');
    results['字幕解析(SRT 双语 2 条)'] = ok;
  } catch (e) { results['字幕解析(SRT 双语 2 条)'] = false; errors.push('parseSubtitles: ' + e.message); }

  // 打开跟读弹层 → 模拟录音 → 音素反馈 → 关闭
  go('#/home'); await sleep(80);
  const firstCard = document.querySelector('#view [data-open]');
  results['打开跟读弹层'] = false;
  if (firstCard) {
    firstCard.click(); await sleep(60);
    results['打开跟读弹层'] = document.querySelector('#practiceRoot .en-line') !== null;
    results['弹层有开始跟读按钮'] = document.querySelector('#btnRec') !== null;
    results['弹层有学习进度条'] = document.querySelector('#practiceRoot .prac-prog .bar > i') !== null
      && /第\s*\d+\s*\/\s*\d+\s*句/.test((document.querySelector('.prac-prog .pp-head')||{textContent:''}).textContent);
    results['弹层有双模式切换'] = document.querySelectorAll('#modeSeg button').length === 2;
    try {
      const listenBtn = document.querySelector('#modeSeg button[data-v="listen"]');
      listenBtn.click(); await sleep(30);
      results['模式可切到先听后读'] = document.querySelector('#modeSeg button[data-v="listen"]').classList.contains('on')
        && /听后跟读/.test(document.querySelector('#btnRec').textContent);
      document.querySelector('#modeSeg button[data-v="direct"]').click(); await sleep(30);
    } catch (e) { results['模式可切到先听后读'] = false; errors.push('mode switch: ' + e.message); }
    try {
      const before = document.querySelector('#pracEn').textContent.trim();
      const nextBtn = document.querySelector('#ppNext');
      results['有下一句按钮'] = !!nextBtn && !nextBtn.disabled;
      nextBtn.click(); await sleep(60);
      const after = document.querySelector('#pracEn').textContent.trim();
      results['下一句可切换句子'] = after !== before && document.querySelector('#practiceRoot .prac-prog') !== null;
      const prevBtn = document.querySelector('#ppPrev');
      if (prevBtn && !prevBtn.disabled) { prevBtn.click(); await sleep(40); }
      results['上一句可回退'] = document.querySelector('#pracEn').textContent.trim() === before;
    } catch (e) { errors.push('nav flow: ' + e.message); }
    try {
      const rec = document.querySelector('#btnRec');
      rec.click(); await sleep(120);
      const resEl = document.querySelector('#result');
      results['录音后结果渲染'] = resEl && resEl.classList.contains('show');
      results['结果显示分数环'] = !!document.querySelector('#result .score-ring');
      results['结果显示词高亮'] = document.querySelectorAll('#pracEn .wtok').length;
      results['结果页有下一句按钮'] = document.querySelector('#btnNext') !== null;
    } catch (e) { errors.push('record flow: ' + e.message); }
    const closeBtn = document.querySelector('#pracClose');
    if (closeBtn) { closeBtn.click(); await sleep(60); }
    results['关闭弹层'] = document.querySelector('#practiceRoot .en-line') === null;
  }

  console.log('================ 冒烟测试结果 ================');
  for (const [k, v] of Object.entries(results)) console.log('  ' + k + ':', JSON.stringify(v));
  if (scriptErrors.length) console.log('\n❌ 脚本运行时错误:', scriptErrors);
  if (consoleErrors.length) console.log('\n⚠️ console.error 记录:', consoleErrors);
  if (errors.length) console.log('\n❌ 测试流程错误:', errors);

  const pass = scriptErrors.length === 0 && errors.length === 0 &&
    results['home 有「今日短句」'] === true &&
    results['tabbar 按钮数'] === 5 &&
    results['字幕解析(SRT 双语 2 条)'] === true &&
    results['打开跟读弹层'] === true &&
    results['录音后结果渲染'] === true;
  console.log('\n总体: ' + (pass ? '✅ PASS' : '❌ FAIL'));
  window.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
