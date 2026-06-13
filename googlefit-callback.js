// api/googlefit-callback.js
// Handle Google OAuth callback - exchange code for access & refresh tokens

export default async function handler(req, res) {
  const { code, error, state } = req.query;

  // Check for errors
  if (error) {
    return res.status(400).json({
      error: 'Authorization failed',
      details: error,
      message: 'Make sure you signed in with Email B (the one with Amazfit data in Google Fit)'
    });
  }

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }

  try {
    const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;
    const vercelUrl = process.env.VERCEL_URL || 'localhost:3000';
    const redirectUri = `https://${vercelUrl}/api/googlefit-callback`;

    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: 'Missing Google Fit credentials',
        needed: ['GOOGLE_FIT_CLIENT_ID', 'GOOGLE_FIT_CLIENT_SECRET']
      });
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error('Google token exchange failed:', error);
      return res.status(400).json({
        error: 'Token exchange failed',
        details: error
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;

    return res.status(200).json({
      success: true,
      message: 'Authorization successful!',
      accessToken: accessToken,
      refreshToken: refreshToken,
      expiresIn: expiresIn,
      instructions: [
        '✓ Copy your ACCESS TOKEN below',
        '✓ Go to Vercel → Settings → Environment Variables',
        '✓ Add: GOOGLE_FIT_ACCESS_TOKEN = (your token)',
        '✓ Add: GOOGLE_FIT_REFRESH_TOKEN = (your token)',
        '✓ Redeploy',
        '✓ Your Amazfit data will sync automatically!'
      ],
      accessTokenShort: accessToken.substring(0, 20) + '...',
      refreshTokenShort: refreshToken ? refreshToken.substring(0, 20) + '...' : 'none'
    });

  } catch (error) {
    console.error('Callback error:', error);
    return res.status(500).json({
      error: 'Server error during token exchange',
      details: error.message
    });
  }
}
