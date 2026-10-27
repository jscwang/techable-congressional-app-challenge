// api/_firestore-admin.js — Firestore over REST as a service account.
//
// The admin console has to read and write documents no browser session may
// touch (another user's verification status), so it cannot go through the
// client rules. The Firebase Admin SDK would need a package.json at the repo
// root, which changes how Vercel builds this site, so this signs a Google
// service-account JWT with node:crypto — the same way api/tts.js does for
// Cloud TTS — and calls the Firestore REST API with the token.
//
// FIREBASE_ADMIN_SA_KEY: the service-account JSON (raw or base64) of a key
// with the "Cloud Datastore User" role on the Firebase project. Server-only.
//
// Or, with no key at all (F37): the techable.org Google organisation enforces
// "Disable service account key creation", so no key can be made. Then the
// Vercel OIDC token every request carries is exchanged for a Google token
// (workload identity federation): STS turns it into a federated token for the
// pool and provider below, and iamcredentials turns that into a token for the
// service account. Nothing secret is stored; the four GCP_* values are ids.
//   GCP_PROJECT_NUMBER, GCP_WORKLOAD_IDENTITY_POOL_ID,
//   GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID, GCP_SERVICE_ACCOUNT_EMAIL
// A key, where one is set, wins.

import crypto from 'node:crypto'

const SCOPE = 'https://www.googleapis.com/auth/datastore'
const FEDERATION_ENV = ['GCP_PROJECT_NUMBER', 'GCP_WORKLOAD_IDENTITY_POOL_ID',
  'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'GCP_SERVICE_ACCOUNT_EMAIL']

// The account the admin endpoints act as: a key, or the federated service
// account. `req` supplies the Vercel OIDC token for the second.
export function adminServiceAccount(req) {
  return keyAccount() || federatedAccount(req)
}

// QA lookup remains read-only. Approval uses a separately authorized identity;
// configuring this id alone grants nothing in Google Cloud.
export function verificationServiceAccount(req) {
  const email = process.env.GCP_VERIFICATION_SERVICE_ACCOUNT_EMAIL || ''
  if (process.env.FIREBASE_PROJECT_ID === 'techable-qa') {
    if (!email || email === process.env.GCP_SERVICE_ACCOUNT_EMAIL
        || !/^[a-z0-9-]+@techable-qa\.iam\.gserviceaccount\.com$/.test(email)) return null
    return federatedAccount(req, email)
  }
  return email ? federatedAccount(req, email) : adminServiceAccount(req)
}

// For /api/config, which has no reason to read a token.
export function adminAccessConfigured() {
  return Boolean(keyAccount() || FEDERATION_ENV.every(k => process.env[k]))
}

function federatedAccount(req, email = process.env.GCP_SERVICE_ACCOUNT_EMAIL) {
  if (!FEDERATION_ENV.every(k => process.env[k])) return null
  const e = process.env
  return {
    client_email: email,
    project_id: e.FIREBASE_PROJECT_ID || '',
    federated: {
      audience: `//iam.googleapis.com/projects/${e.GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${e.GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${e.GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
      oidcToken: vercelOidcToken(req)
    }
  }
}

// Vercel puts it on every function request once OIDC federation is on for the
// project; @vercel/functions reads the same header from its request context.
// VERCEL_OIDC_TOKEN is what `vercel env pull` gives local development.
function vercelOidcToken(req) {
  const fromReq = req?.headers?.['x-vercel-oidc-token']
  if (fromReq) return String(fromReq)
  try {
    const ctx = globalThis[Symbol.for('@vercel/request-context')]?.get?.()
    const fromCtx = ctx?.headers?.['x-vercel-oidc-token']
    if (fromCtx) return String(fromCtx)
  } catch (_) {}
  return process.env.VERCEL_OIDC_TOKEN || ''
}

function keyAccount() {
  const raw = process.env.FIREBASE_ADMIN_SA_KEY
  if (!raw) return null
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
    const sa = JSON.parse(text)
    return sa.client_email && sa.private_key ? sa : null
  } catch (_) {
    console.error('[Techable] FIREBASE_ADMIN_SA_KEY is not valid JSON or base64 JSON')
    return null
  }
}

// One token per service account, reused until a minute before it expires.
const tokens = new Map()

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000)
  const cached = tokens.get(sa.client_email)
  if (cached && cached.exp > now + 60) return cached.value
  if (sa.federated) return federatedToken(sa, now)

  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'RS256', typ: 'JWT' })
  const claim = b64({
    iss: sa.client_email, scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key)

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig.toString('base64url')}`
    })
  })
  if (!r.ok) throw new Error(`oauth ${r.status}`)
  const json = await r.json()
  tokens.set(sa.client_email, { value: json.access_token, exp: now + (Number(json.expires_in) || 3600) })
  return json.access_token
}

