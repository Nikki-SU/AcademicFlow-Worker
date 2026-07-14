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

  // v6 修复期：把 targetUrl 的 query string 重新按 RFC 3986 unreserved 规则
  // 严格 encode 一次，绕开 new Request 路径下 WHATWG URL parser 对 query 的
  // decode-不重 encode 行为（%2B → '+'，%3D → '='，但 serializer 不还原），
  // 避免发到 OSS 的 URL 字节级跟签名时输入不一致，触发 403 SignatureDoesNotMatch。
  // 字符串级 split，不依赖 URL parser，保证 parse-encoder 行为可控。
  const stabilizedUrl = stabilizeSignatureUrl(targetUrl)

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
  const upstreamReq = new Request(stabilizedUrl, init)
  const upstreamRes = await fetch(upstreamReq)

  const respHeaders = new Headers(upstreamRes.headers)
  for (const [k, v] of Object.entries(corsHeaders())) {
    respHeaders.set(k, v)
  }
  // v6 诊断：把 worker 端关键信息通过 response header 回给前端 Debug Console。
  // Access-Control-Expose-Headers: * 已设（见 corsHeaders），浏览器允许前端 JS 读取。
  // 这层不依赖 Deno Deploy Logs（已证实该 UI 不显示 console.log）。
  // X-AF-Worker-URL-In:  client 申请时通过 ?url= 传来的 targetUrl（worker 收到）
  // X-AF-Worker-URL-Out: worker 实际转发给 OSS 的 URL（stabilize 后）
  // X-AF-Worker-Status: OSS 响应 status
  // 三者字节级对比 = 403 根因直接定位。
  respHeaders.set('X-AF-Worker-URL-In', targetUrl)
  respHeaders.set('X-AF-Worker-URL-Out', stabilizedUrl)
  respHeaders.set('X-AF-Worker-Status', String(upstreamRes.status))

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

// v6 utility：把 OSS 预签名 URL 的 query string 按 RFC 3986 unreserved 规则
// 严格重 encode 一次。绕开 WHATWG URL parser 对 query 字符串的
// decode-不重 encode 行为（parser 会把 %2B → '+'，%3D → '='，但 serializer
// 不会把这些字符重新编码回 %HH 形式），保证 worker → OSS 这一步的 URL
// 字节级跟 OSS 算 signature 时用的输入严格一致。
//
// 算法：
//   1. 字符串级 split '?' 取 baseUrl + query
//   2. split '&' 取 [key, value] 数组
//   3. 每个 key/value decode 一次（decodeURIComponent）
//   4. 按 RFC 3986 unreserved 字符集（A-Z a-z 0-9 - _ . ~）encode 一次
//      → 非 unreserved 字符（'+' '=' '/' 等）变回 %HH
//   5. 按 key 排序（跟 OSS canonicalized resource 算法一致）
//   6. 拼回 baseUrl?key1=encodedValue1&key2=encodedValue2&...
//
// 副作用：值里字符如果是已经 %HH 形式（如 %2B），会先 decode 再 encode，
// 字节级跟 mineru 当时算 signature 时的 URL 字节级对齐 → OSS 算 signature
// 跟 mineru 算 signature 用同一输入 → 200。
function stabilizeSignatureUrl(targetUrl) {
  const queryStart = targetUrl.indexOf('?')
  if (queryStart === -1) return targetUrl
  const baseUrl = targetUrl.substring(0, queryStart)
  const query = targetUrl.substring(queryStart + 1)

  const pairs = query.split('&').map((kv) => {
    const eq = kv.indexOf('=')
    if (eq === -1) return [safeDecode(kv), '']
    return [safeDecode(kv.substring(0, eq)), safeDecode(kv.substring(eq + 1))]
  })

  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const newQuery = pairs
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&')

  return `${baseUrl}?${newQuery}`
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// RFC 3986 unreserved 字符：A-Z a-z 0-9 - _ . ~
// 其他字符（含 '+' '=' '/' '?' '&' '#' 等）一律 %HH，
// UTF-8 多字节字符也走 UTF-8 → %HH（通过 TextEncoder 拿字节）。
function encodeRfc3986(s) {
  const bytes = new TextEncoder().encode(s)
  let r = ''
  for (const b of bytes) {
    if (
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x2e || // .
      b === 0x7e    // ~
    ) {
      r += String.fromCharCode(b)
    } else {
      r += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    }
  }
  return r
}
