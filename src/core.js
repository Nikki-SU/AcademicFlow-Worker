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
 *
 * v9.1 修复期（2026-07-15）：
 *   v9 在 proxyForward 里无条件剥 Content-Type，结果把 /api/v4/file-urls/batch
 *   这种 application/json 请求也带沟里了——mineru 端不知道 body 是 JSON，
 *   报 "type mismatch for field files"。
 *   v9.1 修法：剥 Content-Type 只对 /proxy 路径生效（options.stripContentType=true），
 *   /api/v4/* 路径保留 Content-Type（options.stripContentType=false）。
 *
 * v9.2 修复期（2026-07-15）：
 *   v9.1 用 edit_file 改了 4 处但只真改 1 处（proxyForward 签名 + options 解构），
 *   其他 3 处（handleApi / handleProxy / 条件剥）没改。
 *   v9.2 修法：write_file 整文件覆盖 334 行，确保 3 处修改都生效。
 *
 * v10 修复期（2026-07-15）：
 *   v9.2 跑 8MB PDF 真实流量，申请 URL 成功（type mismatch 修好）+
 *   /proxy 剥 Content-Type 真的生效（af-worker-content-type=(none)），
 *   但 8MB PDF 上传 30.7s 拿到 504（v8 加的 30s timeout 触发）。
 *   回看：v3 时代 01:09 那次 8MB PDF 跑了 95.3s 才 abort（v3 没显式 timeout，
 *   是 Deno Deploy 或网络层自己的 timeout），说明 8MB PDF 偶发就是需要 >95s。
 *   v10 修法：worker 显式 timeout 30s → 120s，覆盖 95s 最坏情况 + 余量。
 *   保留 4 个 X-AF-Worker-* header + 504 观测机制（v8 的关键设计，不能丢）。
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

// v10：worker 显式 fetch timeout 阈值。
// 8MB PDF 在 worker ↔ OSS 网络下偶发需要 95s+（v3 时代 01:09 那次 95.3s abort 验证），
// 30s 太短会让真实流量被误判 timeout。120s = 4 倍 30s，覆盖 95s 最坏情况 + 25s 余量。
// 如果 120s 还不够（更极端网络），再考虑去掉 worker 端 timeout。
const FETCH_TIMEOUT_MS = 120000

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
  // /api/v4/* 透传到 mineru.net
  // 重要：不要剥 Content-Type！
  //   POST /api/v4/file-urls/batch 这种 application/json 请求，
  //   剥了 Content-Type 后 mineru 端不知道 body 是 JSON，就报 type mismatch。
  //   v9 失误：v9 在 proxyForward 里无条件剥 Content-Type，把 batch endpoint 也带沟里了。
  //   v9.1 修复：剥 Content-Type 只对 /proxy 路径生效，/api/v4/* 保留。
  return proxyForward(request, UPSTREAM_API + url.pathname + url.search, {
    stripContentType: false,
  })
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

  return proxyForward(request, target, { stripContentType: true })
}

async function proxyForward(request, targetUrl, options = {}) {
  const { stripContentType = false } = options
  // 复制请求头，剥掉 host / cf-* / x-forwarded-* / deno-* 等平台注入头
  // 避免污染上游签名和风控
  // v9 修复期：额外剥掉 Content-Type header。原因：mineru 算 OSS 预签名 URL signature 时
  //   StringToSign 的 Content-Type 字段是空（mineru 假定 client 不带 Content-Type），
  //   但浏览器 fetch PUT 上传时会自动带 Content-Type（来自 file.type，对 PDF 是 application/pdf）。
  //   worker 透传后，OSS 收到带 Content-Type 的请求，OSS 算 signature 时**会**用 Content-Type，
  //   StringToSign Content-Type 字段变成 application/pdf，跟 mineru 算时的空不一致 → 403。
  //   解决方案：worker 转发到 OSS 时主动剥掉 Content-Type，OSS 算 signature 时 Content-Type 字段
  //   跟 mineru 一致都是空，signature 匹配 → 200。
  //   根因锁定：v8 跑 8MB PDF，af-worker-content-type=application/pdf（client 实际带的 Content-Type）
  //   + af-worker-url-in == af-worker-url-url-out（URL 字节级 noop）+ af-worker-status=403
  //   → 排除 URL 字节级和透传行为，剩 Content-Type 不一致。
  //   验证依据：阿里云开发者社区 OSS signature 案例（client SDK 不算 Content-Type vs OSS 会用 Content-Type），
  //   https://developer.aliyun.com/article/659783
  // v9.1 修复：剥 Content-Type 只对 /proxy 路径生效（options.stripContentType=true 时才剥），
  //   /api/v4/* 路径必须保留 Content-Type（stripContentType=false），否则 POST application/json
  //   body 无法被 mineru 解析。
  const outHeaders = new Headers()
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'cf-connecting-ip' || lower.startsWith('cf-')) continue
    if (lower.startsWith('x-forwarded-')) continue
    if (lower.startsWith('x-real-')) continue
    if (lower.startsWith('deno-')) continue
    // v9 新增 / v9.1 改为条件剥：只对 /proxy 路径生效
    if (stripContentType && lower === 'content-type') continue
    outHeaders.set(k, v)
  }

  // v7 修复期：把 targetUrl 的 query string 重新按 RFC 3986 unreserved 规则
  // 严格 encode 一次，绕开 new Request 路径下 WHATWG URL parser 对 query 的
  // decode-不重 encode 行为（%2B → '+'，%3D → '='，但 serializer 不还原），
  // 避免发到 OSS 的 URL 字节级跟签名时输入不一致，触发 403 SignatureDoesNotMatch。
  // 字符串级 split，不依赖 URL parser，保证 parse-encoder 行为可控。
  // v7 同步：保留 v6 行为（不改 URL 字节级），但加观测。
  // v8 修复期：fetch 加 timeout，timeout/abort 时主动构造 504 response + 4 个
  //   X-AF-Worker-* header，让 abort 模式也能观测（v7 之前 abort 模式 fetch fail
  //   拿不到 response，4 个 header 写不进 response，观测能力失效）。
  //   行为变化：从"fetch 一直挂着直到上游/网络断开"变成"120s 主动放弃并返回 504"。
  //   收益：abortable / observable（Rosa 看到 504 + 4 个 header 就能定位卡在哪）。
  //   v10 修复期：timeout 30s → 120s。8MB PDF 在 worker ↔ OSS 网络下偶发需要 95s+
  //   （v3 时代 01:09 那次 95.3s abort 验证），30s 太短会让真实流量被误判 timeout。
  //   120s = 4 倍 30s，覆盖 95s 最坏情况 + 25s 余量。
  const stabilizedUrl = stabilizeSignatureUrl(targetUrl)

  // v10：fetch 加 AbortController + 120s timeout（v8 是 30s，v10 调到 120s）
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  // 关键：用 new Request 构造（URL 字符串不被 WHATWG parser 规范化）
  // + duplex: 'half'（流式 pipe 边收边发，砍掉 buffer 等待解决 100s 超时）。
  // + signal: AbortController.signal（120s timeout）。
  // 三者结合 = 既保留 URL 字符串原样（避免签名 decode/encode 漂移），
  // 又避免 Deno 在内存里 buffer 完整 8MB 再转发，又让 120s 卡住主动放弃。
  // @ts-ignore - duplex 是 Deno 1.40+ 扩展属性
  const init = {
    method: request.method,
    headers: outHeaders,
    redirect: 'follow',
    duplex: 'half',
    signal: controller.signal,
  }
  // GET/HEAD 不能带 body（Web 标准约束）
  if (['GET', 'HEAD'].includes(request.method)) {
    delete init.duplex
  } else {
    init.body = request.body
  }
  const upstreamReq = new Request(stabilizedUrl, init)

  let upstreamRes
  try {
    upstreamRes = await fetch(upstreamReq)
  } catch (err) {
    clearTimeout(timeoutId)
    // v8：abort/timeout 时主动构造 504 response + 4 个 header，让 abort 模式可观测
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      const respHeaders = new Headers()
      for (const [k, v] of Object.entries(corsHeaders())) {
        respHeaders.set(k, v)
      }
      respHeaders.set('X-AF-Worker-URL-In', targetUrl)
      respHeaders.set('X-AF-Worker-URL-Out', stabilizedUrl)
      respHeaders.set('X-AF-Worker-Status', '504')
      respHeaders.set(
        'X-AF-Worker-Content-Type',
        outHeaders.get('Content-Type') ?? '(none)',
      )
      return new Response(
        JSON.stringify({
          error: `worker fetch timeout (${FETCH_TIMEOUT_MS / 1000}s)`,
          upstreamHost: new URL(stabilizedUrl).hostname,
          reason: `OSS ${FETCH_TIMEOUT_MS / 1000}s 内未完成响应，worker 主动放弃。`,
        }),
        {
          status: 504,
          statusText: 'Gateway Timeout',
          headers: respHeaders,
        },
      )
    }
    throw err
  }
  clearTimeout(timeoutId)

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
  // v7 新增：X-AF-Worker-Content-Type = worker 实际发给 OSS 的 Content-Type
  //   （用于诊断 403 signature 不匹配：如果 client 发 application/octet-stream
  //   但 mineru 算 signature 时用 application/pdf，签名一定不匹配。
  //   把这个值暴露出来，Rosa 跑一次 8MB PDF 就能看到真实情况，
  //   不再凭"猜测的 50%"盲改 Content-Type。）
  // 三者字节级对比 = 403 根因直接定位。
  respHeaders.set('X-AF-Worker-URL-In', targetUrl)
  respHeaders.set('X-AF-Worker-URL-Out', stabilizedUrl)
  respHeaders.set('X-AF-Worker-Status', String(upstreamRes.status))
  respHeaders.set('X-AF-Worker-Content-Type', outHeaders.get('Content-Type') ?? '(none)')

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
