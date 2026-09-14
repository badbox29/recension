/**
 * Recension — Cloudflare Worker
 *
 * Ported from the Remnant worker. The auth stack (Google JWT / HMAC / token
 * migration / hashed KV identity) is carried over unchanged in substance —
 * it was already correct. What is new here is the storage model.
 *
 * WHAT CHANGED FROM REMNANT
 *   1. HMAC_SALT      → 'recension-hmac-v1'. MUST match auth.js _deriveHmacKey()
 *                       exactly. They share no constant; a mismatch 401s every
 *                       /storage request with no obvious cause.
 *   2. Per-record KV   Remnant stored one blob per account. Recension stores one
 *                      key per scene/chapter/card/event. See §2 of the design doc.
 *   3. KV metadata     Every record write attaches metadata (updatedAt, title,
 *                      word count, status, parent). LIST returns it, so a client
 *                      renders the whole manuscript outline without fetching a
 *                      single body. This is what makes the mobile reader fast.
 *   4. Batch endpoints POST /bulk and /bulkwrite. Not an optimization — the
 *                      120-req/60s rate limit makes one-request-per-record
 *                      impossible (a 200-scene import would 429 partway).
 *   5. R2 blob routes  /blob/* for snapshots, archives, images. Proxied through
 *                      the Worker; no presigned URLs, no bucket CORS.
 *   6. Legacy-forward  Scoped to the account key only. It previously fired on a
 *                      GET of ANY key, which under per-record storage would
 *                      return the wrong record entirely.
 *   7. LIST            Now paginated (cursor) and returns metadata. Previously
 *                      truncated silently past 1000 keys.
 *
 * ENVIRONMENT (Cloudflare dashboard → Settings → Variables and Secrets)
 *   GOOGLE_CLIENT_ID   Secret. Google OAuth Client ID. Never shipped in frontend
 *                      source; the client fetches it at runtime via /auth/config.
 *   ALLOWED_ORIGINS    Variable. Comma-separated allowed origins.
 *
 * BINDINGS (Cloudflare dashboard → Settings → Bindings)
 *   RECENSION_KV       KV namespace  → recension-kv
 *   RECENSION_R2       R2 bucket     → recension-blobs  (public access DISABLED)
 *
 * ROUTES
 *   GET    /                          Health check (open CORS)
 *   GET    /ping                      Health check (open CORS)
 *   GET    /auth/config               Google Client ID for GIS bootstrap
 *   POST   /auth/google               Verify Google ID token
 *   POST   /auth/verify               Re-verify stored Google credential at boot
 *   POST   /auth/migrate              Token → Google migration (HMAC-authenticated)
 *
 *   GET    /storage/:token            List keys + metadata (paginated via ?cursor=)
 *   GET    /storage/:token/:key       Read one record
 *   PUT    /storage/:token/:key       Write one record (X-Meta header for metadata)
 *   DELETE /storage/:token/:key       Delete one record
 *   POST   /storage/:token/bulk       Read many   { ids: [...] }           max 100
 *   POST   /storage/:token/bulkwrite  Write many  { records: {...} }       max 50
 *
 *   GET    /blob/:token/*             Read an R2 object
 *   PUT    /blob/:token/*             Write an R2 object
 *   DELETE /blob/:token/*             Delete an R2 object
 *   GET    /blob/:token?prefix=       List R2 objects under a prefix
 *
 * BLOB REQUEST SIGNING — IMPORTANT
 *   For /storage, HMAC is computed over the request body, as in Remnant.
 *   For /blob, the body may be megabytes of binary, and the signed message
 *   format (METHOD:token:timestamp:sha256(body)) does not include the path —
 *   so a signature for one object would be valid for another.
 *   Therefore /blob signs the BLOB KEY STRING in place of the body:
 *       Auth._signRequest(method, token, blobKey)
 *   This binds the signature to the specific object, costs nothing for large
 *   uploads, and requires no change to auth.js's message format.
 */

const KV_BINDING          = 'RECENSION_KV';
const R2_BINDING          = 'RECENSION_R2';

