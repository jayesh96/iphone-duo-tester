// Vercel serverless function: GET /api/check?url=<url>
import { checkUrl, serializeError, CheckError } from '../lib/check.mjs';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed', code: 'method' });
    return;
  }
  const target = new URL(req.url, 'http://placeholder').searchParams.get('url');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const ourOrigin = host ? `${proto}://${host}` : null;
  try {
    const result = await checkUrl(target, { ourOrigin });
    res.status(200).json(result);
  } catch (err) {
    const body = serializeError(err);
    res.status(err instanceof CheckError ? 400 : 500).json(body);
  }
}
