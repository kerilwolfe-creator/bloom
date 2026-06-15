// api/_lib/auth.js
// Shared token verification for Bloom's API endpoints.
//
// Files/folders starting with "_" are NOT treated as routes by Vercel, so
// this can be safely imported by other api/*.js files without becoming its
// own endpoint.
//
// How it works:
// - api/auth.js checks a PIN (APP_PIN env var, never sent to the browser)
//   and, if correct, issues a token: `${timestamp}.${hmac(timestamp)}`
// - The browser stores this token and sends it as
//   `Authorization: Bearer <token>` on every call to a protected endpoint
// - requireAuth() here recomputes the HMAC using APP_TOKEN_SECRET (a
//   separate env var, also never sent to the browser) and checks it matches,
//   plus checks the token isn't older than MAX_AGE_MS
//
// Without knowing APP_TOKEN_SECRET, nobody can forge a valid token - even if
// they can see all of index.html's source code, since the secret never
// appears there.

import crypto from 'crypto';

const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

export function verifyToken(req) {
  const secret = process.env.APP_TOKEN_SECRET;
  if (!secret) return false;

  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!payload || !sig) return false;

  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  const issuedAt = Number(payload);
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > MAX_AGE_MS) return false;

  return true;
}

// Call at the top of a protected handler. Returns true if the request is
// authorized; if not, sends a 401 response itself and returns false - so
// the calling handler can just `if (!requireAuth(req, res)) return;`
export function requireAuth(req, res) {
  if (!verifyToken(req)) {
    res.status(401).json({ error: 'Unauthorized - missing or invalid token' });
    return false;
  }
  return true;
}
