// 英语口语教练 · 前端冒烟测试（开发/CI 用，非运行时依赖）
// 用法：npm install 后 `node scripts/smoke-test.cjs`（或 `npm test`）
// 作用：用 jsdom 无头加载 index.html，验证页面初始化无运行时错误、
//       4 个 Tab（统计已并入今日页）、跟读弹层可开可关、录音→音素反馈流程不抛错、
//       日历/已学内容/数字目标/英文日期等新结构正确。
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
  results['英文日期时间'] = /\w{3}, \w{3} \d{1,2}, \d{4} · \d{1,2}:\d{2} (AM|PM)/.test(results['headerDate']);
  results['右上角头像按钮'] = document.querySelector('.head-user #avatarBtn') !== null;
  results['右上角用户ID可编辑'] = document.querySelector('#headUser #uidName') !== null;
  results['默认头像为图片'] = document.querySelector('#avatarBtn img[src="assets/avatar-default.png"]') !== null;
  results['默认ID为Charlie'] = document.querySelector('#uidName')?.textContent.trim() === 'Charlie';
  results['开始学习卡片'] = document.querySelector('#view .start-hero #btnStartLearn') !== null
    && /Today's Practice/.test(document.querySelector('#view .start-hero').textContent);
  results['开始学习进度按目标'] = /目标|已达标/.test((document.querySelector('#view .sh-meta') || { textContent: '' }).textContent);
  results['底部图标为4只不同小鸟'] = ['home','library','review','more'].every(n =>
    document.querySelector(`#tabbar .tab[data-r="${n}"] .ico img.ico-color[src="assets/tab-${n}.png"]`) !== null)
    && new Set(['home','library','review','more'].map(n =>
      document.querySelector(`#tabbar .tab[data-r="${n}"] .ico img.ico-color`)?.getAttribute('src'))).size === 4;
  results['底部图标含线条版与彩色版'] = ['home','library','review','more'].every(n =>
    document.querySelector(`#tabbar .tab[data-r="${n}"] .ico img.ico-line[src="assets/tab-${n}-line.png"]`) !== null
    && document.querySelector(`#tabbar .tab[data-r="${n}"] .ico img.ico-color`) !== null);
  const homeText = document.querySelector('#view').textContent;
  results['home 有「开始学习」'] = homeText.includes('开始学习');
  results['home 有「练习天数」'] = homeText.includes('练习天数') && document.querySelectorAll('#view .cal-grid .cal-day').length > 0;
  results['统计条含今日达标数量'] = document.querySelector('#view #todayPassedNum') !== null
    && homeText.includes('今日达标') && homeText.includes('累计达标');
  results['日历打卡图标已放大'] = /\.cal-day \.cd-logo\{width:19px;height:19px/.test(html)
    && /\.cal-legend img\{width:14px;height:14px/.test(html);
  results['连续打卡横幅存在'] = document.querySelector('#view #streakBanner .sb-flame') !== null
    && /连续 \d+ 天/.test((document.querySelector('#view #streakBanner .sb-num')||{textContent:''}).textContent);
  results['home 有「已学内容」'] = homeText.includes('已学内容') && document.querySelector('#view #btnLearned') !== null;
  results['home 有「今日短句」'] = homeText.includes('今日短句') && document.querySelector('#view #shortFold') && document.querySelector('#view #shortFoldBody') !== null;
  results['home 有「挑战长句」'] = homeText.includes('挑战长句') && document.querySelector('#view #longFold') && document.querySelector('#view #longFoldBody') !== null;
  results['短句长句默认折叠且可展开'] = [['#shortFold','#shortFoldBody'],['#longFold','#longFoldBody']].every(([ts,bs]) => {
    const t = document.querySelector('#view '+ts), b = document.querySelector('#view '+bs);
    if(!t || !b || b.classList.contains('open')) return false;
    t.click();
    const ok = b.classList.contains('open') && t.classList.contains('open')
      && t.getAttribute('aria-expanded') === 'true'
      && t.querySelector('.fold-hint-label').textContent === '收起';
    t.click();
    return ok && !b.classList.contains('open');
  });
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

  results['统计 tab 已移除'] = ![...document.querySelectorAll('#tabbar .tab')].some(b => b.dataset.r === 'stats');
  const homeHashGo = (h) => { window.location.hash = h; window.dispatchEvent(new window.Event('hashchange')); };
  homeHashGo('#/stats'); await sleep(50);
  results['stats 路由回退到今日'] = document.querySelector('#view .start-hero') !== null;

  go('#/more'); await sleep(80);
  results['more 有字幕导入区'] = document.querySelector('#subText') !== null && document.querySelector('#btnImportSub') !== null;
  results['设备使用说明双 tab'] = document.querySelectorAll('#helpSeg button').length === 2;
  results['设备说明默认折叠'] = document.querySelector('#helpFold') !== null
    && !document.querySelector('#helpFoldBody').classList.contains('open')
    && document.querySelector('#helpFold .fold-hint-label').textContent === '展开';
  try {
    document.querySelector('#helpFold').click(); await sleep(50);
    results['设备说明可展开'] = document.querySelector('#helpFoldBody').classList.contains('open')
      && document.querySelector('#helpFold').getAttribute('aria-expanded') === 'true'
      && document.querySelector('#helpFold .fold-hint-label').textContent === '收起';
    document.querySelector('#helpFold').click(); await sleep(50);
    results['设备说明可收起'] = !document.querySelector('#helpFoldBody').classList.contains('open');
  } catch (e) { results['设备说明可展开'] = false; errors.push('help fold: ' + e.message); }
  results['学习提醒设置区存在'] = document.querySelector('#segRemind') !== null
    && document.querySelector('#remindTime') !== null && document.querySelector('#btnNotify') !== null;
  results['提醒默认开启且时间21:00'] = document.querySelector('#segRemind button[data-v="1"]').classList.contains('on')
    && document.querySelector('#remindTime').value === '21:00';
  try {
    document.querySelector('#segRemind button[data-v="0"]').click(); await sleep(50);
    results['提醒可关闭'] = document.querySelector('#segRemind button[data-v="0"]').classList.contains('on');
    document.querySelector('#segRemind button[data-v="1"]').click(); await sleep(50);
    results['提醒可重新开启'] = document.querySelector('#segRemind button[data-v="1"]').classList.contains('on');
  } catch (e) { results['提醒可关闭'] = false; errors.push('remind toggle: ' + e.message); }
  results['夜间模式设置区存在'] = document.querySelector('#segTheme') !== null
    && document.querySelector('#segTheme button[data-v="0"]').classList.contains('on');
  try {
    document.querySelector('#segTheme button[data-v="1"]').click(); await sleep(50);
    results['夜间模式可开启'] = document.documentElement.classList.contains('dark')
      && document.querySelector('#segTheme button[data-v="1"]').classList.contains('on');
    document.querySelector('#segTheme button[data-v="0"]').click(); await sleep(50);
    results['夜间模式可关闭'] = !document.documentElement.classList.contains('dark');
  } catch (e) { results['夜间模式可开启'] = false; errors.push('theme toggle: ' + e.message); }
  results['主题配色有 5 套色块且默认绿选中'] = document.querySelectorAll('#themeSwatches .theme-swatch').length === 5
    && document.querySelector('#themeSwatches .theme-swatch[data-k="green"]').classList.contains('on');
  try {
    document.querySelector('#themeSwatches .theme-swatch[data-k="rose"]').click(); await sleep(50);
    results['主题可切换到粉色'] = document.documentElement.getAttribute('data-theme') === 'rose'
      && document.querySelector('#themeSwatches .theme-swatch[data-k="rose"]').classList.contains('on')
      && !document.querySelector('#themeSwatches .theme-swatch[data-k="green"]').classList.contains('on');
    document.querySelector('#themeSwatches .theme-swatch[data-k="blue"]').click(); await sleep(50);
    results['主题可切换到蓝色'] = document.documentElement.getAttribute('data-theme') === 'blue';
    document.querySelector('#themeSwatches .theme-swatch[data-k="green"]').click(); await sleep(50);
    results['主题可切回绿色'] = document.documentElement.getAttribute('data-theme') === 'green';
  } catch (e) { results['主题可切换到粉色'] = false; errors.push('theme color switch: ' + e.message); }
  results['朗读声音/音调设置存在'] = document.querySelector('#voiceSelect') !== null
    && document.querySelector('#btnVoiceTest') !== null && document.querySelector('#pitchRange') !== null
    && Number(document.querySelector('#pitchRange').value) === 1;
  results['人名发音修正入口已移除'] = document.querySelector('#nfFrom') === null
    && document.querySelector('#nameFixList') === null && !html.includes('NAME_FIX_BUILTIN');
  try {
    const fixed = window.eval('speechText("Hi GEORGE, how are you?")');
    results['全大写仍自动归一化'] = /George/.test(fixed) && !/GEORGE/.test(fixed);
    const parts = window.eval('splitForSpeech(\'Hi, I am fine. Thank you!\')');
    results['朗读按标点分句'] = Array.isArray(parts) && parts.length === 3;
  } catch (e) { results['全大写仍自动归一化'] = false; errors.push('speechText: ' + e.message); }
  try {
    const box = document.createElement('div');
    box.innerHTML = window.eval('wordSpans("Hi, Jorge!  Nice to meet you.")');
    const words = [...box.querySelectorAll('.wtok-click')];
    results['句子单词可点读且标点不送入发音'] = words.length === 6
      && words[0].getAttribute('data-say') === 'Hi'
      && words[1].getAttribute('data-say') === 'Jorge'
      && words.every(w => !/[,!.]/.test(w.getAttribute('data-say')));
    results['点词提示与高亮样式存在'] = html.includes('word-tap-tip') && html.includes('.wtok-click.speaking');
  } catch (e) { results['句子单词可点读且标点不送入发音'] = false; errors.push('wordSpans: ' + e.message); }
  try {
    const a = window.eval("alignWords('Now you see me. George thinks he will.', 'now you see me thinks he will')");
    const score = window.eval("scoreOf(alignWords('Now you see me. George thinks he will.', 'now you see me thinks he will'))");
    results['人名不计入正确率'] = a.ignoredCount === 1 && a.scoredCount === 7
      && a.matchCount === 7 && score === 100 && a.target.some(t => t.word === 'george' && t.state === 'ignore');
    const b = window.eval("alignWords('We hold these Rights and Happiness.', 'we hold these rights and happiness')");
    results['普通词不被误判为人名'] = b.ignoredCount === 0 && b.scoredCount === 6;
    const c = window.eval("alignWords('This is Charlie here.', 'this is here')");
    results['用户昵称按人名忽略'] = c.ignoredCount === 1 && c.scoredCount === 3
      && c.matchCount === 3 && c.extras.length === 0;
  } catch (e) { results['人名不计入正确率'] = false; errors.push('name scoring: ' + e.message); }
  try {
    const sel = document.querySelector('#voiceSelect');
    if (sel.options.length > 1) {
      sel.value = sel.options[1].value; sel.dispatchEvent(new window.Event('change')); await sleep(30);
      document.querySelector('#segAccent button[data-v="US"]').click(); await sleep(60);
      results['朗读声音选择可持久化'] = document.querySelector('#voiceSelect').value === sel.options[1].value;
      document.querySelector('#voiceSelect').value = '';
      document.querySelector('#voiceSelect').dispatchEvent(new window.Event('change'));
    } else {
      results['朗读声音选择可持久化'] = true; // jsdom 环境只有一个模拟声音
    }
  } catch (e) { results['朗读声音选择可持久化'] = false; errors.push('voice select: ' + e.message); }
  results['音源切换入口存在且默认系统语音'] = document.querySelectorAll('#segTtsSource button').length === 3
    && document.querySelector('#segTtsSource button[data-v="system"]').classList.contains('on')
    && document.querySelector('#voiceSelect') !== null;
  try {
    document.querySelector('#segTtsSource button[data-v="online"]').click(); await sleep(60);
    results['在线自然音可切换'] = document.querySelector('#segOnlineVoice') !== null
      && document.querySelector('#voiceSelect') === null
      && /fanyi\.baidu\.com\/gettts/.test(window.eval('ttsUrlFor("Hi Jorge.")'));
    document.querySelector('#segOnlinePreset button[data-v="youdao"]').click(); await sleep(60);
    results['在线服务可切换'] = document.querySelector('#segOnlinePreset button[data-v="youdao"]').classList.contains('on')
      && /dict\.youdao\.com/.test(window.eval('ttsUrlFor("Hi")'));
    document.querySelector('#segOnlinePreset button[data-v="baidu"]').click(); await sleep(60);
    document.querySelector('#segOnlineVoice button[data-v="1"]').click(); await sleep(60);
    results['在线音色可切换'] = document.querySelector('#segOnlineVoice button[data-v="1"]').classList.contains('on')
      && /spd=1/.test(window.eval('ttsUrlFor("Hi")'));
    document.querySelector('#segTtsSource button[data-v="custom"]').click(); await sleep(60);
    const cu = document.querySelector('#customTtsUrl');
    results['自定义音源输入框存在'] = !!cu && cu.type === 'url';
    cu.value = 'https://example.com/tts?voice=aria&text={text}';
    cu.dispatchEvent(new window.Event('change')); await sleep(30);
    results['自定义音源URL可保存并生成'] = window.eval('ttsUrlFor("Hello there")') === 'https://example.com/tts?voice=aria&text=Hello%20there';
    document.querySelector('#segTtsSource button[data-v="system"]').click(); await sleep(60);
    results['可切回系统语音'] = document.querySelector('#segTtsSource button[data-v="system"]').classList.contains('on')
      && document.querySelector('#voiceSelect') !== null;
  } catch (e) { results['在线自然音可切换'] = false; errors.push('tts source: ' + e.message); }
  results['本地识别开关与预下载按钮存在'] = document.querySelector('#segLocalAsr') !== null
    && document.querySelector('#asrStatus') !== null && document.querySelector('#btnAsrPrefetch') !== null;
  results['本地识别默认开启'] = document.querySelector('#segLocalAsr button[data-v="1"]').classList.contains('on');
  try {
    document.querySelector('#segLocalAsr button[data-v="0"]').click(); await sleep(50);
    results['本地识别可关闭'] = document.querySelector('#segLocalAsr button[data-v="0"]').classList.contains('on');
    document.querySelector('#segLocalAsr button[data-v="1"]').click(); await sleep(50);
    results['本地识别可重新开启'] = document.querySelector('#segLocalAsr button[data-v="1"]').classList.contains('on');
  } catch (e) { results['本地识别可关闭'] = false; errors.push('localAsr toggle: ' + e.message); }
  const sGoal = document.querySelector('#sentenceGoal'), wGoal = document.querySelector('#wordGoal');
  const passEl = document.querySelector('#passScore');
  results['达标分数输入框默认80且为数字'] = !!passEl && passEl.type === 'number' && passEl.min === '0'
    && passEl.max === '100' && Number(passEl.value) === 80;
  try {
    passEl.value = '90'; passEl.dispatchEvent(new window.Event('change'));
    results['达标分数可修改'] = Number(passEl.value) === 90;
    passEl.value = '80'; passEl.dispatchEvent(new window.Event('change'));
  } catch (e) { results['达标分数可修改'] = false; errors.push('passScore input: ' + e.message); }
  results['句子/单词目标为数字输入框'] = !!sGoal && !!wGoal && sGoal.type === 'number' && wGoal.type === 'number'
    && sGoal.min === '0' && sGoal.max === '100' && wGoal.min === '0' && wGoal.max === '100';
  try {
    sGoal.value = '33'; sGoal.dispatchEvent(new window.Event('change'));
    results['数字目标可修改'] = Number(sGoal.value) === 33;
    sGoal.value = '999'; sGoal.dispatchEvent(new window.Event('change'));
    results['数字目标上限校验'] = Number(sGoal.value) === 100;
    sGoal.value = '20'; sGoal.dispatchEvent(new window.Event('change'));
  } catch (e) { results['数字目标可修改'] = false; errors.push('goal input: ' + e.message); }
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
    results['练习句单词可点读'] = document.querySelectorAll('#pracEn .wtok-click').length > 0
      && /点句中任意单词/.test((document.querySelector('.word-tap-tip')||{textContent:''}).textContent);
    try {
      const listenBtn = document.querySelector('#modeSeg button[data-v="listen"]');
      listenBtn.click(); await sleep(30);
      results['模式可切到先听后读'] = document.querySelector('#modeSeg button[data-v="listen"]').classList.contains('on')
        && /听后跟读/.test(document.querySelector('#btnRec').textContent);
      document.querySelector('#modeSeg button[data-v="direct"]').click(); await sleep(30);
    } catch (e) { results['模式可切到先听后读'] = false; errors.push('mode switch: ' + e.message); }
    try {
      results['弹层有跳过按钮'] = document.querySelector('#btnSkip') !== null
        && /不计入今日学习/.test((document.querySelector('#btnSkip')||{textContent:''}).textContent);
      const beforeSkip = document.querySelector('#pracEn').textContent.trim();
      document.querySelector('#btnSkip').click(); await sleep(60);
      const afterSkip = document.querySelector('#pracEn').textContent.trim();
      results['跳过后推进到下一句'] = afterSkip !== beforeSkip;
      const prevBtn0 = document.querySelector('#ppPrev');
      if (prevBtn0 && !prevBtn0.disabled) { prevBtn0.click(); await sleep(40); }
    } catch (e) { results['弹层有跳过按钮'] = false; errors.push('skip flow: ' + e.message); }
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
      results['结果页词高亮仍可点读'] = document.querySelectorAll('#pracEn .wtok.wtok-click').length
        === document.querySelectorAll('#pracEn .wtok').length;
      results['结果页有下一句按钮'] = document.querySelector('#btnNext') !== null;
      results['结果页有回放我的按钮'] = document.querySelector('#btnPlayMine') !== null
        && !!document.querySelector('.replay-tip');
    } catch (e) { errors.push('record flow: ' + e.message); }
    const closeBtn = document.querySelector('#pracClose');
    if (closeBtn) { closeBtn.click(); await sleep(60); }
    results['关闭弹层'] = document.querySelector('#practiceRoot .en-line') === null;
    const homeWord = document.querySelector('#view .sentence-en .wtok-click');
    if (homeWord) {
      homeWord.click(); await sleep(50);
      results['点单词不误开练习弹层'] = document.querySelector('#practiceRoot .en-line') === null;
    }
  }

  // 已学内容弹层（录音后已有 progress 记录）
  go('#/home'); await sleep(80);
  const learnedBtn = document.querySelector('#btnLearned');
  if (learnedBtn) {
    learnedBtn.click(); await sleep(60);
    results['已学内容弹层可打开'] = document.querySelector('#learnedRoot').classList.contains('show')
      && document.querySelectorAll('#learnedRoot .lr-item').length > 0;
    const lc = document.querySelector('#learnedClose');
    if (lc) { lc.click(); await sleep(40); }
    results['已学内容弹层可关闭'] = !document.querySelector('#learnedRoot').classList.contains('show');
  }

  console.log('================ 冒烟测试结果 ================');
  for (const [k, v] of Object.entries(results)) console.log('  ' + k + ':', JSON.stringify(v));
  if (scriptErrors.length) console.log('\n❌ 脚本运行时错误:', scriptErrors);
  if (consoleErrors.length) console.log('\n⚠️ console.error 记录:', consoleErrors);
  if (errors.length) console.log('\n❌ 测试流程错误:', errors);

  const pass = scriptErrors.length === 0 && errors.length === 0 &&
    results['tabbar 按钮数'] === 4 &&
    results['英文日期时间'] === true &&
    results['开始学习卡片'] === true &&
    results['home 有「练习天数」'] === true &&
    results['home 有「已学内容」'] === true &&
    results['数字目标可修改'] === true &&
    results['统计 tab 已移除'] === true &&
    results['字幕解析(SRT 双语 2 条)'] === true &&
    results['打开跟读弹层'] === true &&
    results['录音后结果渲染'] === true &&
    results['已学内容弹层可打开'] === true;
  console.log('\n总体: ' + (pass ? '✅ PASS' : '❌ FAIL'));
  window.close();
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
