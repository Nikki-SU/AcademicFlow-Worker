/**
 * AcademicFlow-Worker — MinerU API CORS 透传代理
 *
 * 唯一职责：把 https://<你的-worker>.workers.dev/api/v4/xxx
 *          原样转发到 https://mineru.net/api/v4/xxx，并加上 CORS 头
 *
 * 不做的事：
 *   - 不缓存请求/响应
 *   - 不记录日志（除 CF 平台自带的访问计数外，任何请求体和响应体都不落地）
 *   - 不修改请求头（Authorization 原样透传）
 *   - 不修改响应体（浏览器直接拿到 MinerU 原始 JSON）
 *
 * 数据流：浏览器 → 你的 Worker（纯转发）→ mineru.net → 浏览器
 * 隐私：请求经过的凭证（MinerU token、PDF URL、任务 ID）只在你自己的 CF 账号内存中过一次，Worker 代码不落盘、不上报。
 * 授权：MIT（自由 fork 修改）
 */

const UPSTREAM = 'https://mineru.net'
const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS'
const ALLOWED_HEADERS = 'Authorization,Content-Type,Accept,X-Requested-With'
const HEALTH_PATH = '/__af_health'

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // 健康检查端点（AcademicFlow 前端用它验证 Worker URL 是否有效）
    if (url.pathname === HEALTH_PATH) {
      return json({ ok: true, service: 'academicflow-worker', upstream: UPSTREAM }, corsHeaders())
    }

    // 只允许转发 /api/ 前缀路径，防止被滥用为通用代理
    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'only /api/* paths are proxied' }, corsHeaders(), 403)
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search

    // 原样透传请求体和请求头
    const upstreamReq = new Request(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    })

    const upstreamRes = await fetch(upstreamReq)

    // 复制响应头，加上 CORS
    const respHeaders = new Headers(upstreamRes.headers)
    for (const [k, v] of Object.entries(corsHeaders())) {
      respHeaders.set(k, v)
    }

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    })
  },
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
  }
}

function json(obj, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}