const KV_TTL              = 60 * 60 * 24 * 1825; // 5 years, resets on every write
const HMAC_SALT           = 'recension-hmac-v1'; // MUST match auth.js. Never change after deploy.

const MAX_BODY_SIZE       = 5  * 1024 * 1024;    // 5 MB  — KV records and batches
const MAX_BLOB_SIZE       = 50 * 1024 * 1024;    // 50 MB — R2 archives and images
const MAX_META_SIZE       = 1024;                // Cloudflare KV metadata ceiling

const BULK_READ_MAX       = 100;
const BULK_WRITE_MAX      = 50;

const AUTH_RATE_LIMIT     = 20;
const AUTH_RATE_LIMIT_WIN = 3600;
const RATE_LIMIT          = 120;
const RATE_LIMIT_WINDOW   = 60;

// The single account/preferences record. Migration helpers are scoped to this
// key alone — see handleStorage GET.
const ACCOUNT_KEY         = '_account';

// ── Response helpers ───────────────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function err(message, status, cors, extra = {}) {
  return respond(JSON.stringify({ error: message }), status, { ...cors, ...extra });
}

// ── CORS ───────────────────────────────────────────────────────────────────

function buildCors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    // X-Meta carries per-record KV metadata on PUT.
    // X-Rev is retained for the account-key optimistic-concurrency check.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Signature, X-Rev, X-Meta',
    'Access-Control-Expose-Headers': 'X-Account-Migrated, X-Token-Migrated, X-RateLimit-Remaining, X-Rev',
    'Access-Control-Max-Age': '86400',
  };
}

function getAllowedOrigin(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins) return origin;
  const list = allowedOrigins.split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : (list[0] || '');
}

// ── Token validation ───────────────────────────────────────────────────────

function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{8,128})$/.test(token);
}

// ── KV key identity (token hashing) ────────────────────────────────────────
//
// The raw HMAC token IS the credential — it's the HMAC signing secret. Storing
// it verbatim as the key prefix meant a storage dump handed out usable
// credentials. So the STORAGE IDENTITY for a token account is the token's
// SHA-256 hash, not the token itself. A dump exposes hashes, which can't be
// used to forge signatures. Auth is unaffected: verifyHmac still uses the raw
// token, which only ever travels in the request, never into storage.
//
// Google tokens (google:{sub}) pass through unchanged — a Google sub is not a
// secret credential (auth there is the verified Google JWT).
//
// THIS APPLIES TO R2 AS WELL. Blob keys are prefixed with kvId(), never the
// raw token. Using the token there would reintroduce in R2 the exact hole
// that was closed in KV.

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function kvId(token) {
  return token.startsWith('google:') ? token : await sha256hex(token);
}

// ensureHashedPrefix(token, env) — one-time migration-on-access for data
// written before token hashing existed. Idempotent; short-circuits once the
// hashed profile/account record exists. Google tokens never need this.
//
// Metadata is preserved on copy: the outline rendering depends on it, and a
// migration that dropped it would leave the client unable to build the tree
// without fetching every body.
async function ensureHashedPrefix(token, env) {
  if (token.startsWith('google:')) return false;
  const kv     = env[KV_BINDING];
  const hashed = await kvId(token);
  const newPfx = `user:${hashed}:`;

  if (await kv.get(`${newPfx}${ACCOUNT_KEY}`, { type: 'text' }) !== null) return false;
  if (await kv.get(`${newPfx}profile`,        { type: 'text' }) !== null) return false;

  const rawPfx = `user:${token}:`;
  let cursor, migrated = false;
  do {
    const listed = await kv.list({ prefix: rawPfx, cursor });
    for (const k of listed.keys) {
      const sub = k.name.slice(rawPfx.length);
      const val = await kv.get(k.name, { type: 'text' });
      if (val !== null) {
        await kv.put(newPfx + sub, val, {
          expirationTtl: KV_TTL,
          ...(k.metadata ? { metadata: k.metadata } : {}),
        });
        await kv.delete(k.name);
        migrated = true;
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return migrated;
}

// ── IP rate limiting (auth routes) ─────────────────────────────────────────

async function checkIpRateLimit(env, ip) {
  const kv    = env[KV_BINDING];
  const key   = `rl:ip:${ip}`;
  const raw   = await kv.get(key, { type: 'text' });
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= AUTH_RATE_LIMIT) return false;
  await kv.put(key, String(count + 1), { expirationTtl: AUTH_RATE_LIMIT_WIN * 2 });
  return true;
}

// ── HMAC signing (mirrors auth.js exactly — salt MUST match) ───────────────
//
// Client side lives in auth.js _deriveHmacKey() / _signRequest().
// If you change HMAC_SALT here, change it there in the SAME commit.

async function deriveHmacKey(token) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HMAC_SALT), info: enc.encode('request-signing') },
    keyMat,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

