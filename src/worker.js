/**
 * AcademicFlow-Worker - MinerU CORS 透传代理
 *
 * 路由：
 *   GET  /__af_health        健康检查（AcademicFlow 前端用它验证 URL）
 *   ANY  /api/v4/*           透传到 https://mineru.net/api/v4/*
 *   ANY  /proxy?url=<url>    白名单透传（用于 MinerU 返回的 OSS 预签名 URL）
 *
 * 不做的事：
 *   - 不缓存请求 / 响应
 *   - 不落盘、不上报请求体和响应体（CF 平台自带的访问计数除外）
 *   - 不修改请求头（Authorization 原样透传）
 *   - 不修改响应体
 *
 * 数据流：浏览器 → 你的 Worker（纯转发）→ mineru.net / MinerU OSS → 浏览器
 * 隐私：请求经过的凭证只在你自己的 CF 账号内存中过一次，Worker 代码不落盘、不上报。
 * 授权：MIT（自由 fork 修改）
 */

const UPSTREAM_API = 'https://mineru.net'
const ALLOWED_METHODS = 'GET,POST,PUT,DELETE,OPTIONS'
const ALLOWED_HEADERS = 'Authorization,Content-Type,Accept,X-Requested-With'
const HEALTH_PATH = '/__af_health'
const PROXY_PATH = '/proxy'

// /proxy 允许的 upstream 主机后缀白名单
// MinerU 目前用阿里云 OSS + openxlab CDN，两个都覆盖
const PROXY_ALLOWED_SUFFIXES = [
  '.aliyuncs.com',
  '.openxlab.org.cn',
  'mineru.net',
]

export default {
  async fetch(request) {
    const url = new URL(request.url)

    // ---- 1) CORS preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // ---- 2) 健康检查 ----
    if (url.pathname === HEALTH_PATH) {
      return json(
        { ok: true, service: 'academicflow-worker', upstream: UPSTREAM_API, version: 2 },
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
  },
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
  // 复制请求头，但去掉 hop-by-hop / host 类头，避免污染上游签名
  const outHeaders = new Headers()
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase()
    if (lower === 'host' || lower === 'cf-connecting-ip' || lower.startsWith('cf-')) continue
    outHeaders.set(k, v)
  }

  const upstreamReq = new Request(targetUrl, {
    method: request.method,
    headers: outHeaders,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow',
  })

  const upstreamRes = await fetch(upstreamReq)

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
