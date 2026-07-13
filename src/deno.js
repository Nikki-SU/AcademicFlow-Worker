/**
 * AcademicFlow-Worker - Deno Deploy 入口
 *
 * 核心逻辑在 core.js（Web Standard API，与 Runtime 无关）。
 * 本文件仅负责用 Deno.serve 把 fetch handler 挂上端口。
 *
 * 为什么有这份 Deno Deploy 版本？
 *   国内直连 `*.workers.dev` 三大运营商都不稳，`*.deno.dev` 走 GCP Asia
 *   节点，国内三大运营商基本可达。作为国内用户的默认部署方案。
 *
 * 部署（4 步，全部在网页里，不用装任何东西）：
 *   1. 打开 https://dash.deno.com/new
 *   2. 用 GitHub 登录 → 授权 Deno Deploy 读取仓库
 *   3. 选择你 fork 的 AcademicFlow-Worker 仓库
 *      - Entrypoint 填：`src/deno.js`
 *      - Install Step 留空
 *      - Build Step 留空
 *   4. 点 Deploy → 得到 `https://<你的项目名>.deno.dev` URL
 *
 * 得到 URL 后，粘回 AcademicFlow → Settings → MinerU 代理 输入框。
 * 前端会自动 ping `/__af_health`，绿色 ✓ 就是好了。
 *
 * 免费额度：100k requests/day，个人使用绰绰有余。
 *
 * 隐私 & 授权同 CF 版：Worker 代码不落盘、不上报；MIT。
 */

import { handleRequest } from './core.js'

// Deno.serve 是 Deno 内置的 HTTP server（Deno 1.35+），Deno Deploy 完全支持。
// 无需绑定端口——Deno Deploy 自动路由到平台分配的端口。
Deno.serve((request) => handleRequest(request, { runtime: 'deno-deploy' }))