// verifyHmac(request, token, signedPayload)
//   signedPayload is the request body for /storage routes, and the blob key
//   string for /blob routes (see the header note on blob request signing).
async function verifyHmac(request, token, signedPayload) {
  const timestamp = request.headers.get('X-Timestamp') || '';
  const signature = request.headers.get('X-Signature') || '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing HMAC headers' };
  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000)
    return { ok: false, reason: 'Timestamp expired' };

  const enc      = new TextEncoder();
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(signedPayload || '')))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const message = `${request.method.toUpperCase()}:${token}:${timestamp}:${bodyHash}`;
  try {
    const key      = await deriveHmacKey(token);
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Verification error' }; }
}

async function checkAuth(request, token, cors, requireHmac, signedPayload, env) {
  if (token.startsWith('google:')) {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return { ok: false, res: err('Authorization required', 401, cors) };
    const payload = await verifyGoogleJWT(idToken, env?.GOOGLE_CLIENT_ID);
    if (!payload) return { ok: false, res: err('Invalid or expired Google token', 401, cors) };
    if (token !== `google:${payload.sub}`) return { ok: false, res: err('Token mismatch', 403, cors) };
    return { ok: true };
  }
  const hmac = await verifyHmac(request, token, signedPayload);
  if (!hmac.ok && requireHmac)
    return { ok: false, res: err(`Auth failed: ${hmac.reason}`, 401, cors) };
  return { ok: true };
}

