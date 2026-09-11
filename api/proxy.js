// Vercel serverless function: /api/proxy?url=<url>  (any method)
import { proxyRequest } from '../lib/proxy.mjs';

export const config = { supportsResponseStreaming: true, maxDuration: 30 };

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/x-www-form-urlencoded')) return Buffer.from(new URLSearchParams(req.body).toString());
    return Buffer.from(JSON.stringify(req.body));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  const target = new URL(req.url, 'http://placeholder').searchParams.get('url');
  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? null : await readBody(req);
  const result = await proxyRequest({
    url: target,
    method,
    headers: req.headers,
    body,
    prefix: '/api/proxy',
    ourHost: req.headers['x-forwarded-host'] || req.headers.host,
  });
  res.writeHead(result.status, result.headers);
  if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) res.end(result.body);
  else result.body.pipe(res);
}
