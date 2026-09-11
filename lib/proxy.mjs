// Rendering proxy for the device preview: fetches a page server-side, drops
// the response headers that stop it from being displayed inside the phone
// frame, and injects a small runtime that keeps navigation, forms and API
// calls routed through the proxy. Assets (images, CSS, JS) load straight from
// the original site via an injected <base>, so the page behaves as it normally
// would; only documents and XHR/fetch calls come through here.
//
// Used by api/proxy.js (Vercel) and server.mjs (Node).

import { Readable } from 'node:stream';
import { normalizeUrl, CheckError, assertPublicHost } from './check.mjs';

const MAX_REDIRECTS = 10;
const HEADER_TIMEOUT_MS = 20000;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

// Response headers that must not be passed through: framing / CSP controls
// (the whole point of the preview), encoding (fetch already decoded the
// body), cookies (never stored or replayed) and hop-by-hop headers.
const STRIP_RESPONSE = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
  'set-cookie2',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'reporting-endpoints',
  'nel',
  'permissions-policy',
  'feature-policy',
  'x-xss-protection',
  'link',
  'alt-svc',
  'server-timing',
]);

// Request headers forwarded from the browser to the origin.
const FORWARD_REQUEST = new Set([
  'accept',
  'accept-language',
  'content-type',
  'authorization',
  'range',
  'if-none-match',
  'if-modified-since',
  'x-requested-with',
  'cache-control',
  'pragma',
]);

export function proxyPath(prefix, absoluteUrl) {
  return `${prefix}?url=${encodeURIComponent(absoluteUrl)}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function errorPage(status, title, message, targetUrl) {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-duo-proxy-error': encodeURIComponent(message),
    },
    body: `<!doctype html><html data-duo-error="${esc(message)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#111;color:#eee;text-align:center;padding:24px}main{max-width:420px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#aaa}code{font-family:ui-monospace,Menlo,monospace;background:rgba(255,255,255,.1);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${targetUrl ? `<p style="margin-top:12px"><code>${esc(targetUrl)}</code></p>` : ''}</main></body></html>`,
  };
}

// --- HTML rewriting -----------------------------------------------------------

function runtimeScript(targetUrl, prefix) {
  // Runs first inside the proxied document and keeps the page inside the proxy:
  // - links, forms, history and window.open stay on proxy URLs
  // - fetch/XHR/sendBeacon go through the proxy so same-origin APIs keep working
  // - service workers are disabled (they cannot register across scopes anyway)
  return `<script data-duo-proxy>(function(){
var T=new URL(${JSON.stringify(targetUrl)});var P=${JSON.stringify(prefix)};
function abs(u){try{return new URL(String(u),T.href)}catch(e){return null}}
function prox(u){var a=abs(u);if(!a)return u;if(a.protocol!=='http:'&&a.protocol!=='https:')return u;if(a.pathname===P&&a.searchParams.get('url')){var inner=a.searchParams.get('url');if(a.origin===location.origin)return a.href;return location.origin+P+'?url='+encodeURIComponent(inner)}return location.origin+P+'?url='+encodeURIComponent(a.href)}
function isRel(u){u=String(u);return !/^[a-z][a-z0-9+.-]*:/i.test(u)||/^https?:/i.test(u)}
var of=window.fetch;if(of){window.fetch=function(i,init){try{if(typeof i==='string'||i instanceof URL){if(isRel(i))i=prox(i)}else if(i&&i.url&&isRel(i.url)){i=new Request(prox(i.url),i)}}catch(e){}return of.call(this,i,init)}}
var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){try{if(isRel(u))arguments[1]=prox(u)}catch(e){}return oo.apply(this,arguments)};
if(navigator.sendBeacon){var ob=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){try{if(isRel(u))u=prox(u)}catch(e){}return ob(u,d)}}
var ow=window.open;window.open=function(u){try{if(u&&isRel(u))arguments[0]=prox(u)}catch(e){}return ow.apply(this,arguments)};
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(s,t,u){try{return o.call(this,s,t,u==null?u:prox(u))}catch(e){}}});
if(navigator.serviceWorker){try{navigator.serviceWorker.register=function(){return Promise.reject(new Error('Service workers are disabled in the preview'))}}catch(e){}}
document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(/^(#|javascript:|mailto:|tel:|sms:|data:|blob:)/i.test(h))return;var p=prox(a.href);if(p===a.href)return;e.preventDefault();if(a.target==='_blank'){window.open(p,'_blank')}else{location.href=p}},true);
document.addEventListener('submit',function(e){var f=e.target;if(!f||!(f instanceof HTMLFormElement))return;var act=f.getAttribute('action')||T.href;var u=abs(act);if(!u)return;if((f.method||'get').toLowerCase()==='get'){e.preventDefault();var q=new URLSearchParams(new FormData(f));u.search=q.toString();location.href=prox(u.href)}else{f.action=prox(u.href)}},true);
})();</script>`;
}

