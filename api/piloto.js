import { createHmac, timingSafeEqual } from 'node:crypto';

const roles = new Set(['pre1', 'pre2', 'sede1', 'sede2', 'cartera', 'admin']);
const reads = new Set(['iniciar', 'listado', 'tablero']);
const writes = new Set(['marcar', 'anular', 'alta']);
const cookieName = 'jean_piloto';
const sessionAge = 8 * 60 * 60;
const signature = (body, key) => createHmac('sha256', key).update('session:' + body).digest('base64url');

function currentProfile(req, key) {
  const cookie = (req.headers.cookie || '').split(/;\s*/).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const parts = cookie?.split('.') || [];
  if (parts.length !== 3) return null;
  const [profile, expiration, mac] = parts;
  const expected = signature(profile + '.' + expiration, key);
  if (!roles.has(profile) || !/^\d+$/.test(expiration) || Number(expiration) < Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? profile : null;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 24_000) throw new Error('body too large');
  }
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const reply = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') return reply(405, { error: 'Método no permitido.' });
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return reply(403, { error: 'Origen no autorizado.' });
    } catch { return reply(403, { error: 'Origen no autorizado.' }); }
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '') || Number(req.headers['content-length']) > 24_000) return reply(415, { error: 'Formato de solicitud inválido.' });
  const key = process.env.JEAN_WEBHOOK_TOKEN;
  if (!key) return reply(503, { error: 'La conexión del piloto está en configuración.' });
  let request;
  try { request = await readBody(req); } catch { return reply(400, { error: 'Solicitud inválida.' }); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return reply(400, { error: 'Solicitud inválida.' });
  const { action, input = {} } = request;
  const secure = process.env.VERCEL ? '; Secure' : '';
  if (action === 'sesion') {
    const profile = input?.profile;
    if (!roles.has(profile)) return reply(400, { error: 'Elige un perfil del piloto.' });
    const value = profile + '.' + (Date.now() + sessionAge * 1000);
    res.setHeader('Set-Cookie', cookieName + '=' + value + '.' + signature(value, key) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + sessionAge + secure);
    return reply(200, { profile });
  }
  if (action === 'salir') {
    res.setHeader('Set-Cookie', cookieName + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secure);
    return reply(200, { ok: true });
  }
  const profile = currentProfile(req, key);
  if (!profile) return reply(401, { error: 'Elige un perfil del piloto para continuar.' });
  const endpoint = reads.has(action) ? process.env.JEAN_READ_WEBHOOK : writes.has(action) ? process.env.JEAN_WRITE_WEBHOOK : null;
  if (!endpoint) return reply(400, { error: 'Operación no disponible.' });
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return reply(400, { error: 'Parámetros inválidos.' });
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jean-Key': key },
      body: JSON.stringify({ action, input, profile }),
      signal: AbortSignal.timeout(39000),
    });
    if (upstream.status >= 500 || upstream.status === 401) return reply(502, { error: 'La conexión con el registro no respondió. Intenta nuevamente.' });
    const result = await upstream.json();
    return reply(upstream.status, result);
  } catch {
    return reply(502, { error: 'La conexión con el registro no respondió. Intenta nuevamente.' });
  }
}
