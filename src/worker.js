/**
 * AcademicFlow-Worker - Cloudflare Workers 入口
 *
 * 核心逻辑在 core.js（Web Standard API，与 Runtime 无关）。
 * 本文件仅负责把 CF Module Worker 的 fetch 事件转发到 handleRequest。
 *
 * 部署：
 *   1. 一键 Deploy：https://deploy.workers.cloudflare.com/?url=https://github.com/Nikki-SU/AcademicFlow-Worker
 *   2. 手动：`npm install -g wrangler && wrangler login && wrangler deploy`
 *
 * 国内可达性提示：`*.workers.dev` 国内三大运营商直连可达性差，仅推荐给
 *   - 有代理 / 出海用户
 *   - 已绑自定义域名（走 CF Anycast）
 * 国内默认用户请改用 Deno Deploy 版本（见 deno.js + README）。
 *
 * 隐私：请求经过的凭证只在你自己的 CF 账号内存中过一次，Worker 代码不落盘、不上报。
 * 授权：MIT（自由 fork 修改）
 */

import { handleRequest } from './core.js'

export default {
  async fetch(request) {
    return handleRequest(request, { runtime: 'cf-workers' })
  },
}
