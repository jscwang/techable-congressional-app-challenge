// Creates short-lived Supabase Storage upload URLs for Firebase-authenticated
// registration users. The Supabase secret key remains server-side; the browser
// receives a URL scoped to one generated object path and valid for two hours.
//
// F09-2: who may upload is decided from users/{uid}.role, read with the
// service account (FIREBASE_ADMIN_SA_KEY, the same helper api/find-senior.js
// uses), never from the role the browser sends. It used to trust body.role, so
// any free resident or family account could mint signed 10 MB upload URLs into
// the private bucket. Without the service account there is no way to check,
// so uploads fail closed (503) and api/config.js stops offering them.
//
// One gap is deliberate: login.html and provider-login.html upload BEFORE
// ensureUserDoc() writes users/{uid} (the document count is part of that first
// write). So an account with NO profile may upload only while it is brand new
// (REGISTRATION_WINDOW_MS after Firebase created it) — a sign-up in progress.
// Any account with a profile must hold the role it is uploading for.

import { randomUUID } from 'node:crypto'
import { guard } from './_guard.js'
import { adminServiceAccount, getDoc } from './_firestore-admin.js'

const REGISTRATION_WINDOW_MS = 15 * 60 * 1000
const MAX_FILE_SIZE = 10 * 1024 * 1024
const MAX_DELETE_PATHS = 10
const ALLOWED_ROLES = new Set(['community_manager', 'service_provider'])
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
])

class RequestError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

function requestBody(req) {
  if (typeof req.body !== 'string') return req.body || {}
  try { return JSON.parse(req.body) } catch (_) { return {} }
}

function bearerToken(req) {
  const header = req.headers?.authorization
  const value = Array.isArray(header) ? header[0] : header
  const match = /^Bearer\s+(.+)$/i.exec(String(value || ''))
  if (!match) throw new RequestError(401, 'A Firebase sign-in is required')
  return match[1]
}

async function firebaseUser(req) {
  const apiKey = process.env.FIREBASE_API_KEY
  if (!apiKey) throw new RequestError(503, 'Firebase authentication is not configured')

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: bearerToken(req) })
    }
  )
  const data = await response.json().catch(() => ({}))
  const user = data?.users?.[0]
  if (!response.ok || !user?.localId) throw new RequestError(401, 'Your sign-in has expired. Please sign in again.')
  return user
}

// The same mapping as normalizeRole() in auth.js and canonicalRole() in
// firestore.rules: legacy aliases collapse to their current name.
function canonicalRole(role) {
  if (role === 'community_manager' || role === 'centre') return 'community_manager'
  if (role === 'service_provider' || role === 'provider') return 'service_provider'
  if (role === 'family') return 'family'
  return 'resident'
}

// Throws unless this account may upload documents for `role`. A failed read
// throws too (500, no detail): it must never be mistaken for "no profile".
async function assertUploadRole(sa, user, role) {
  const profile = await getDoc(sa, 'users', user.localId)
  if (profile) {
    if (canonicalRole(profile.data?.role) !== role) {
      throw new RequestError(403, 'Only a community manager or service provider account can upload verification documents', 'wrong-role')
    }
    return
  }
  const createdAt = Number(user.createdAt)
  const age = Date.now() - createdAt
  // Not a wrong role: a sign-up that never finished (the sign-up pages now
  // delete the account when that happens, but older ones exist). Say so.
  if (!Number.isFinite(createdAt) || age < 0 || age > REGISTRATION_WINDOW_MS) {
    throw new RequestError(403,
      'This account\'s sign-up was not finished, so documents cannot be uploaded to it. ' +
      'Please sign up again with a new account, or contact Techable support to finish this one.', 'no-profile')
  }
}

