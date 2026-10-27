// api/admin-auth.js — admin sign-in with the ADMIN_PASSKEY env var.
//
//   POST { passkey }                 → 200 { token, expiresAt }
//                                      401 wrong passkey · 429 locked out
//                                      503 ADMIN_PASSKEY unset or too short
//   GET  Authorization: Bearer token → 200 { admin: true, expiresAt } · 401
//
// See _admin.js for the token format and why this fails closed.

import { guard } from './_guard.js'
import {
  adminPasskey, passkeyMatches, issueAdminToken, verifyAdminToken, bearerToken,
  sameSite, lockedFor, recordFailure, clearFailures
} from './_admin.js'

export default async function handler(req, res) {
  // Before guard(), which answers any site when ALLOWED_ORIGINS is unset. This
  // endpoint fails closed: only admin.html on this deployment may call it.
  if (!sameSite(req)) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }
  if (guard(req, res, 'GET, POST, OPTIONS')) return

  if (req.method === 'GET') {
    const expiresAt = verifyAdminToken(bearerToken(req))
    if (!expiresAt) { res.status(401).json({ error: 'Admin session required' }); return }
    res.status(200).json({ admin: true, expiresAt })
    return
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  if (!adminPasskey()) {
    res.status(503).json({ error: 'Admin access is not configured', configured: false })
    return
  }

  // Checked before the passkey, so a locked-out address learns nothing more
  // by carrying on — not even that its next guess was right.
  const wait = lockedFor(req)
  if (wait) {
    res.setHeader('Retry-After', String(wait))
    res.status(429).json({ error: 'Too many wrong passkeys. Try again later.', retryAfter: wait })
    return
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {}
  if (typeof body.passkey !== 'string' || !body.passkey) {
    res.status(400).json({ error: 'Passkey required' })
    return
  }

  if (!passkeyMatches(body.passkey)) {
    recordFailure(req)
    res.status(401).json({ error: 'Wrong passkey' })
    return
  }

  clearFailures(req)
  res.status(200).json(issueAdminToken())
}
