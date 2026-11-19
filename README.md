# 英语口语教练 · 跟读纠音

个人自用的英语口语跟读练习网站。**纯静态 + GitHub Actions 每日自动更新，无后端、无 Supabase、零运行依赖**，部署在 GitHub Pages 即可在手机上（iOS Safari / 走流量）顺畅使用并录音。

> 设计目标：每天 15~30 分钟，20 个短句（总词量 ≥200）+ 2~3 个 30+ 词长句 + 10 个 COCA 高频新词；跟读后逐词纠音、定位到具体发音不准的音素。

---

## 功能

- **每日计划**：20 短句 + 2~3 长句 + 10 新词，云端每天北京时间 06:00 自动更新，近 30 天不重复。
- **跟读纠音**：浏览器语音识别（webkitSpeechRecognition）→ 词级对齐 → **IPA 音素级反馈**：
  - 对读错的词，用 LCS 对齐目标音标与实际听到的音标，高亮出**具体是哪个音素读偏了**（如 *think* 读成 *sink*，会标出 `/θ/`）。
  - 针对中式发音的高危音素给出中文提示（th、ʃ/ʒ、ɜː、词尾 l/r、v/b、词尾辅音、双元音等）。
- **内容来源**（全部免费、无需 key）：
  - BBC World News（时政要闻）
  - Wikipedia「On This Day」（每日不同）
  - Project Gutenberg 公版名著（按日期轮换书目）
  - ZenQuotes（名言兜底）
  - 美剧/影视字幕：自己导入 `.srt / .ass / .vtt`，自动解析成中英配对句。
- **词库**：COCA 高频词 4380 个（含音标 + 中文释义），每日轮转 10 个新词。
- **其他**：美/英口音示范朗读、语速调节、进度与达标统计、待复习列表、PWA（可添加到主屏）。

---

## 目录结构

```
index.html                  单文件前端应用（含全部 UI 与逻辑）
manifest.json               PWA 清单
icons/                      图标（纯 Node 生成）
app.js                      本地静态服务器（零依赖，仅本地预览用）
启动.bat                    一键本地预览
package.json                脚本入口（无运行时依赖）
data/
  corpus.json               全量句库（Actions 每日增量合并）
  words.json                COCA 高频词库（音标 + 中文）
  served.json               近 30 天已用句台账（去重）
  today-YYYY-MM-DD.json     每日计划（前端按日期加载，带回退）
scripts/
  build-daily.mjs           每日内容生成（Actions 调用）
  build-words.mjs           生成 words.json（COCA + ECDICT，按需重建）
  gen-icons.mjs             生成图标 PNG
  smoke-test.cjs            前端冒烟测试（jsdom 无头渲染，开发/CI 用）
  COCA_Top5000.csv          COCA 词频表（随仓库提交）
  ecdict.csv                词典缓存（.gitignore，约 66MB，自动下载）
.github/workflows/
  daily-content.yml         每日定时抓取 + 提交
  ci.yml                    每次 push/PR 运行冒烟测试
```

---

## 本地运行

```bash
# 无需 npm install（零依赖），直接：
node app.js
# 打开 http://localhost:4321
```

或双击 `启动.bat`。

> 本地预览跟读录音：浏览器需允许麦克风，且 iOS 需在 设置 › 通用 › 键盘 › 听写 开启「英语(美国)」。

---

## 测试（开发/CI 用）

```bash
npm install        # 仅安装 jsdom（开发依赖，不影响零依赖运行）
npm test           # 运行 scripts/smoke-test.cjs：jsdom 无头渲染 5 个 Tab + 跟读纠音流程
```

冒烟测试会校验：页面初始化无运行时错误、5 个 Tab 全部渲染、跟读弹层可开可关、录音→音素反馈不抛错、字幕 SRT 双语解析正确。每次 push/PR 由 `ci.yml` 自动运行；未装 jsdom 时本地会优雅跳过。

---

## 部署到 GitHub Pages（推荐，手机端可用）

1. 把本目录推到你的 GitHub 仓库（例如 `jorgegege/oral-enpractice`）。
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**（或 main 分支根目录）。
3. 工作流 `daily-content.yml` 已配置 `permissions: contents: write`，每天 UTC 22:00（北京 06:00）自动运行 `build-daily.mjs` 并提交回仓库，网站内容随之更新。

> 首次推送后，可在 Actions 页面手动点一次 **Run workflow** 立即生成当天内容并验证提交链路。

---

## 数据文件约定

- `today-<日期>.json`：`{ date, short:[20], long:[2~3], words:[10], meta }`，每句 `{id,en,zh,cat,level,note}`。
- 前端加载顺序：`today-<今天>` → 昨天 → 前天 → **本地用 corpus 兜底生成**（保证 Actions 未跑/断网也能用）。
- 句子 `id` = `'s' + 归一化文本 hash`，跨更新稳定，用于去重与进度记录。
- 进度 / 设置 / 字幕导入都存浏览器 `localStorage`，不上传。

---

## 重建词库（一般不需要）

`words.json` 已随仓库提交，日常无需重建。若需更新：

```bash
node scripts/build-words.mjs
# 会自动下载 ECDICT（约 66MB，缓存到 scripts/ecdict.csv）并重新生成 data/words.json
```

---

## 关于版权

本工具仅供个人学习自用。内容来源均为公开/公版资源（BBC 新闻标题与摘要、维基百科、公版名著、名言），字幕为用户自行导入的本人使用素材。请尊重各来源的版权与使用条款。
