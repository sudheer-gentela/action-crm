/**
 * postmasterAuthHelper.js — one-time setup helper for Phase 6.
 *
 * Mints a Google OAuth refresh token with the postmaster.readonly scope,
 * for PostmasterHealthService. Run LOCALLY (it opens a localhost callback):
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/postmasterAuthHelper.js
 *
 * Steps it performs:
 *   1. Prints a consent URL — open it in a browser, sign in with the Google
 *      account that owns the domains in postmaster.google.com.
 *   2. Catches the redirect on http://localhost:8765, exchanges the code.
 *   3. Prints the refresh token — set it on Railway as
 *      POSTMASTER_OAUTH_REFRESH_TOKEN.
 *
 * Prerequisites:
 *   - "Postmaster Tools API" enabled in the GCP project of the client id.
 *   - http://localhost:8765 added to the OAuth client's authorized redirect
 *     URIs (Web client), or use a "Desktop app" client which allows any
 *     localhost port.
 */

const http = require('http');

const CLIENT_ID = process.env.POSTMASTER_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.POSTMASTER_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/postmaster.readonly';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or POSTMASTER_OAUTH_*) first.');
  process.exit(1);
}

const consentUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

console.log('\n1) Open this URL and authorize with the Google account that owns your Postmaster domains:\n');
console.log(consentUrl);
console.log(`\n2) Waiting for the redirect on ${REDIRECT} ...\n`);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) {
    res.end(`Authorization failed: ${err}. You can close this tab.`);
    console.error('Authorization failed:', err);
    server.close(() => process.exit(1));
    return;
  }
  if (!code) { res.end('No code in callback.'); return; }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT,
      }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      res.end('Token exchange succeeded but no refresh_token returned — re-run (prompt=consent forces one).');
      console.error('No refresh_token in response:', JSON.stringify(data).slice(0, 300));
      server.close(() => process.exit(1));
      return;
    }
    res.end('Done — refresh token printed in your terminal. You can close this tab.');
    console.log('✅ Refresh token minted. Set this on Railway:\n');
    console.log(`POSTMASTER_OAUTH_REFRESH_TOKEN=${data.refresh_token}\n`);
    console.log('Then set per-org domains, e.g.:');
    console.log(`  UPDATE organizations SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{postmaster}', '{"domains":["gowarmcrm.com","gowarm.info"]}'::jsonb, true) WHERE id = <org id>;`);
    server.close(() => process.exit(0));
  } catch (e) {
    res.end('Token exchange failed — see terminal.');
    console.error('Token exchange failed:', e.message);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT);
