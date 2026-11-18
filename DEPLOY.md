# 云端部署指南（手机流量 / 外网均可访问）

部署后会得到一个公网网址，手机用流量或 WiFi 都能打开；后端从 Supabase 读取句子库，电脑不用一直开机。

## 架构说明
- **数据库**：句子存在 Supabase `records` 表（已导入 263 条，GitHub Actions 每日自动补新句）。
- **后端 + 页面**：本项目（Express）部署到云端平台，提供网页和 `/api/all`、`/api/state` 接口。
- **学习记录**：收藏 / 错题 / 历史优先存手机浏览器 localStorage；云端后端的本地文件在免费平台重启后会清空，不影响手机端已保存的记录。

## 一、把代码推到 GitHub
1. 新建一个 GitHub 仓库（Public 即可）。
2. 把 `oral-practice-server` 文件夹**里面的内容**传到仓库根目录（`app.js`、`package.json`、`public/`、`fetch-quotes.js`、`.github/` 等）。
   - 不要上传 `node_modules/`（`.gitignore` 已排除，平台会自动安装）。
   - 不要上传 `sentences.json.bak`、`data/`。
3. 推送后仓库根目录应能看到 `package.json` 和 `app.js`。

## 二、部署到 Render（推荐，免费、Node 原生）
1. 打开 https://render.com/ ，用 GitHub 账号登录。
2. 点 **New → Web Service**，选择刚上传的仓库。
3. 填写配置：
   - **Name**：自定义，如 `oral-practice`
   - **Runtime**：`Node`
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Plan**：`Free`
4. 展开 **Environment Variables**，添加两个：
   - `SUPABASE_URL` = 你的 Supabase 项目地址（https://xxx.supabase.co）
   - `SUPABASE_ANON_KEY` = 你的 anon / publishable key
5. 点 **Deploy Web Service**，等待构建完成。
6. 部署成功后得到公网地址，形如 `https://oral-practice.onrender.com`。
   - 手机浏览器直接打开即可；可在 Safari 里「添加到主屏幕」当 App 用。

## 三、验证
- 打开公网地址，页面能正常显示句子 = 后端已读到 Supabase。
- 可在浏览器访问 `https://你的地址/api/all`，应返回句子数组。
- Render 日志里出现 `· 语料来源：Supabase records 表` 即对接成功。

## 四、注意事项
- **免费版休眠**：Render 免费服务 15 分钟无访问会休眠，下次打开需等 10～30 秒冷启动；这是免费版通病，日常练习够用。
- **国内访问速度**：Render、Supabase 均为海外服务，国内直连可能偏慢；若打不开或很慢，再考虑换平台或加国内可访问的托管。
- **定时抓取**：`.github/workflows/daily-fetch.yml` 已配好，仓库 Actions 里每天自动跑；凭证存在仓库 Secrets（`SUPABASE_URL`、`SUPABASE_ANON_KEY`），与 Render 环境变量是两处，都要配。
- **不要把 anon key 写进前端代码或公开仓库**；它放在平台环境变量 / GitHub Secrets 中。

## 备选平台
- **Koyeb**：免费 1 个 Web 服务，空闲约 1 小时缩容；部署方式同样连 Git，Start Command 用 `npm start`。
- **Railway**：免费额度很小（约 $1/月 credit），只适合临时测试，难以 24 小时在线。
- **Vercel / Netlify**：serverless 架构，当前 Express 写法需要改成函数入口，改动较大，暂不推荐。