async function federatedToken(sa, now) {
  const subject = sa.federated.oidcToken
  if (!subject) {
    throw new Error('no Vercel OIDC token: turn on OIDC Federation in the Vercel project settings and redeploy')
  }
  // Form-encoded, as RFC 8693 and Google's own auth library send it.
  const sts = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: sa.federated.audience,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: subject,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
    }).toString()
  })
  if (!sts.ok) throw new Error(`sts ${sts.status}: ${(await sts.text().catch(() => '')).slice(0, 200)}`)
  const federated = (await sts.json().catch(() => ({}))).access_token
  if (!federated) throw new Error('sts answered with no access_token')

  const r = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa.client_email)}:generateAccessToken`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${federated}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: [SCOPE], lifetime: '3600s' })
    }
  )
  if (!r.ok) throw new Error(`generateAccessToken ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const json = await r.json()
  const exp = Math.floor(Date.parse(json.expireTime) / 1000) || now + 3600
  tokens.set(sa.client_email, { value: json.accessToken, exp })
  return json.accessToken
}

function projectId(sa) {
  return process.env.FIREBASE_PROJECT_ID || sa.project_id || ''
}

function base(sa) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId(sa))}/databases/(default)/documents`
}

async function request(sa, url, options = {}) {
  const token = await accessToken(sa)
  const r = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  })
  if (r.status === 404) return null
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    throw new Error(`firestore ${r.status}: ${detail.slice(0, 200)}`)
  }
  return r.json()
}

// ── Values ──────────────────────────────────────────────────────────────────

export function fromValue(v) {
  if (!v || typeof v !== 'object') return null
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('timestampValue' in v) return Date.parse(v.timestampValue)
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue)
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {})
  return null
}

export function fromFields(fields = {}) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v)
  return out
}

function docId(name) {
  return String(name || '').split('/').pop()
}

// ── Operations ──────────────────────────────────────────────────────────────

// runQuery with a structuredQuery; returns [{ id, data }].
export async function query(sa, structuredQuery) {
  const rows = await request(sa, `${base(sa)}:runQuery`, {
    method: 'POST', body: JSON.stringify({ structuredQuery })
  }) || []
  return rows.filter(r => r.document).map(r => ({ id: docId(r.document.name), data: fromFields(r.document.fields) }))
}

export async function getDoc(sa, collection, id) {
  const doc = await request(sa, `${base(sa)}/${collection}/${encodeURIComponent(id)}`)
  return doc ? { id, data: fromFields(doc.fields) } : null
}

// The documents directly in a collection, a subcollection included (e.g.
// senior_link_directory/<key>/matches), up to `pageSize` of them.
export async function listDocs(sa, path, pageSize = 20) {
  const page = await request(sa, `${base(sa)}/${path}?pageSize=${encodeURIComponent(pageSize)}`)
  return (page?.documents || []).map(d => ({ id: docId(d.name), data: fromFields(d.fields) }))
}

// Writes only the named fields, and only to a document that already exists.
// `fields` holds Firestore Value objects, e.g. { status: { stringValue: 'x' } }.
// Names in `remove` are deleted from the document in the same write.
export async function updateFields(sa, collection, id, fields, { remove = [] } = {}) {
  const params = new URLSearchParams()
  for (const k of [...Object.keys(fields), ...remove]) params.append('updateMask.fieldPaths', k)
  params.set('currentDocument.exists', 'true')
  return request(sa, `${base(sa)}/${collection}/${encodeURIComponent(id)}?${params}`, {
    method: 'PATCH', body: JSON.stringify({ fields })
  })
}

// Writes only the named fields, creating the document if it does not exist.
export async function setFields(sa, collection, id, fields) {
  const params = new URLSearchParams()
  for (const k of Object.keys(fields)) params.append('updateMask.fieldPaths', k)
  return request(sa, `${base(sa)}/${collection}/${encodeURIComponent(id)}?${params}`, {
    method: 'PATCH', body: JSON.stringify({ fields })
  })
}
