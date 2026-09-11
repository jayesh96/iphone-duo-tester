// Shared URL-embeddability check. Used by api/check.js (Vercel) and server.mjs (Node).
//
// Answers: can this URL be loaded inside an <iframe> on our page, and does it
// respond at all? It fetches the URL server-side (following redirects hop by
// hop so every hop is validated), reads only the headers, and evaluates
// X-Frame-Options and Content-Security-Policy frame-ancestors.

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 10;
const DEFAULT_TIMEOUT_MS = 8000;
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

export function normalizeUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new CheckError('Enter a URL to test.', 'empty');
  const schemeAdded = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (schemeAdded) s = 'https://' + s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new CheckError('That does not look like a valid URL.', 'invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CheckError('Only http:// and https:// URLs can be tested.', 'scheme');
  }
  if (url.username || url.password) {
    throw new CheckError('URLs with embedded credentials are not allowed.', 'credentials');
  }
  url.schemeAdded = schemeAdded;
  return url;
}

export class CheckError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
    return false;
  }
  return true; // not an IP literal we understand: treat as unsafe
}

export async function assertPublicHost(url, allowPrivate) {
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new CheckError('Local and private network addresses cannot be tested.', 'private');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new CheckError('Local and private network addresses cannot be tested.', 'private');
    }
    return;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new CheckError(`Could not resolve ${host}. Check the spelling of the domain.`, 'dns');
  }
  if (records.length === 0 || records.some((r) => isPrivateIp(r.address))) {
    throw new CheckError('Local and private network addresses cannot be tested.', 'private');
  }
}

// --- header evaluation ------------------------------------------------------

function parseFrameAncestors(cspHeader) {
  if (!cspHeader) return null;
  // Multiple CSP headers are joined with ", " by fetch; commas are not legal
  // inside a policy, so splitting on them is safe.
  for (const policy of cspHeader.split(',')) {
    for (const directive of policy.split(';')) {
      const parts = directive.trim().split(/\s+/);
      if (parts[0]?.toLowerCase() === 'frame-ancestors') {
        return parts.slice(1).map((p) => p.replace(/^'|'$/g, '').toLowerCase());
      }
    }
  }
  return null;
}

function sourceMatchesOrigin(source, origin) {
  if (!origin) return false;
  let o;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (source === '*') return true;
  if (source === 'https:' || source === 'http:') return o.protocol === source;
  // host-source: [scheme://]host[:port], host may start with *.
  const m = source.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^:/]+)(?::(\*|\d+))?/);
  if (!m) return false;
  const [, scheme, wildcard, host, port] = m;
  if (scheme && scheme + ':' !== o.protocol) return false;
  const oh = o.hostname.toLowerCase();
  if (wildcard) {
    if (!oh.endsWith('.' + host)) return false;
  } else if (oh !== host) {
    return false;
  }
  if (port && port !== '*') {
    const op = o.port || (o.protocol === 'https:' ? '443' : '80');
    if (op !== port) return false;
  }
  return true;
}

export function evaluateEmbeddability({ xfo, csp, targetOrigin, ourOrigin }) {
  const ancestors = parseFrameAncestors(csp);
  if (ancestors) {
    // CSP frame-ancestors is authoritative and overrides X-Frame-Options.
    if (ancestors.length === 0 || ancestors.includes('none')) {
      return { embeddable: false, reason: "Content-Security-Policy: frame-ancestors 'none'" };
    }
    const allowsSelf = ancestors.includes('self') && ourOrigin && targetOrigin === ourOrigin;
    const allowsUs = ancestors.some((s) => s !== 'self' && sourceMatchesOrigin(s, ourOrigin));
    if (allowsSelf || allowsUs) {
      return { embeddable: true, reason: 'CSP frame-ancestors permits this site' };
    }
    return {
      embeddable: false,
      reason: `Content-Security-Policy: frame-ancestors ${ancestors.map((a) => (a.includes(':') || a.includes('.') || a === '*' ? a : `'${a}'`)).join(' ')}`,
    };
  }
  if (xfo) {
    const v = xfo.split(',')[0].trim().toUpperCase();
    if (v === 'DENY') return { embeddable: false, reason: 'X-Frame-Options: DENY' };
    if (v === 'SAMEORIGIN') {
      if (ourOrigin && targetOrigin === ourOrigin) {
        return { embeddable: true, reason: 'X-Frame-Options: SAMEORIGIN (same origin as this site)' };
      }
      return { embeddable: false, reason: 'X-Frame-Options: SAMEORIGIN' };
    }
    if (v.startsWith('ALLOW-FROM')) {
      return { embeddable: false, reason: `X-Frame-Options: ${xfo}` };
    }
    // ALLOWALL or unknown values are ignored by browsers.
  }
  return { embeddable: true, reason: 'No frame-blocking headers' };
}

// --- main -------------------------------------------------------------------

export async function checkUrl(input, options = {}) {
  const url = normalizeUrl(input);
  try {
    return await checkResolved(url, input, options);
  } catch (err) {
    // A bare host defaults to https; if that host only speaks plain http, try it.
    if (url.schemeAdded && err instanceof CheckError && err.code === 'network') {
      const httpUrl = new URL(url.href);
      httpUrl.protocol = 'http:';
      try {
        return await checkResolved(httpUrl, input, options);
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

async function checkResolved(url, input, options) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ourOrigin = null, allowPrivate = false } = options;
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const hops = [];
  let current = url;
  let response;

  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      await assertPublicHost(current, allowPrivate);
      try {
        response = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CheckError(`No response within ${Math.round(timeoutMs / 1000)}s.`, 'timeout');
        }
        const cause = err?.cause?.code || err?.code || '';
        const friendly =
          cause === 'ENOTFOUND'
            ? `Could not resolve ${current.hostname}.`
            : cause === 'ECONNREFUSED'
              ? `${current.hostname} refused the connection.`
              : cause.startsWith('ERR_TLS') || cause.includes('CERT')
                ? `TLS/certificate error connecting to ${current.hostname}.`
                : `Could not connect to ${current.hostname}.`;
        throw new CheckError(friendly, 'network');
      }

      const status = response.status;
      const location = response.headers.get('location');
      if (status >= 300 && status < 400 && location) {
        response.body?.cancel().catch(() => {});
        hops.push({ url: current.href, status });
        if (i === MAX_REDIRECTS) throw new CheckError('Too many redirects.', 'redirects');
        current = new URL(location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') {
          throw new CheckError(`Redirected to an unsupported scheme (${current.protocol}).`, 'scheme');
        }
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timer);
  }

  response.body?.cancel().catch(() => {});

  const xfo = response.headers.get('x-frame-options');
  const csp = response.headers.get('content-security-policy');
  const verdict = evaluateEmbeddability({
    xfo,
    csp,
    targetOrigin: current.origin,
    ourOrigin,
  });

  const contentType = response.headers.get('content-type') || '';
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);

  return {
    input: String(input).trim(),
    url: current.href,
    origin: current.origin,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirects: hops,
    contentType,
    isHtml,
    embeddable: verdict.embeddable,
    reason: verdict.reason,
    headers: {
      xFrameOptions: xfo,
      contentSecurityPolicy: csp,
      server: response.headers.get('server'),
    },
    timeMs: Date.now() - started,
  };
}

export function serializeError(err) {
  if (err instanceof CheckError) return { error: err.message, code: err.code };
  return { error: 'Unexpected error while checking the URL.', code: 'unknown' };
}
