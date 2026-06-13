// api/googlefit-auth.js
// Start Google Fit OAuth flow - user authorizes Bloom to read their fitness data

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
  const vercelUrl = process.env.VERCEL_URL || 'localhost:3000';
  const redirectUri = `https://${vercelUrl}/api/googlefit-callback`;
  
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

  // Redirect user to Google login
  // IMPORTANT: User should be logged in as Email B (the one with Amazfit data)
  res.redirect(307, authUrl);
}
