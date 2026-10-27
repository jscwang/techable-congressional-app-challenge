// api/find-senior.js — a family member looks a senior up by email or username
// (audits/F32, findings 2 and 3).
//
// The family page used to read senior_link_directory itself. Its keys are an
// unsalted SHA-256 of the email or username, so any family account could test
// guesses — computed offline, unthrottled — for whether an address belongs to
// a senior on Techable; for a "username" it needed only the part of an email
// before the @. And every senior was in it, whether they wanted to be or not.
//
// firestore.rules lets no browser read the directory now. This reads it with
// the server's service account, for a signed-in family account, ten times in
// ten minutes at most, and finds only a senior whose record says
// findable: true ("Let my family find me"). What it returns is what the family
// page needs to ask to connect, which the rules check again on the request.
//
// POST { identifier }   Authorization: Bearer <Firebase ID token>
//   200 { seniorUid, residentId, managerUid, directoryKey }
//   400 not an email or username · 401 no or expired sign-in · 403 not a
//   family account · 404 nobody findable by it · 409 a username more than one
//   account uses · 429 too many lookups · 503 not set up
// A senior who is hidden, unknown or stale is the same 404, word for word.

import crypto from 'node:crypto'
import { guard } from './_guard.js'
import { adminServiceAccount, getDoc, listDocs } from './_firestore-admin.js'

const LOOKUPS_PER_WINDOW = 10
const WINDOW_MS = 10 * 60 * 1000

class RequestError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const NOT_FOUND = () => new RequestError(404, 'not-found', 'No senior can be found by that email or username.')

function requestBody(req) {
  if (typeof req.body !== 'string') return req.body || {}
  try { return JSON.parse(req.body) } catch (_) { return {} }
}

function bearerToken(req) {
  const header = req.headers?.authorization
  const value = Array.isArray(header) ? header[0] : header
  const match = /^Bearer\s+(.+)$/i.exec(String(value || ''))
  if (!match) throw new RequestError(401, 'signed-out', 'Please sign in again.')
  return match[1]
}

async function firebaseUser(req) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(process.env.FIREBASE_API_KEY)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: bearerToken(req) }) }
  )
  const data = await response.json().catch(() => ({}))
  const user = data?.users?.[0]
  if (!response.ok || !user?.localId) throw new RequestError(401, 'signed-out', 'Please sign in again.')
  return user
}

// Read exactly as app.js writes the directory key (normalizedLinkIdentifier).
function normalized(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^@/, '')
}

function directoryKey(kind, value) {
  return crypto.createHash('sha256').update(`${kind}:${value}`).digest('hex')
}

function usable(kind, value) {
  if (!value || /\s/.test(value)) return false
  return kind === 'email' ? value.length <= 254 && /^[^@]+@[^@]+$/.test(value) : value.length <= 64
}

// Per account, per instance. Best effort, like _guard.js's per-address limit,
// which applies too: it slows one account working through a list of guesses.
const lookups = new Map()
function limited(uid, now = Date.now()) {
  const seen = lookups.get(uid)
  if (!seen || now - seen.start >= WINDOW_MS) {
    lookups.set(uid, { start: now, n: 1 })
    if (lookups.size > 5000) {
      for (const [k, v] of lookups) if (now - v.start >= WINDOW_MS) lookups.delete(k)
    }
    return false
  }
  seen.n++
  return seen.n > LOOKUPS_PER_WINDOW
}

export default async function handler(req, res) {
  if (guard(req, res, 'POST, OPTIONS')) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const sa = adminServiceAccount(req)
    if (!sa || !process.env.FIREBASE_API_KEY) {
      throw new RequestError(503, 'not-configured', 'Finding a senior is not available just now.')
    }
    const user = await firebaseUser(req)
    const profile = await getDoc(sa, 'users', user.localId)
    if (profile?.data?.role !== 'family') {
      throw new RequestError(403, 'not-family', 'Only a family account can look a senior up.')
    }
    if (limited(user.localId)) {
      res.setHeader('Retry-After', String(Math.ceil(WINDOW_MS / 1000)))
      throw new RequestError(429, 'too-many', 'Too many tries. Please wait a few minutes.')
    }

    const identifier = normalized(requestBody(req).identifier)
    const kind = identifier.includes('@') ? 'email' : 'username'
    if (!usable(kind, identifier)) throw new RequestError(400, 'bad-identifier', 'Enter the senior\'s email address.')

    const key = directoryKey(kind, identifier)
    const matches = await listDocs(sa, `senior_link_directory/${key}/matches`, 3)
    if (matches.length > 1) {
      throw new RequestError(409, 'ambiguous', 'More than one account uses that username. Use their email address instead.')
    }
    const match = matches[0]?.data
    if (!match?.seniorUid || !match?.residentId) throw NOT_FOUND()

    // The record is the truth: theirs, and findable now — the directory may be
    // stale, and an entry is not a choice the senior made.
    const resident = (await getDoc(sa, 'residents', match.residentId))?.data
    const theirs = resident && (resident.ownerUid === match.seniorUid || resident.createdBy === match.seniorUid)
    if (!theirs || resident.findable !== true) throw NOT_FOUND()

    res.status(200).json({
      seniorUid: match.seniorUid,
      residentId: match.residentId,
      managerUid: typeof resident.centreId === 'string' ? resident.centreId : '',
      directoryKey: key
    })
  } catch (error) {
    const status = Number(error?.status) || 500
    if (!error?.code) console.error('[Techable] find-senior failed:', error?.message || error)
    res.status(status).json(error?.code
      ? { error: error.message, code: error.code }
      : { error: 'Looking a senior up failed. Please try again.', code: 'failed' })
  }
}
