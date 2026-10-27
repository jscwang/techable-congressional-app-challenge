// api/_admin.js — the admin passkey and the session tokens it signs.
//
// There is no admin account. Whoever knows ADMIN_PASSKEY (a Vercel env var) is
// the admin: api/admin-auth.js trades it for a token, admin.html keeps that
// token for the life of the tab, and any admin endpoint calls requireAdmin().
//
// This gate fails CLOSED, the opposite of _guard.js. An unset passkey means
// there is no admin, never an admin anyone can be; and one short enough to
// guess counts as unset.
//
// The token is `v1.<expiry ms>.<HMAC-SHA256 of the expiry>`, keyed by a key
// stretched from the passkey with scrypt. Keyed by the bare passkey, one token
// would let anyone who copied it test guesses offline at GPU speed, with no
// lockout in the way. Nothing is stored server-side, so sessions survive cold
// starts and span instances — and changing ADMIN_PASSKEY signs every session
// out at once, which is the only revocation there is.

import { createHmac, createHash, scryptSync, timingSafeEqual } from 'node:crypto'

export const MIN_PASSKEY_LENGTH = 12
export const SESSION_MS = 2 * 60 * 60 * 1000   // two hours

// Failed guesses per address before it is locked out, and for how long.
// Per instance and best-effort, like _guard.js: it stops one machine in a
// loop. A passkey long enough not to be guessed is the real defence.
export const MAX_FAILS = 5
export const LOCKOUT_MS = 15 * 60 * 1000
// Wrong guesses from ALL addresses together before sign-in pauses for
// everyone. Guesses spread over many addresses get past MAX_FAILS; this stops
// them, at the price that such an attack also keeps the real admin out until
// the window passes.
export const GLOBAL_MAX_FAILS = 30

const fails = new Map()
let allFails = { start: 0, n: 0 }
let warned = false

// Read on every call rather than at import, so a redeploy with a new passkey
// (and the tests) take effect without anything cached. Trimmed because a value
// pasted into the Vercel dashboard easily picks up a trailing newline.
export function adminPasskey() {
  const key = String(process.env.ADMIN_PASSKEY || '').trim()
  if (key.length >= MIN_PASSKEY_LENGTH) return key
  if (!warned) {
    warned = true
    console.warn(key
      ? `[Techable] ADMIN_PASSKEY is shorter than ${MIN_PASSKEY_LENGTH} characters — admin sign-in is disabled until it is longer.`
      : '[Techable] ADMIN_PASSKEY is not set — admin sign-in is disabled.')
  }
  return ''
}

// Hash both sides first so timingSafeEqual gets equal lengths and the time
// taken says nothing about how long the passkey is.
function sameSecret(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

// scrypt is slow on purpose (tens of ms), so derive once per passkey value.
let derived = { from: null, key: null }
function signingKey(passkey) {
  if (derived.from !== passkey) {
    derived = { from: passkey, key: scryptSync(passkey, 'techable-admin-session-v1', 32) }
  }
  return derived.key
}

function sign(passkey, exp) {
  return createHmac('sha256', signingKey(passkey)).update('techable-admin.v1.' + exp).digest('base64url')
}

export function passkeyMatches(given) {
  const key = adminPasskey()
  if (!key || typeof given !== 'string' || !given) return false
  return sameSecret(given.trim(), key)
}

export function issueAdminToken(now = Date.now()) {
  const key = adminPasskey()
  if (!key) return null
  const expiresAt = now + SESSION_MS
  return { token: `v1.${expiresAt}.${sign(key, expiresAt)}`, expiresAt }
}

// Returns the expiry (ms) of a valid token, or 0.
export function verifyAdminToken(token, now = Date.now()) {
  const key = adminPasskey()
  if (!key || typeof token !== 'string') return 0
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d{13}$/.test(parts[1])) return 0
  const exp = Number(parts[1])
  if (exp <= now || exp > now + SESSION_MS) return 0
  const want = Buffer.from(sign(key, exp))
  const got = Buffer.from(parts[2])
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 0
  return exp
}

export function bearerToken(req) {
  const auth = String((req.headers || {}).authorization || '')
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

// For admin endpoints: true when the caller holds a valid session. Otherwise
// answers 401 itself and returns false, so the handler just stops.
export function requireAdmin(req, res) {
  if (verifyAdminToken(bearerToken(req))) return true
  res.status(401).json({ error: 'Admin session required' })
  return false
}

// ── Where a request comes from ──────────────────────────────────────────────

// A browser on another site sends its own Origin. Refusing those, whatever
// ALLOWED_ORIGINS says, stops a hostile page turning each of its visitors into
// a fresh address with a fresh set of guesses. No Origin (curl, same-origin
// GET) is allowed: that caller could send any Origin it liked anyway.
export function sameSite(req) {
  const h = req.headers || {}
  if (!h.origin) return true
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase()
  try { return !!host && new URL(h.origin).host.toLowerCase() === host }
  catch { return false }
}

// The lockout key. IPv6 is cut to its /64, the block one customer is usually
// handed, so an attacker cannot take five fresh guesses per address in it.
function lockKey(ip) {
  ip = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return mapped[1]
  if (!ip.includes(':')) return ip
  const [head, tail] = ip.split('::')
  const a = head ? head.split(':') : []
  const b = tail ? tail.split(':') : []
  const groups = ip.includes('::')
    ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b]
    : a
  return groups.slice(0, 4).map(g => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64'
}

export function clientAddress(req) {
  const fwd = (req.headers || {})['x-forwarded-for']
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim()
  return lockKey(ip || req.socket?.remoteAddress || 'unknown')
}

// ── Failed-guess lockout ────────────────────────────────────────────────────

// Seconds until this address may try again, or 0 if it may try now.
export function lockedFor(req, now = Date.now()) {
  if (allFails.n >= GLOBAL_MAX_FAILS) {
    const left = allFails.start + LOCKOUT_MS - now
    if (left > 0) return Math.ceil(left / 1000)
    allFails = { start: 0, n: 0 }
  }
  const seen = fails.get(clientAddress(req))
  if (!seen || seen.n < MAX_FAILS) return 0
  const left = seen.start + LOCKOUT_MS - now
  if (left <= 0) { fails.delete(clientAddress(req)); return 0 }
  return Math.ceil(left / 1000)
}

export function recordFailure(req, now = Date.now()) {
  const key = clientAddress(req)
  const seen = fails.get(key)
  if (!seen || now - seen.start >= LOCKOUT_MS) fails.set(key, { start: now, n: 1 })
  else seen.n++
  if (now - allFails.start >= LOCKOUT_MS) allFails = { start: now, n: 1 }
  else allFails.n++
  if (fails.size > 5000) {
    for (const [k, v] of fails) if (now - v.start >= LOCKOUT_MS) fails.delete(k)
  }
}

// A right passkey clears its own address only; guesses from elsewhere still
// count towards GLOBAL_MAX_FAILS.
export function clearFailures(req) {
  fails.delete(clientAddress(req))
}

// For tests.
export function resetFailures() {
  fails.clear()
  allFails = { start: 0, n: 0 }
}
