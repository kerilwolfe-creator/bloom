// api/googlefit-auth.js
// Start Google Fit OAuth flow - user authorizes Bloom to read their fitness data

// IMPORTANT: process.env.VERCEL_URL is a PER-DEPLOYMENT url that changes every
// time you deploy (e.g. bloom-abc123-yourname.vercel.app). It will NEVER match
// a redirect URI registered in Google Cloud Console, which causes
// "Error 400: redirect_uri_mismatch" every time.
//
// Instead we use a stable base URL: either an env var you set once
// (APP_BASE_URL), or a hardcoded fallback to your production domain.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://project-numuh.vercel.app';

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  const redirectUri = `${APP_BASE_URL}/api/googlefit-callback`;

  if (!clientId) {
    return res.status(500).json({
      error: 'GOOGLE_FIT_CLIENT_ID not set in env vars',
      needed: ['GOOGLE_FIT_CLIENT_ID', 'GOOGLE_FIT_CLIENT_SECRET']
    });
  }

  // Build Google OAuth URL for Fitness API
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/fitness.body.read',
    redirect_uri: redirectUri,
    access_type: 'offline',
    prompt: 'consent'
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // Helpful for debugging: if ?debug=1 is passed, show the URL instead of redirecting
  if (req.query.debug) {
    return res.status(200).json({ redirectUri, authUrl });
  }

  // Redirect user to Google login
  // IMPORTANT: User should be logged in as Email B (the one with Amazfit data)
  res.redirect(307, authUrl);
}
