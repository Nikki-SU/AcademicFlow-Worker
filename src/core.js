/**
 * AcademicFlow-Worker 共享核心逻辑
 *
 * 只依赖 Web Standard API：
 *   URL, Request, Response, Headers, fetch, URLSearchParams
 *
 * 因此可以直接跑在两种 Runtime：
 *   - Cloudflare Workers（入口：worker.js）
 *   - Deno Deploy（入口：deno.js）
 *
 * 路由：
 *   GET  /__af_health        健康检查（返回 service/version/runtime）
 *   ANY  /api/v4/*           透传到 https://mineru.net/api/v4/*
 *   ANY  /proxy?url=<url>    白名单透传（用于 MinerU 返回的 OSS 预签名 URL）
 *
 * 不做的事：不缓存、不落盘、不上报请求体和响应体、不修改请求头/响应体。
 */

const UPSTREAM_API = 'https://mineru.net'
const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS'
const ALLOWED_HEADERS = 'Authorization,Content-Type,Accept,X-Requested-With'
const HEALTH_PATH = '/__af_health'
const PROXY_PATH = '/proxy'

// /proxy 允许的 upstream 主机后缀白名单
// MinerU 目前用阿里云 OSS + openxlab CDN
const PROXY_ALLOWED_SUFFIXES = [
  '.aliyuncs.com',
  '.openxlab.org.cn',
  'mineru.net',
]

/**
 * 主 handler：接收 Request，返回 Response。
 * @param {Request} request
 * @param {{ runtime?: string }} [ctx] 可选上下文，仅用于健康检查标记 runtime。
 */
export async function handleRequest(request, ctx = {}) {
  const url = new URL(request.url)
  const runtime = ctx.runtime || 'unknown'

  // ---- 1) CORS preflight ----
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  // ---- 2) 健康检查 ----
  if (url.pathname === HEALTH_PATH) {
    return json(
      {
        ok: true,
        service: 'academicflow-worker',
        upstream: UPSTREAM_API,
        version: 2,
        runtime,
      },
      corsHeaders(),
    )
  }

  // ---- 3) /proxy?url=<encoded>：白名单透传（用于 OSS 预签名 URL） ----
  if (url.pathname === PROXY_PATH) {
    return handleProxy(request, url)
  }

  // ---- 4) /api/* 透传到 mineru.net ----
  if (url.pathname.startsWith('/api/')) {
    return handleApi(request, url)
  }

  // 其他路径拒绝，防止被当通用代理滥用
  return json({ error: 'not found' }, corsHeaders(), 404)
}

async function handleApi(request, url) {
  const upstreamUrl = UPSTREAM_API + url.pathname + url.search
  return proxyForward(request, upstreamUrl)
}

async function handleProxy(request, url) {
  const target = url.searchParams.get('url')
  if (!target) {
    return json({ error: 'missing ?url= param' }, corsHeaders(), 400)
  }

  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return json({ error: 'invalid url' }, corsHeaders(), 400)
  }

  if (parsed.protocol !== 'https:') {
    return json({ error: 'only https:// is allowed' }, corsHeaders(), 400)
  }

  const host = parsed.hostname
  const allowed = PROXY_ALLOWED_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, '') || host.endsWith(suffix),
  )
  if (!allowed) {
    return json(
      {
        error: 'host not in whitelist',
        host,
        allowed: PROXY_ALLOWED_SUFFIXES,
      },
      corsHeaders(),
      403,
    )
  }

  return proxyForward(request, target)
}

async function proxyForward(request, targetUrl) {
  // 复制请求头，剥掉 host / cf-* / x-forwarded-* / deno-* 等平台注入头
  // 避免污染上游签名和风控
  const outHeaders = new Headers()
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'cf-connecting-ip' || lower.startsWith('cf-')) continue
    if (lower.startsWith('x-forwarded-')) continue
    if (lower.startsWith('x-real-')) continue
    if (lower.startsWith('deno-')) continue
    outHeaders.set(k, v)
  }

  // 调试日志（M3.6.3 修复期临时开启）：打印实际发给上游的 URL 和 headers，
  // 用于定位 fetch(string) 路径下 WHATWG URL parser 是否会规范化 URL 字符串
  // （例如把 Signature=xrpY%2B...%3D 改成 Signature=xrpY+...=，导致 403）。
  // Worker 是 Rosa 私有 Deno 账号，log 不存在泄露风险。
  console.log('[proxyForward] targetUrl:', targetUrl)
  console.log(
    '[proxyForward] outHeaders:',
    JSON.stringify([...outHeaders.entries()]),
  )
  console.log(
    '[proxyForward] body type:',
    request.body ? 'stream' : 'null',
    'method:',
    request.method,
  )

  // 关键：用 new Request 构造（URL 字符串不被 WHATWG parser 规范化）
  // + duplex: 'half'（流式 pipe 边收边发，砍掉 buffer 等待解决 100s 超时）。
  // 两者结合 = 既保留 URL 字符串原样（避免签名 decode/encode 漂移），
  // 又避免 Deno 在内存里 buffer 完整 8MB 再转发。
  // @ts-ignore - duplex 是 Deno 1.40+ 扩展属性
  const init = {
    method: request.method,
    headers: outHeaders,
    redirect: 'follow',
    duplex: 'half',
  }
  // GET/HEAD 不能带 body（Web 标准约束）
  if (['GET', 'HEAD'].includes(request.method)) {
    delete init.duplex
  } else {
    init.body = request.body
  }
  const upstreamReq = new Request(targetUrl, init)
  const upstreamRes = await fetch(upstreamReq)
  console.log('[proxyForward] upstream status:', upstreamRes.status)

  const respHeaders = new Headers(upstreamRes.headers)
  for (const [k, v] of Object.entries(corsHeaders())) {
    respHeaders.set(k, v)
  }

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: respHeaders,
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
  }
}

function json(obj, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}