// ── Google JWT (RS256) ─────────────────────────────────────────────────────

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId) return null;
  try {
    const parts   = idToken.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp < now) return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub) return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!jwksRes.ok) return null;
    const jwks = await jwksRes.json();
    const jwk  = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey    = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig          = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid        = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, signingInput);
    if (!valid) return null;

    return { sub: payload.sub, email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  } catch (e) {
    console.error('[Auth] verifyGoogleJWT:', e);
    return null;
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors, ip) {
  const kv = env[KV_BINDING];

  if (url.pathname === '/auth/config' && method === 'GET') {
    return respond(JSON.stringify({ googleClientId: env.GOOGLE_CLIENT_ID || '' }), 200, cors);
  }

  if (!(await checkIpRateLimit(env, ip))) {
    return err('Too many requests — try again later', 429, cors);
  }

  if (url.pathname === '/auth/google' && method === 'POST') {
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return err('Invalid body', 400, cors); }
    if (!idToken) return err('idToken required', 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return err('Invalid or expired Google token', 401, cors);
    return respond(JSON.stringify({ ok: true, kvKey: `google:${p.sub}`, profile: p }), 200, cors);
  }

  if (url.pathname === '/auth/verify' && method === 'POST') {
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return err('Invalid body', 400, cors); }
    if (!idToken) return err('idToken required', 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ ok: false, error: 'Token expired or invalid' }), 401, cors);
    return respond(JSON.stringify({ ok: true, profile: p }), 200, cors);
  }

  // POST /auth/migrate — requires HMAC proof of old token ownership
  if (url.pathname === '/auth/migrate' && method === 'POST') {
    const bodyText = await readBodyText(request, MAX_BODY_SIZE);
    if (!bodyText) return err('Invalid body', 400, cors);
    let body;
    try { body = JSON.parse(bodyText); } catch { return err('Invalid JSON', 400, cors); }

    const { idToken, oldToken } = body || {};
    if (!idToken || !oldToken) return err('idToken and oldToken required', 400, cors);
    if (!isValidToken(oldToken)) return err('Invalid token format', 400, cors);

    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return err('Invalid or expired Google token', 401, cors);

    // Verify the caller controls oldToken — closes the gap where any
    // authenticated Google user could migrate a stranger's data.
    const hmac = await verifyHmac(request, oldToken, bodyText);
    if (!hmac.ok) return err('Cannot verify ownership of source token', 401, cors);

    const kvKey = `google:${p.sub}`;

    // One Google identity = one account
    const existingGoogle = await kv.get(`user:${kvKey}:${ACCOUNT_KEY}`, { type: 'text' });
    if (existingGoogle) return err('A Recension account already exists for this Google account. Sign in with Google instead.', 409, cors);

    await ensureHashedPrefix(oldToken, env);
    const idOld  = await kvId(oldToken);
    const oldPfx = `user:${idOld}:`;
    const newPfx = `user:${kvKey}:`;

    // Copy every record, preserving metadata. Under per-record storage this
    // loop is the whole migration, not an afterthought — it's moving the
    // entire manuscript.
    let copied = 0, cursor;
    do {
      const listed = await kv.list({ prefix: oldPfx, cursor });
      for (const k of listed.keys) {
        const sub = k.name.slice(oldPfx.length);
        const val = await kv.get(k.name, { type: 'text' });
        if (val === null) continue;

        let out = val;
        if (sub === ACCOUNT_KEY) {
          try {
            const acct = JSON.parse(val);
            acct.authMethod   = 'google';
            acct.linkedGoogle = p;
            acct.lastModified = Date.now();
            out = JSON.stringify(acct);
          } catch { /* copy verbatim if unparseable */ }
        }
        await kv.put(newPfx + sub, out, {
          expirationTtl: KV_TTL,
          ...(k.metadata ? { metadata: k.metadata } : {}),
        });
        copied++;
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    if (!copied) return err('Source account not found', 404, cors);

    // Migrate R2 blobs (snapshots, archives, images) to the new identity.
    // Without this, a Google upgrade silently orphans the entire history.
    await migrateBlobs(idOld, kvKey, env);

    await kv.put(`migrated:${oldToken}`, kvKey, { expirationTtl: 60 * 60 * 24 * 90 });

    // Remove the source key space now that it's copied. The migrated:
    // tombstone above is what redirects the old device to Google.
    let delCursor;
    do {
      const del = await kv.list({ prefix: oldPfx, cursor: delCursor });
      for (const k of del.keys) await kv.delete(k.name);
      delCursor = del.list_complete ? undefined : del.cursor;
    } while (delCursor);

    return respond(JSON.stringify({ ok: true, kvKey, profile: p, recordsCopied: copied }), 200, cors);
  }

  return null;
}

// migrateBlobs(fromId, toId, env) — copy every R2 object from one identity
// prefix to another, then delete the originals. Best-effort: a failure here
// leaves blobs under the old prefix rather than losing them.
async function migrateBlobs(fromId, toId, env) {
  const r2 = env[R2_BINDING];
  if (!r2) return;
  for (const kind of ['snap', 'archive', 'img']) {
    const oldPfx = `${kind}/${fromId}/`;
    const newPfx = `${kind}/${toId}/`;
    let cursor;
    do {
      const listed = await r2.list({ prefix: oldPfx, cursor });
      for (const o of listed.objects) {
        const obj = await r2.get(o.key);
        if (!obj) continue;
        await r2.put(newPfx + o.key.slice(oldPfx.length), obj.body, {
          httpMetadata: obj.httpMetadata,
          customMetadata: obj.customMetadata,
        });
        await r2.delete(o.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
}

// ── Storage handler ────────────────────────────────────────────────────────

async function handleStorage(request, env, pathname, cors, url) {
  if (!env[KV_BINDING]) return err('KV not configured', 500, cors);

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return err('Token required', 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return err('Invalid token format', 400, cors);

  const rlErr = await checkStorageRateLimit(token, env, cors);
  if (rlErr) return rlErr;

  await ensureHashedPrefix(token, env);
  const id = await kvId(token);

  // ── GET /storage/:token — list keys with metadata ──────────────────────
  if (parts.length === 2 && request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    return await listKeys(id, env, cors, url.searchParams.get('cursor'));
  }

  if (parts.length < 3) return err('Key required', 400, cors);

  // ── POST /storage/:token/bulk — read many ──────────────────────────────
  if (parts[2] === 'bulk' && request.method === 'POST') {
    const bodyText = await readBodyText(request, MAX_BODY_SIZE);
    if (bodyText === null) return err('Invalid or oversized body', 400, cors);
    const auth = await checkAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.res;

    let ids;
    try { ids = JSON.parse(bodyText).ids; } catch { return err('Invalid JSON', 400, cors); }
    if (!Array.isArray(ids)) return err('ids must be an array', 400, cors);
    if (ids.length > BULK_READ_MAX) return err(`Too many ids (max ${BULK_READ_MAX})`, 400, cors);

    const values = {}, missing = [];
    // Sequential rather than Promise.all: a 100-key fan-out against KV from a
    // single Worker invocation risks subrequest limits, and these are fast.
    for (const rawKey of ids) {
      if (!isValidUserKey(rawKey)) { missing.push(rawKey); continue; }
      const v = await env[KV_BINDING].get(`user:${id}:${rawKey}`, { type: 'text' });
      if (v === null) { missing.push(rawKey); continue; }
      try { values[rawKey] = JSON.parse(v); } catch { missing.push(rawKey); }
    }
    return respond(JSON.stringify({ values, missing }), 200, cors);
  }

  // ── POST /storage/:token/bulkwrite — write many ────────────────────────
  //
  // NOT a transaction. KV has no multi-key atomicity, so this reports
  // per-record success and the client clears only confirmed ids from its
  // dirty set. Pretending otherwise would be worse than reporting honestly.
  if (parts[2] === 'bulkwrite' && request.method === 'POST') {
    const bodyText = await readBodyText(request, MAX_BODY_SIZE);
    if (bodyText === null) return err('Invalid or oversized body', 400, cors);
    const auth = await checkAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.res;

    let records;
    try { records = JSON.parse(bodyText).records; } catch { return err('Invalid JSON', 400, cors); }
    if (!records || typeof records !== 'object') return err('records must be an object', 400, cors);

    const entries = Object.entries(records);
    if (entries.length > BULK_WRITE_MAX) return err(`Too many records (max ${BULK_WRITE_MAX})`, 400, cors);

    const ok = [], failed = {};
    for (const [rawKey, payload] of entries) {
      if (!isValidUserKey(rawKey)) { failed[rawKey] = 'Invalid key format'; continue; }
      if (!payload || typeof payload !== 'object' || !('value' in payload)) {
        failed[rawKey] = 'Missing value'; continue;
      }
      const metaErr = validateMeta(payload.meta);
      if (metaErr) { failed[rawKey] = metaErr; continue; }
      try {
        await env[KV_BINDING].put(
          `user:${id}:${rawKey}`,
          JSON.stringify(payload.value),
          { expirationTtl: KV_TTL, ...(payload.meta ? { metadata: payload.meta } : {}) }
        );
        ok.push(rawKey);
      } catch (e) {
        failed[rawKey] = String(e?.message || 'Write failed');
      }
    }
    return respond(JSON.stringify({ ok, failed }), 200, cors);
  }

  // ── Single-record routes ───────────────────────────────────────────────

  const userKey = parts.slice(2).join('/');
  if (!isValidUserKey(userKey)) return err('Invalid key format', 400, cors);

  const kvKey = `user:${id}:${userKey}`;

  if (request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;

    // Migration helpers are scoped to the ACCOUNT KEY ONLY.
    //
    // In Remnant these fired on a GET of any key, which was correct when an
    // account was a single blob. Under per-record storage, an unscoped
    // legacy-forward would answer a request for `scene:a1` with the forwarded
    // account's data — returning the wrong record entirely.
    if (userKey === ACCOUNT_KEY) {
      const { remaining } = await rateLimitCount(token, env);
      const tombRes = await checkMigrationTombstone(token, env, cors, remaining);
      if (tombRes) return tombRes;
      const fwdRes = await checkLegacyForward(token, env, cors, remaining);
      if (fwdRes) return fwdRes;
    }

    const value = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (value === null) return err('Not found', 404, cors);
    return respond(JSON.stringify({ value: JSON.parse(value) }), 200, cors);
  }

  if (request.method === 'PUT') {
    const bodyText = await readBodyText(request, MAX_BODY_SIZE);
    if (bodyText === null) return err('Invalid or oversized body', 400, cors);
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { return err('Invalid JSON', 400, cors); }

    const auth = await checkAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.res;

    // Per-record metadata, sent as a JSON X-Meta header. This is what LIST
    // returns and what lets a client render the manuscript outline without
    // fetching bodies. See §3 of the design doc.
    let meta = null;
    const metaHeader = request.headers.get('X-Meta');
    if (metaHeader) {
      try { meta = JSON.parse(metaHeader); } catch { return err('Invalid X-Meta JSON', 400, cors); }
      const metaErr = validateMeta(meta);
      if (metaErr) return err(metaErr, 400, cors);
    }

    if (userKey === ACCOUNT_KEY) {
      parsed = await writeLegacyPointer(parsed, token, env);

      // Optimistic concurrency, account record only. The client sends X-Rev =
      // the rev it based its merge on; if the stored rev moved, reject with 409
      // so the client re-pulls and re-merges instead of clobbering.
      //
      // Deliberately NOT extended to content records: per-record updatedAt
      // merging via reconcileById already resolves those, and 409-retry loops
      // across hundreds of keys would add large failure surface for no gain.
      const currentRaw = await env[KV_BINDING].get(kvKey, { type: 'text' });
      let currentRev = 0;
      if (currentRaw) { try { currentRev = JSON.parse(currentRaw)._rev || 0; } catch {} }
      const clientRev = request.headers.get('X-Rev');
      if (clientRev !== null && parseInt(clientRev, 10) !== currentRev) {
        return respond(JSON.stringify({ error: 'Conflict', rev: currentRev }), 409, { ...cors, 'X-Rev': String(currentRev) });
      }
      parsed._rev = currentRev + 1;
    }

    await env[KV_BINDING].put(kvKey, JSON.stringify(parsed), {
      expirationTtl: KV_TTL,
      ...(meta ? { metadata: meta } : {}),
    });
    return respond(JSON.stringify({ ok: true, rev: parsed._rev }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    await env[KV_BINDING].delete(kvKey);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return err('Method not allowed', 405, cors);
}

function isValidUserKey(k) {
  return typeof k === 'string' && /^[a-zA-Z0-9_\-./:]{1,256}$/.test(k);
}

// validateMeta(meta) — returns an error string, or null if acceptable.
// Cloudflare caps serialized KV metadata at 1024 bytes; exceeding it fails the
// put at the platform level, so catch it here with a clear message.
function validateMeta(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return 'meta must be an object';
  const size = new TextEncoder().encode(JSON.stringify(meta)).length;
  if (size > MAX_META_SIZE) return `meta too large (${size} > ${MAX_META_SIZE} bytes)`;
  return null;
}

// listKeys — returns key names WITH metadata, paginated.
//
// Metadata is the point: it carries updatedAt, title, word count, status and
// parent id, so one call gives a client everything needed to render the full
// manuscript outline before fetching a single body.
//
// Pagination matters too. The previous implementation reported list_complete
// without exposing a cursor, so anything past 1000 keys silently vanished.
async function listKeys(id, env, cors, cursor) {
  const prefix = `user:${id}:`;
  const list   = await env[KV_BINDING].list({ prefix, ...(cursor ? { cursor } : {}) });
  return respond(JSON.stringify({
    keys: list.keys.map(k => ({
      key:        k.name.slice(prefix.length),
      metadata:   k.metadata || null,
      expiration: k.expiration,
    })),
    list_complete: list.list_complete,
    cursor: list.list_complete ? null : list.cursor,
  }), 200, cors);
}

// ── R2 blob handler ────────────────────────────────────────────────────────
//
// Snapshots, project archives, and images. Proxied through the Worker rather
// than presigned: same HMAC auth as /storage, no bucket CORS, no second
// credential path. Tradeoff is Worker request-size limits on upload, which is
// irrelevant for reference photos and compressed-text archives.
//
// SIGNING: the signed payload is the BLOB KEY STRING, not the body. See the
// file header for why. The client calls:
//     Auth._signRequest(method, token, blobKey)

async function handleBlob(request, env, pathname, cors, url) {
  if (!env[R2_BINDING]) return err('R2 not configured', 500, cors);

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return err('Token required', 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return err('Invalid token format', 400, cors);

  const rlErr = await checkStorageRateLimit(token, env, cors);
  if (rlErr) return rlErr;

  const id = await kvId(token);
  const r2 = env[R2_BINDING];

  // GET /blob/:token?prefix=snap/<sceneId>/ — list objects
  if (parts.length === 2 && request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, '', env);
    if (!auth.ok) return auth.res;

    const rawPrefix = url.searchParams.get('prefix') || '';
    if (rawPrefix && !isValidBlobKey(rawPrefix)) return err('Invalid prefix', 400, cors);

    const scoped = scopeBlobKey(rawPrefix, id);
    if (!scoped) return err('Invalid prefix', 400, cors);

    const out = [];
    let cursor;
    do {
      const listed = await r2.list({ prefix: scoped, cursor });
      for (const o of listed.objects) {
        out.push({ key: unscopeBlobKey(o.key, id), size: o.size, uploaded: o.uploaded });
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor && out.length < 5000);
    return respond(JSON.stringify({ objects: out }), 200, cors);
  }

  if (parts.length < 3) return err('Key required', 400, cors);

  const blobKey = parts.slice(2).join('/');
  if (!isValidBlobKey(blobKey)) return err('Invalid key format', 400, cors);

  const scoped = scopeBlobKey(blobKey, id);
  if (!scoped) return err('Invalid key format', 400, cors);

  // Signed payload is the blob key — binds the signature to this object.
  const auth = await checkAuth(request, token, cors, true, blobKey, env);
  if (!auth.ok) return auth.res;

  if (request.method === 'GET') {
    const obj = await r2.get(scoped);
    if (!obj) return err('Not found', 404, cors);
    const headers = new Headers(cors);
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    return new Response(obj.body, { status: 200, headers });
  }

  if (request.method === 'PUT') {
    const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (cl > MAX_BLOB_SIZE) return err('Blob too large', 413, cors);
    if (!request.body) return err('Empty body', 400, cors);

    await r2.put(scoped, request.body, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
    return respond(JSON.stringify({ ok: true, key: blobKey }), 200, cors);
  }

  if (request.method === 'DELETE') {
    await r2.delete(scoped);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return err('Method not allowed', 405, cors);
}

// Blob keys are client-supplied paths like 'snap/<sceneId>/<iso>.json' or
// 'archive/2026-03.zip'. The identity segment is inserted server-side so a
// client can never reach another account's objects.
function isValidBlobKey(k) {
  return typeof k === 'string'
    && /^[a-zA-Z0-9_\-./:]{1,512}$/.test(k)
    && !k.includes('..');
}

const BLOB_KINDS = ['snap', 'archive', 'img'];

function scopeBlobKey(key, id) {
  const slash = key.indexOf('/');
  const kind  = slash === -1 ? key : key.slice(0, slash);
  if (!BLOB_KINDS.includes(kind)) return null;
  const rest = slash === -1 ? '' : key.slice(slash + 1);
  return `${kind}/${id}/${rest}`;
}

function unscopeBlobKey(scoped, id) {
  return scoped.replace(`/${id}/`, '/');
}

// ── Migration helpers ──────────────────────────────────────────────────────
// Both are called ONLY for the account key — see handleStorage GET.

async function checkMigrationTombstone(token, env, cors, remaining) {
  const migratedTo = await env[KV_BINDING].get(`migrated:${token}`, { type: 'text' });
  if (!migratedTo) return null;
  return respond(
    JSON.stringify({ migrated: true, authMethod: 'google' }),
    410,
    { ...cors, 'X-Account-Migrated': 'google', 'X-RateLimit-Remaining': String(remaining) }
  );
}

async function checkLegacyForward(token, env, cors, remaining) {
  const forwardTo = await env[KV_BINDING].get(`legacy:${token}`, { type: 'text' });
  if (!forwardTo) return null;
  const newId   = await kvId(forwardTo);
  const newData = await env[KV_BINDING].get(`user:${newId}:${ACCOUNT_KEY}`, { type: 'text' });
  if (!newData) return null;
  return respond(
    JSON.stringify({ value: JSON.parse(newData) }),
    200,
    { ...cors, 'X-Token-Migrated': forwardTo, 'X-RateLimit-Remaining': String(remaining) }
  );
}

async function writeLegacyPointer(parsed, newToken, env) {
  const legacy = parsed._legacyToken;
  if (legacy && typeof legacy === 'string' && isValidToken(legacy) && legacy !== newToken) {
    delete parsed._legacyToken;
    await env[KV_BINDING].put(`legacy:${legacy}`, newToken, { expirationTtl: 60 * 60 * 24 * 90 });
  } else {
    delete parsed._legacyToken;
  }
  return parsed;
}

// ── Rate limiting (storage) ────────────────────────────────────────────────
//
// 120 requests per 60s per account. Batch endpoints count as ONE request each,
// which is what makes per-record storage viable — a 200-scene import is 4
// requests, not 200.
//
// Known weakness: this is a read-modify-write on one key, so concurrent
// requests can undercount. It fails permissive rather than restrictive, and
// batching keeps concurrency low enough that it doesn't matter in practice.
// Durable Objects would fix it properly if this ever becomes multi-user.

async function checkStorageRateLimit(token, env, cors) {
  const rlKey  = `ratelimit:${await kvId(token)}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  if (ts.length >= RATE_LIMIT) return err('Rate limit exceeded — please wait', 429, cors);
  ts.push(now);
  await env[KV_BINDING].put(rlKey, JSON.stringify(ts), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return null;
}

async function rateLimitCount(token, env) {
  const rlKey  = `ratelimit:${await kvId(token)}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  return { remaining: Math.max(0, RATE_LIMIT - ts.length) };
}

// ── Body helpers ───────────────────────────────────────────────────────────

async function readBodyText(request, limit) {
  const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (cl > limit) return null;
  try {
    const text = await request.text();
    return text.length > limit ? null : text;
  } catch { return null; }
}

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const method = request.method;
    const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';

    const origin = getAllowedOrigin(request, env.ALLOWED_ORIGINS);
    const cors   = buildCors(origin);

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return respond(JSON.stringify({ ok: true, service: 'Recension' }), 200, buildCors('*'));
    }

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname.startsWith('/auth/')) {
        const res = await handleAuth(url, method, request, env, cors, ip);
        if (res) return res;
        return err('Not found', 404, cors);
      }

      if (url.pathname.startsWith('/blob')) {
        return await handleBlob(request, env, url.pathname.replace(/\/$/, ''), cors, url);
      }

      if (url.pathname.startsWith('/storage')) {
        return await handleStorage(request, env, url.pathname.replace(/\/$/, ''), cors, url);
      }

      return err('Not found', 404, cors);
    } catch (e) {
      console.error('[Worker]', e);
      return err('Internal error', 500, cors);
    }
  },
};