const SKIP_URL = /^\s*(data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;

export function rewriteHtml(html, targetUrl, prefix) {
  let base = targetUrl;
  const baseMatch = /<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  if (baseMatch) {
    try { base = new URL(baseMatch[2] ?? baseMatch[3] ?? baseMatch[4], targetUrl).href; } catch {}
  }
  const abs = (u) => { try { return new URL(u, base).href; } catch { return null; } };
  const prox = (u) => {
    if (!u || SKIP_URL.test(u)) return u;
    const a = abs(u.trim());
    if (!a || !/^https?:/i.test(a)) return u;
    return proxyPath(prefix, a);
  };
  const attr = (m, pre, q, d, s) => `${pre}"${prox(d ?? s).replace(/"/g, '&quot;')}"`;

  let out = html;
  // Remove anything that would fight the proxy.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '');
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/\s(integrity|nonce)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Nested frames and refresh redirects must stay inside the proxy.
  out = out.replace(/(<(?:iframe|frame)\b[^>]*\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi, attr);
  out = out.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\bcontent\s*=\s*["'][^"';]*;\s*url\s*=\s*)([^"']+)/gi, (m, pre, u) => `${pre}${prox(u)}`);
  // Anchors and forms are rewritten statically too, so they work before the
  // runtime is active.
  out = out.replace(/(<a\b[^>]*\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi, attr);
  out = out.replace(/(<form\b[^>]*\baction\s*=\s*)("([^"]*)"|'([^']*)')/gi, attr);

  const inject = `<base href="${base.replace(/"/g, '&quot;')}">${runtimeScript(targetUrl, prefix)}`;
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => m + inject);
  else if (/<html\b[^>]*>/i.test(out)) out = out.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${inject}</head>`);
  else out = inject + out;
  return out;
}

export function rewriteCss(css, targetUrl) {
  // Make CSS URLs absolute so a stylesheet fetched through the proxy still
  // resolves its images and fonts against the original site.
  const abs = (u) => { try { return new URL(u, targetUrl).href; } catch { return u; } };
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => (SKIP_URL.test(u) ? m : `url(${q}${abs(u.trim())}${q})`))
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => `@import ${q}${abs(u.trim())}${q}`);
}

function decode(buf, contentType, isHtml) {
  let charset = (/charset=["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset && isHtml) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

// --- main -----------------------------------------------------------------

/**
 * Fetch `url` on behalf of the preview frame.
 * @returns {Promise<{status:number, headers:Record<string,string>, body:string|Buffer|import('node:stream').Readable}>}
 */
export async function proxyRequest({ url: input, method = 'GET', headers = {}, body = null, prefix = '/api/proxy', ourHost = null, allowPrivate = false }) {
  let url;
  try {
    url = normalizeUrl(input);
  } catch (err) {
    return errorPage(400, 'Nothing to load', err instanceof CheckError ? err.message : 'Invalid URL.', input);
  }

  const reqHeaders = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' };
  for (const [k, v] of Object.entries(headers)) {
    if (FORWARD_REQUEST.has(k.toLowerCase()) && v != null) reqHeaders[k.toLowerCase()] = String(v);
  }
  if (!reqHeaders.accept) reqHeaders.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  let current = url;
  let response;
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      if (ourHost && current.host === ourHost) {
        return errorPage(400, 'Not allowed', 'The preview cannot load itself.', current.href);
      }
      try {
        await assertPublicHost(current, allowPrivate);
      } catch (err) {
        return errorPage(403, 'Not allowed', err.message, current.href);
      }
      reqHeaders.referer = current.origin + '/';
      try {
        response = await fetch(current, {
          method,
          headers: reqHeaders,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        const msg = controller.signal.aborted
          ? `${current.hostname} did not respond within ${HEADER_TIMEOUT_MS / 1000}s.`
          : `Could not connect to ${current.hostname}.`;
        return errorPage(502, 'Couldn’t reach it', msg, current.href);
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        response.body?.cancel().catch(() => {});
        if (i === MAX_REDIRECTS) return errorPage(502, 'Too many redirects', 'The site kept redirecting.', current.href);
        current = new URL(location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          return errorPage(502, 'Unsupported redirect', `Redirected to ${current.protocol} which cannot be shown.`, current.href);
        }
        // Browsers switch to GET after 301/302/303 (not after 307/308).
        if (response.status !== 307 && response.status !== 308) {
          method = 'GET';
          body = null;
          delete reqHeaders['content-type'];
        }
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timer);
  }

  const outHeaders = { 'x-duo-proxied-url': current.href, 'access-control-allow-origin': '*' };
  for (const [k, v] of response.headers) {
    if (!STRIP_RESPONSE.has(k.toLowerCase())) outHeaders[k.toLowerCase()] = v;
  }
  const contentType = response.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType) || (!contentType && method === 'GET');
  const isCss = /text\/css/i.test(contentType);

  if (isHtml || isCss) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_TEXT_BYTES) {
      return errorPage(502, 'Too large', 'The page is too large to preview.', current.href);
    }
    const text = decode(buf, contentType, isHtml);
    const out = isHtml ? rewriteHtml(text, current.href, prefix) : rewriteCss(text, current.href);
    outHeaders['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
    outHeaders['cache-control'] = 'no-store';
    return { status: response.status, headers: outHeaders, body: out };
  }

  // Everything else (JSON, images, fonts, media) streams through untouched.
  return {
    status: response.status,
    headers: outHeaders,
    body: response.body ? Readable.fromWeb(response.body) : '',
  };
}
