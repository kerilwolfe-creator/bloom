// api/auth.js
// Checks a PIN against APP_PIN (env var, never sent to the browser) and, if
// correct, issues a signed token the browser can use to authenticate to the
// other protected endpoints (sheets, oura-expanded, googlefit-sync, insights).
//
// Required env vars:
//   APP_PIN          - the PIN/passphrase you choose, e.g. a short phrase
//   APP_TOKEN_SECRET - a separate random string used to sign tokens
//                       (generate once, e.g. with `openssl rand -hex 32`)
//
// Neither value is ever sent to the browser - APP_PIN is checked
// server-side, and APP_TOKEN_SECRET is only used to compute/verify HMACs.

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const correctPin = process.env.APP_PIN;
  const secret = process.env.APP_TOKEN_SECRET;

  if (!correctPin || !secret) {
    return res.status(500).json({
      error: 'Server not configured',
      message: 'APP_PIN and APP_TOKEN_SECRET must both be set as Vercel env vars.'
    });
  }

  const { pin } = req.body || {};

  if (!pin || String(pin) !== String(correctPin)) {
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  const payload = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = `${payload}.${sig}`;

  return res.status(200).json({ token });
}
