// Plain Node server: serves the static site and the /api/check endpoint.
// Usage: node server.mjs        (PORT defaults to 3000)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUrl, serializeError, CheckError } from './lib/check.mjs';
import { proxyRequest } from './lib/proxy.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;
const allowPrivate = process.env.ALLOW_PRIVATE === '1';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/check') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    try {
      const result = await checkUrl(url.searchParams.get('url'), {
        ourOrigin: `http://${req.headers.host}`,
        allowPrivate,
      });
      res.writeHead(200).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err instanceof CheckError ? 400 : 500).end(JSON.stringify(serializeError(err)));
    }
    return;
  }

  if (url.pathname === '/api/proxy') {
    const method = req.method || 'GET';
    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }
    const result = await proxyRequest({
      url: url.searchParams.get('url'),
      method,
      headers: req.headers,
      body,
      prefix: '/api/proxy',
      ourHost: req.headers.host,
      allowPrivate,
    });
    res.writeHead(result.status, result.headers);
    if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) res.end(result.body);
    else result.body.pipe(res);
    return;
  }

  let filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = path.join(filePath, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`iPhone Duo lab running at http://localhost:${port}`);
});
