# AcademicFlow-Worker

> **给 [AcademicFlow](https://nikki-su.github.io/AcademicFlow/) 用的 MinerU CORS 透传代理**
> 部署到你自己的 Cloudflare 账号，30 秒完事，永久免费。

## 为什么需要它？

AcademicFlow 是纯前端工具，你的数据只在你自己的浏览器里。但 [MinerU](https://mineru.net) 的 API 不允许浏览器直接调用（服务端不返回 CORS 头），所以我们需要一个「中转站」把浏览器请求转发到 MinerU。

**这个中转站部署在你自己的 Cloudflare 账号里，AcademicFlow 作者完全不接触。**

数据流：

```
你的浏览器  →  你的 Cloudflare Worker（纯转发，30 行代码）  →  mineru.net
                     ↑
              这个仓库，部署在你自己的 CF 账号
```

Worker 不缓存、不落盘、不记录任何请求。你可以在 `src/worker.js` 里亲眼确认这 30 行代码在做什么。

---

## 一键部署（30 秒）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nikki-SU/AcademicFlow-Worker)

**3 步流程：**

1. 点上面按钮 → Cloudflare 登录（没账号会引导注册，只需邮箱+密码，全免费）
2. 授权 CF 从这个 GitHub 仓库读取代码 → 页面自动 fork + 部署，你什么都不用配
3. 部署完成后，页面顶部会显示你的 Worker URL（长这样：`https://academicflow-worker.你的用户名.workers.dev`）
   - **复制这个 URL**，粘回 AcademicFlow 的 Settings → MinerU 代理 输入框
   - 前端会自动 ping 一下，绿色 ✓ 就是好了

**下次刷新网页也不用再配了**，URL 保存在你的浏览器本地（IndexedDB）。

---

## 免费额度够用吗？

Cloudflare Workers 免费版：
- **每天 10 万次请求**
- **每次请求 10ms CPU 时间**（纯转发用不到 1ms）

一篇论文的 MinerU 流程大约 10 次请求（上传+轮询+下载）。**每天能处理 1 万篇论文**，一个人这辈子都用不完。

超额了会怎样？Cloudflare 不会自动扣费，只会返回 429 让请求失败。你会知道，但不会掉钱。

---

## 我担心 Worker 被别人滥用怎么办？

- Worker 只转发 `/api/*` 路径的请求，别的路径直接 403
- URL 是随机域名 `xxx.workers.dev`，不主动公开就不会被扫到
- 真被人蹭用最多蹭掉你的免费额度（10 万/天），不产生费用

如果被滥用了想换 URL：CF 后台把这个 Worker 删了，重新点上面的一键部署按钮，粘新 URL 到 AcademicFlow 即可。

---

## 想自己改代码？

这仓库使用 MIT 协议，随便 fork 随便改。核心逻辑就 60 行，一目了然：`src/worker.js`。

改完之后：
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

---

## 隐私 & 责任

- **AcademicFlow 作者不接触任何请求**（这个 Worker 部署在你自己的 CF 账号，与作者完全无关）
- **Cloudflare 会看到请求**（转发经过 CF 网络是必然），但 CF 有自己的隐私声明，与作者无关
- **MinerU 会看到请求**（这本来就是你在调 MinerU），去 [mineru.net](https://mineru.net) 看他们的隐私政策

如果你对隐私要求极高，请自行审阅 `src/worker.js`（60 行）确认它真的什么都不做。

---

## LICENSE

MIT © 2026 [Nikki-SU](https://github.com/Nikki-SU)
