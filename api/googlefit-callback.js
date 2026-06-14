// api/googlefit-callback.js
// Handle Google OAuth callback - exchange code for access & refresh tokens

// Must match the redirect URI used in googlefit-auth.js EXACTLY.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://project-numuh.vercel.app';

export default async function handler(req, res) {
  const { code, error } = req.query;

  // Check for errors Google sent back directly
  if (error) {
    return res.status(400).json({
      error: 'Authorization failed',
      details: error,
      message: 'Make sure you signed in with Email B (the one with Amazfit data in Google Fit) and clicked "Allow".'
    });
  }

  if (!code) {
    return res.status(400).json({
      error: 'No authorization code received',
      message: 'This usually means Google redirected here without you completing the consent screen, or the redirect_uri sent to Google does not exactly match what is registered in Google Cloud Console.',
      redirectUriUsed: `${APP_BASE_URL}/api/googlefit-callback`
    });
  }

  try {
    const clientId = process.env.GOOGLE_FIT_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_FIT_CLIENT_SECRET;
    const redirectUri = `${APP_BASE_URL}/api/googlefit-callback`;

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
      const errorText = await tokenResponse.text();
      console.error('Google token exchange failed:', errorText);
      return res.status(400).json({
        error: 'Token exchange failed',
        details: errorText,
        redirectUriUsed: redirectUri
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;

    // Return a simple HTML page so the tokens are easy to copy on mobile too
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Bloom - Google Fit Connected</title>
          <style>
            body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #3D2B1F; }
            .token-box { background: #FDF8F3; border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 10px 0; word-break: break-all; font-family: monospace; font-size: 12px; }
            .label { font-weight: bold; margin-top: 16px; }
            .copy-btn { background: #C8614A; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; margin-top: 6px; }
            ol { line-height: 1.8; }
          </style>
        </head>
        <body>
          <h2>✅ Google Fit Connected!</h2>
          <p>Copy these two values into your Vercel Environment Variables, then redeploy.</p>

          <div class="label">GOOGLE_FIT_ACCESS_TOKEN</div>
          <div class="token-box" id="access">${accessToken}</div>
          <button class="copy-btn" onclick="copyText('access')">Copy</button>

          <div class="label">GOOGLE_FIT_REFRESH_TOKEN</div>
          <div class="token-box" id="refresh">${refreshToken || 'none returned - try again with prompt=consent'}</div>
          <button class="copy-btn" onclick="copyText('refresh')">Copy</button>

          <p><em>Expires in: ${expiresIn} seconds (~${Math.round(expiresIn/3600)} hours). The refresh token lets Bloom get new access tokens automatically once that's wired up.</em></p>

          <div class="label">Next steps:</div>
          <ol>
            <li>Go to Vercel → bloom project → Settings → Environment Variables</li>
            <li>Add/update <code>GOOGLE_FIT_ACCESS_TOKEN</code> with the value above</li>
            <li>Add/update <code>GOOGLE_FIT_REFRESH_TOKEN</code> with the value above</li>
            <li>Redeploy</li>
            <li>Test: <code>/api/googlefit-sync?action=test</code></li>
          </ol>

          <script>
            function copyText(id) {
              const text = document.getElementById(id).innerText;
              navigator.clipboard.writeText(text);
              alert('Copied!');
            }
          </script>
        </body>
      </html>
    `);

  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).json({
      error: 'Server error during token exchange',
      details: err.message
    });
  }
}
