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

  // 关键：uploadFile / pollBatch / downloadZip 都可能带大 body（PDF 8MB+）。
  // 必须用 stream pipe + duplex: 'half'，避免 Worker 在内存里 buffer 整个 body 再转发
  // （Deno 默认会先消费完整 stream 才能 fetch upstream，跨国回源时这个 buffer 等待
  //  容易撞 Deno Deploy 100s fetch 超时，浏览器端会抛 TypeError: Failed to fetch）。
  // @ts-ignore - duplex 是 Deno 1.40+ / CF Workers 扩展属性
  const init = {
    method: request.method,
    headers: outHeaders,
    redirect: 'follow',
    duplex: 'half',
  }
  // GET/HEAD 不能带 body（Web 标准约束）
  if (['GET', 'HEAD'].includes(request.method)) {
    delete init.body
    delete init.duplex
  } else {
    init.body = request.body
  }
  const upstreamRes = await fetch(targetUrl, init)

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