function storageConfig() {
  const rawUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
  const secret = process.env.SUPABASE_SECRET_KEY || ''
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'verification-documents'
  if (!rawUrl || !secret) throw new RequestError(503, 'Verification document storage is not configured')
  if (!/^[-a-zA-Z0-9_]+$/.test(bucket)) throw new RequestError(503, 'Verification storage bucket is invalid')

  let url
  try { url = new URL(rawUrl) } catch (_) { throw new RequestError(503, 'Supabase URL is invalid') }
  if (url.protocol !== 'https:') throw new RequestError(503, 'Supabase URL must use HTTPS')
  return { base: `${rawUrl}/storage/v1`, secret, bucket }
}

function safeFileName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-180) || 'document'
}

function encodedPath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function ownedPath(path, uid, role) {
  const prefix = `verificationDocuments/${uid}/${role}/`
  return typeof path === 'string' && path.startsWith(prefix) && !path.includes('\\') && !path.includes('../')
}

async function createSignedUpload(req, res, config, user, body) {
  const role = String(body.role || '')
  const type = String(body.type || '').toLowerCase()
  const size = Number(body.size)
  if (!ALLOWED_ROLES.has(role)) throw new RequestError(400, 'Invalid registration role')
  if (!ALLOWED_TYPES.has(type)) throw new RequestError(400, 'Unsupported verification document type')
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
    throw new RequestError(400, 'Verification documents must be 10 MB or smaller')
  }

  const sa = adminServiceAccount(req)
  if (!sa) throw new RequestError(503, 'Verification document upload is not configured')
  await assertUploadRole(sa, user, role)

  const path = `verificationDocuments/${user.localId}/${role}/${Date.now()}-${randomUUID()}-${safeFileName(body.name)}`
  const response = await fetch(
    `${config.base}/object/upload/sign/${encodeURIComponent(config.bucket)}/${encodedPath(path)}`,
    {
      method: 'POST',
      headers: { apikey: config.secret, 'Content-Type': 'application/json' },
      body: '{}'
    }
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data?.url) {
    console.error('[Techable] Supabase signed upload failed:', response.status, data?.message || data?.error || '')
    throw new RequestError(502, 'Could not prepare document upload')
  }

  const signedUrl = /^https:\/\//i.test(data.url) ? data.url : `${config.base}${data.url.startsWith('/') ? '' : '/'}${data.url}`
  res.status(200).json({ signedUrl, path, bucket: config.bucket })
}

async function deleteUploads(res, config, user, body) {
  const role = String(body.role || '')
  const paths = Array.isArray(body.paths) ? [...new Set(body.paths)] : []
  if (!ALLOWED_ROLES.has(role) || !paths.length || paths.length > MAX_DELETE_PATHS) {
    throw new RequestError(400, 'Invalid document deletion request')
  }
  if (!paths.every(path => ownedPath(path, user.localId, role))) {
    throw new RequestError(403, 'Documents can only be removed by their owner')
  }

  const response = await fetch(`${config.base}/object/${encodeURIComponent(config.bucket)}`, {
    method: 'DELETE',
    headers: { apikey: config.secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths })
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    console.error('[Techable] Supabase delete failed:', response.status, data?.message || data?.error || '')
    throw new RequestError(502, 'Could not remove uploaded documents')
  }
  res.status(200).json({ deleted: paths.length })
}

export default async function handler(req, res) {
  if (guard(req, res, 'POST, DELETE, OPTIONS')) return
  if (!['POST', 'DELETE'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  try {
    const config = storageConfig()
    const user = await firebaseUser(req)
    const body = requestBody(req)
    if (req.method === 'POST') await createSignedUpload(req, res, config, user, body)
    else await deleteUploads(res, config, user, body)
  } catch (error) {
    const status = Number(error?.status) || 500
    if (status >= 500) console.error('[Techable] verification storage failed:', error?.message || error)
    // Only our own RequestError messages reach the browser: an unexpected one
    // (a failed Firestore read) can carry backend detail.
    res.status(status).json(error instanceof RequestError
      ? { error: error.message, ...(error.code ? { code: error.code } : {}) }
      : { error: 'Verification storage request failed' })
  }
}
