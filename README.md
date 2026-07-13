# AcademicFlow-Worker

MinerU HTTP API 的**透传代理**（无 CORS 头 → 浏览器直连挂）。同一份代码，两种 Runtime。

```
用户浏览器 (nikki-su.github.io/AcademicFlow)
       │
       ▼
用户自己部署的代理（Deno Deploy 或 Cloudflare Workers）
       │
       ▼
       mineru.net
```

- **不缓存、不落盘、不上报**：只做纯转发，作者不接触任何数据
- **凭证隔离**：MinerU token 在你浏览器 IndexedDB 里，请求经过你自己的代理
- **无环境变量**：部署即用，代理里没有任何 secret

---

## 选哪个方案？

| | 🇨🇳 Deno Deploy | 🌍 Cloudflare Workers |
|---|---|---|
| **国内直连** | ✅ 三大运营商基本可达 | ❌ workers.dev 一般挂，需代理 |
| **部署入口** | dash.deno.com（4 步网页配置） | Deploy Button 一键 |
| **免费额度** | 100k requests/day | 100k requests/day |
| **入口文件** | `src/deno.js` | `src/worker.js` |
| **推荐给** | 国内用户（默认） | 有代理 / 出海用户 |

两种方案都调用同一个 `src/core.js` 处理请求，功能 100% 等价，只差在跑在谁的机房。选一个部署即可。

---

## 方案 A：Deno Deploy 部署（国内用户，默认）

1. 打开 <https://dash.deno.com/new>
2. **Sign in with GitHub** → 授权 Deno Deploy 读取仓库
3. **Deploy from GitHub repository** → 搜索 `AcademicFlow-Worker` → 选中
   - **Entrypoint**：填 `src/deno.js`
   - **Install Step**：留空
   - **Build Step**：留空
4. 点 **Deploy Project** → 得到 `https://<项目名>.deno.dev` URL

粘回 AcademicFlow → Settings → MinerU 代理 输入框（部署方案选"国内网络"）。前端自动 ping `/__af_health`，绿色 ✓ 就是好了。

---

## 方案 B：Cloudflare Workers 一键部署（海外 / 有代理用户）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nikki-SU/AcademicFlow-Worker)

1. 点上面按钮 → CF 登录（没账号会引导注册，仅需邮箱）
2. 页面上直接点 **Deploy**，全程 CF 官方引导，无自定义步骤
3. 得到 `https://<项目名>.<你的用户名>.workers.dev` URL

粘回 AcademicFlow → Settings → MinerU 代理 输入框（部署方案选"海外/有代理"）。

> ⚠️ `*.workers.dev` 域名在国内三大运营商直连普遍不稳，若你在国内且没代理，请改用方案 A。

---

## 手动 / 本地开发（可选）

**Cloudflare Workers** 走 wrangler：
```bash
npm install -g wrangler
wrangler login
wrangler deploy
```

**Deno Deploy** 也支持 `deployctl` CLI，但网页部署更省事，一般不需要。

**本地起 Deno server 调试**：
```bash
deno run --allow-net src/deno.js
# 默认监听 8000 端口
curl http://localhost:8000/__af_health
```

---

## 路由

| Path | 用途 |
|---|---|
| `GET /__af_health` | 健康检查（返回 `{ok, service, version, runtime, upstream}`） |
| `ANY /api/v4/*` | 透传到 `https://mineru.net/api/v4/*` |
| `ANY /proxy?url=<encoded>` | 白名单透传（用于 MinerU 返回的 OSS 预签名 URL） |

**`/proxy` 白名单**：只允许转发到 `*.aliyuncs.com` / `*.openxlab.org.cn` / `mineru.net`（MinerU 目前用阿里云 OSS + openxlab CDN）。

**响应头**：始终附加 `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Methods` + `Access-Control-Allow-Headers` 让浏览器放行。

---

## 免费额度

- **Deno Deploy**：100k requests/day，1M requests/month，CPU 无严格限制
- **Cloudflare Workers**：100k requests/day，10ms CPU/req

个人日常使用 AcademicFlow（一天几十篇论文）远够。

---

## 隐私 & 责任

- 代理部署在**你自己的账号下**，作者不接触
- 代码 <200 行（`src/core.js` + 两个入口 <30 行），可自行审计
- 不缓存、不落盘、不上报请求体和响应体
- MIT License，允许 fork 修改

如果你希望进一步降低信任成本：
- fork 到自己账号，用你自己 fork 的仓库地址部署（Deno Deploy 支持任意 GitHub 仓库）
- 代码只有 200 行，肉眼审计即可

---

## LICENSE

MIT
