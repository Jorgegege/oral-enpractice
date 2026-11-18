# 英语口语每日练习

> 想让手机在外网（流量）也能用？看 [DEPLOY.md](./DEPLOY.md) 云端部署指南。

## 目录结构
```
oral-practice-server/
├─ app.js            # Express 后端：语料接口（Supabase 优先，本地 json 兜底）、今日计划、状态持久化
├─ package.json      # 依赖声明（含 @supabase/supabase-js）
├─ fetch-quotes.js   # 抓取脚本：公开语录源 → 清洗去重 → 写入 Supabase records 表
├─ sentences.json    # 本地兜底语料 / 首次导入 Supabase 的数据源
├─ .github/workflows/ # GitHub Actions 每日定时抓取配置
├─ data/             # 运行后自动生成，store.json 保存学习记录（无需手动建）
└─ public/
    └─ index.html    # 前端页面（绿色主题、朗读变色、语音识别、收藏/错题/统计）
```

## 本地运行（Windows / Mac 通用）
**Windows 最简单方式**：双击文件夹里的 `启动.bat`，会自动安装依赖（仅首次）、启动服务并打开浏览器。

手动命令方式：
1. 装好 Node.js（已装可跳过，`node -v` 能看到版本号即可）。
2. 在项目文件夹打开终端（PowerShell / CMD / Terminal）。
3. 安装依赖（只需第一次）：
   ```
   npm install
   ```
4. （对接 Supabase 时）先设置凭证环境变量，再启动；不设置则自动回退读取本地 `sentences.json`：
   ```powershell
   # Windows PowerShell
   $env:SUPABASE_URL="https://xxx.supabase.co"
   $env:SUPABASE_ANON_KEY="xxx"
   npm start
   ```
   ```bash
   # Mac / Linux
   SUPABASE_URL="https://xxx.supabase.co" SUPABASE_ANON_KEY="xxx" npm start
   ```
5. 浏览器打开：http://localhost:3000

> 关闭终端窗口（或黑窗口）服务就会停止；停止服务按 `Ctrl + C`。
> 注意：本地版本必须先启动后端才能使用，后端不开网页拿不到句子、也存不了记录。

## 扩充句子
编辑 `sentences.json`，按现有格式追加条目，保存后重启服务（`Ctrl + C` 后再 `npm start`）生效。

字段说明：
- `en`：英文句子（必填）
- `zh`：中文翻译
- `cat`：分类，可选 `daily / usshow / ukshow / literature / animation / business / passage / long`
- `level`：难度，可选 `A2 / B1 / B2`
- `kind`：留空为短句；`long` 为中长句；`passage` 为长段落
- `tags / note / source`：标签、发音提示、来源标注（可选）

## 自动聚合英文语录（Supabase 存储）

`fetch-quotes.js` 是零依赖的 Node 脚本，从公开、免费、无需登录的语录源抓取句子，清洗去重后写入 **Supabase `records` 表**（整条句子存在 `data` jsonb 字段）。去重基于云端现有句子，重复运行只补新句。

### 1. 配置凭证（环境变量）
- `SUPABASE_URL`：项目地址，如 `https://xxx.supabase.co`
- `SUPABASE_ANON_KEY`：anon / publishable key（`sb_publishable_` 开头）

本地临时设置：
```bash
# Mac / Linux
SUPABASE_URL="https://xxx.supabase.co" SUPABASE_ANON_KEY="xxx" node fetch-quotes.js --dry-run

# Windows PowerShell
$env:SUPABASE_URL="https://xxx.supabase.co"; $env:SUPABASE_ANON_KEY="xxx"; node fetch-quotes.js --dry-run
```

### 2. 常用命令
```bash
node fetch-quotes.js --dry-run        # 预览将入库的句子，不写入（先跑这个）
node fetch-quotes.js                  # 抓取公开源新句，去重后写入 Supabase
node fetch-quotes.js --import-local   # 首次迁移：把本地 sentences.json 导入 Supabase（自动去重）
node fetch-quotes.js --limit 30       # 每个来源最多取 30 条候选
```

### 3. 定时自动抓取（GitHub Actions）
`.github/workflows/daily-fetch.yml` 每天定时跑一次抓取脚本：
1. 把项目推到 GitHub 仓库。
2. 仓库 **Settings → Secrets and variables → Actions**，新增 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 两个 Secret。
3. Actions 页面对应 workflow 会按计划自动运行；也可手动点 **Run workflow** 立即触发。

### 规则与说明
- **已接入来源**：ZenQuotes、DummyJSON，均为公版名人语录；不抓取教材、新闻正文等受版权保护内容。
- **清洗规则**：去 HTML 标签/实体；按词数过滤；硬禁词过滤；Title Case 规整；云端 + 本次批次双重去重；按词数粗分 A2/B1/B2。
- **新增条目字段**：`cat=literature`、`tags=["quote"]`、`author`、`source`；`zh` 暂留空。
- **频率**：每天最多一次；脚本单批请求、自带超时与重试。
- **注意**：当前后端 `app.js` 仍读本地 `sentences.json`；改为从 Supabase 读取是下一步工作，本次仅完成抓取入库与定时配置。

## 接口
- `GET /api/all`：全量词库
- `GET /api/today`：后端按日期种子算好的今日 20 句（15 短 + 5 长）与去重词数
- `GET /api/state`：读取持久化的学习状态（收藏 / 错题 / 历史 / 分钟数 / 导入句 / 设置）
- `PUT /api/state`：整份保存学习状态

## 数据持久化
收藏、错题、练习历史、分钟数、导入句子和设置会自动保存到后端 `data/store.json`，**重启服务、关掉终端都不会丢失**。前端同时也写一份浏览器本地缓存。若要清空记录，在页面「更多 → 恢复出厂」操作即可。

## 已知限制
- 持久化用本地 JSON 文件（单用户本地使用）；如果以后要多用户、多设备同步，再换 SQLite / 数据库。
- 自动抓取仅接入公开免费的公版语录 API；不抓取新闻、教材、影视剧本等受版权保护的正文。语录中文翻译留空，后续可另行补充。
- 手机 iOS 网页语音识别受浏览器/系统限制，个别句子可能识别不稳，稳定打分建议用电脑 Chrome / Safari。
