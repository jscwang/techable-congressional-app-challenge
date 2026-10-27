// api/admin-verifications.js — the admin console's account verification queue.
//
//   GET                  → { accounts: [...], storageConfigured }
//   GET  ?uid=<uid>      → { uid, documents: [{ name, size, type, uploadedAt, signedUrl }] }
//   POST { uid, decision: 'approved'|'rejected', note } → { uid, status, reviewedAt }
//
// Admin session required (api/_admin.js). Accounts are community_manager and
// service_provider users; their uploads sit in the private Supabase bucket at
// verificationDocuments/<uid>/<role>/, reached here only through signed links
// that expire in ten minutes. Decisions are written with a service account,
// because firestore.rules never let a browser set verificationStatus to
// approved or rejected — not even the admin's.

import { guard } from './_guard.js'
import { sameSite, requireAdmin } from './_admin.js'
import { verificationServiceAccount, query, getDoc, updateFields, setFields } from './_firestore-admin.js'

const REVIEWED_ROLES = ['community_manager', 'service_provider']
const DECISIONS = new Set(['approved', 'rejected'])
const MAX_NOTE = 500
const LINK_SECONDS = 600
// Firebase uids are 1–128 characters of letters and digits.
const UID = /^[A-Za-z0-9]{1,128}$/

function storageConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '')
  const secret = process.env.SUPABASE_SECRET_KEY || ''
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'verification-documents'
  if (!/^https:\/\//.test(url) || !secret || !/^[-a-zA-Z0-9_]+$/.test(bucket)) return null
  return { base: `${url}/storage/v1`, secret, bucket }
}

function queryParam(req, name) {
  if (req.query && name in req.query) return String(req.query[name] ?? '')
  try { return new URL(req.url || '', 'http://x').searchParams.get(name) } catch { return null }
}

function body(req) {
  if (typeof req.body === 'string') { try { return JSON.parse(req.body) } catch { return null } }
  return req.body && typeof req.body === 'object' ? req.body : null
}

async function listAccounts(sa) {
  const [users, centres, notes] = await Promise.all([
    query(sa, {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: {
        field: { fieldPath: 'role' }, op: 'IN',
        value: { arrayValue: { values: REVIEWED_ROLES.map(r => ({ stringValue: r })) } }
      } },
      limit: 1000
    }),
    query(sa, { from: [{ collectionId: 'communities' }], limit: 1000 }),
    query(sa, { from: [{ collectionId: 'verification_notes' }], limit: 1000 })
  ])
  const noteFor = new Map(notes.map(n => [n.id, n.data.note || '']))

  // Notes written before they moved to verification_notes/{uid} are still on
  // users/{uid}, which every signed-in account can read for a public manager.
  // A rejected manager may never get another decision, so they are moved
  // here, the first time the admin console lists them. Best effort: a failure
  // leaves the note where it was and the list still shows it.
  await Promise.all(users
    .filter(u => typeof u.data.verificationNote === 'string')
    .map(async u => {
      try {
        const note = noteFor.get(u.id) || u.data.verificationNote
        if (!noteFor.get(u.id) && note) {
          await setFields(sa, 'verification_notes', u.id, { note: { stringValue: note } })
        }
        await updateFields(sa, 'users', u.id, {}, { remove: ['verificationNote'] })
        noteFor.set(u.id, note)
      } catch (e) {
        console.error('[Techable] admin-verifications: could not move a note:', e.message)
      }
    }))

  const centresBy = new Map()
  for (const c of centres) {
    if (!c.data.managerUid) continue
    if (!centresBy.has(c.data.managerUid)) centresBy.set(c.data.managerUid, [])
    centresBy.get(c.data.managerUid).push({ id: c.id, name: c.data.name || '', verified: c.data.verified === true })
  }

  const order = { pending: 0, not_submitted: 1, rejected: 2, approved: 3 }
  return users
    .map(({ id, data: d }) => ({
      uid: id,
      role: d.role,
      name: d.displayName || '',
      email: d.email || '',
      organisation: d.organisation || '',
      providerType: d.providerType || '',
      centreName: (centresBy.get(id) || []).map(c => c.name || 'Unnamed centre').sort().join(', '),
      // Sent back with an approval, so the server can tell whether anything
      // changed between what the admin looked at and the click.
      centres: (centresBy.get(id) || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
      // Centres added (or recreated) since the manager was approved: they
      // cannot post news until approved again.
      unverifiedCentres: (centresBy.get(id) || []).filter(c => !c.verified).map(c => c.name || 'Unnamed centre').sort(),
      status: d.verificationStatus || 'not_submitted',
      documentCount: Number(d.verificationDocumentCount) || 0,
      submittedAt: d.verificationSubmittedAt || null,
      reviewedAt: d.verificationReviewedAt || null,
      // Older reviews kept the note on users/{uid}; it moves on the next decision.
      note: noteFor.get(id) || d.verificationNote || '',
      createdAt: d.createdAt || null
    }))
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)
      || (b.submittedAt || b.createdAt || 0) - (a.submittedAt || a.createdAt || 0))
}

async function reviewedAccount(sa, uid) {
  if (!UID.test(uid || '')) return { error: 400 }
  const user = await getDoc(sa, 'users', uid)
  if (!user || !REVIEWED_ROLES.includes(user.data.role)) return { error: 404 }
  return { user }
}

async function listDocuments(storage, uid, role) {
  const prefix = `verificationDocuments/${uid}/${role}/`
  const headers = { apikey: storage.secret, 'Content-Type': 'application/json' }
  const r = await fetch(`${storage.base}/object/list/${storage.bucket}`, {
    method: 'POST', headers,
    body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } })
  })
  if (!r.ok) throw new Error(`supabase list ${r.status}`)
  const files = (await r.json()).filter(f => f && f.id && f.name)

  return Promise.all(files.map(async f => {
    const path = prefix + f.name
    const s = await fetch(`${storage.base}/object/sign/${storage.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers, body: JSON.stringify({ expiresIn: LINK_SECONDS })
    })
    const signed = s.ok ? await s.json() : {}
    const rel = signed.signedURL || signed.signedUrl || ''
    return {
      // Uploads are named <time>-<uuid>-<original name>; show the original.
      name: f.name.replace(/^\d+-[0-9a-f-]{36}-/i, ''),
      size: Number(f.metadata?.size) || 0,
      type: f.metadata?.mimetype || '',
      uploadedAt: Date.parse(f.created_at) || null,
      signedUrl: rel ? (/^https:\/\//.test(rel) ? rel : `${storage.base}${rel.startsWith('/') ? '' : '/'}${rel}`) : ''
    }
  }))
}

export default async function handler(req, res) {
  if (!sameSite(req)) { res.status(403).json({ error: 'Origin not allowed' }); return }
  if (guard(req, res, 'GET, POST, OPTIONS')) return
  if (!requireAdmin(req, res)) return
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const sa = verificationServiceAccount(req)
  if (!sa) {
    res.status(503).json({
      error: 'Account review is not set up on this deployment',
      // Either a key, or the GCP_* workload identity settings (F37).
      configured: false, missing: process.env.FIREBASE_PROJECT_ID === 'techable-qa'
        ? ['GCP_VERIFICATION_SERVICE_ACCOUNT_EMAIL'] : ['FIREBASE_ADMIN_SA_KEY'],
      or: ['GCP_PROJECT_NUMBER', 'GCP_WORKLOAD_IDENTITY_POOL_ID', 'GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID', 'GCP_SERVICE_ACCOUNT_EMAIL']
    })
    return
  }
  const storage = storageConfig()

  try {
    if (req.method === 'GET') {
      const uid = queryParam(req, 'uid')
      if (uid === null) {
        res.status(200).json({ configured: true, storageConfigured: !!storage, accounts: await listAccounts(sa) })
        return
      }
      const found = await reviewedAccount(sa, uid)
      if (found.error) { res.status(found.error).json({ error: found.error === 404 ? 'No such account' : 'Invalid account id' }); return }
      if (!storage) {
        res.status(503).json({ error: 'Document storage is not set up', storageConfigured: false })
        return
      }
      res.status(200).json({ uid, documents: await listDocuments(storage, uid, found.user.data.role) })
      return
    }

    const b = body(req) || {}
    const decision = String(b.decision || '')
    const note = typeof b.note === 'string' ? b.note.trim() : ''
    if (!DECISIONS.has(decision)) { res.status(400).json({ error: 'decision must be approved or rejected' }); return }
    if (note.length > MAX_NOTE) { res.status(400).json({ error: `Keep the note under ${MAX_NOTE} characters` }); return }
    // The account holder sees this note; a rejection with no reason gives
    // them nothing to fix.
    if (decision === 'rejected' && !note) { res.status(400).json({ error: 'Say why, so they know what to fix' }); return }

    const found = await reviewedAccount(sa, String(b.uid || ''))
    if (found.error) { res.status(found.error).json({ error: found.error === 404 ? 'No such account' : 'Invalid account id' }); return }

    const theirCentres = found.user.data.role === 'community_manager'
      ? await query(sa, {
          from: [{ collectionId: 'communities' }],
          where: { fieldFilter: { field: { fieldPath: 'managerUid' }, op: 'EQUAL', value: { stringValue: found.user.id } } },
          limit: 100
        })
      : []

    // An approval freezes the organisation and centre names seniors will see,
    // so it must be for the names the admin actually looked at. The page sends
    // them; anything renamed, added or removed since means review again.
    if (decision === 'approved') {
      const seen = b.seen && typeof b.seen === 'object' ? b.seen : null
      if (!seen || !Array.isArray(seen.centres)) {
        res.status(400).json({ error: 'Reload the page and review this account again.' })
        return
      }
      const now = theirCentres.map(c => c.id + '\u0000' + (c.data.name || '')).sort().join('\u0001')
      const then = seen.centres.map(c => String(c?.id) + '\u0000' + String(c?.name ?? '')).sort().join('\u0001')
      if (now !== then || String(seen.organisation ?? '') !== String(found.user.data.organisation || '')) {
        res.status(409).json({ error: 'Their details changed since you opened this. Look again before approving.', changed: true })
        return
      }
    }

    const reviewedAt = new Date()
    // The note goes to verification_notes/{uid}, which only its owner can
    // read. users/{uid} of a manager is readable by every signed-in account
    // (the Friends directory), and the admin's reason for a rejection is not
    // theirs to see (bug hunt 2026-10-22, BUG-008). Any note an earlier
    // review left on users/{uid} is removed in the same write.
    await setFields(sa, 'verification_notes', found.user.id, {
      note: { stringValue: note },
      reviewedAt: { timestampValue: reviewedAt.toISOString() }
    })
    await updateFields(sa, 'users', found.user.id, {
      verificationStatus: { stringValue: decision },
      verificationReviewedAt: { timestampValue: reviewedAt.toISOString() }
    }, { remove: ['verificationNote'] })
    // A manager's decision covers the centres they run now. Each is marked
    // (or unmarked) verified, with the name that was reviewed; only verified
    // centres can post news (firestore.rules).
    if (theirCentres.length) {
      await Promise.all(theirCentres.map(c => updateFields(sa, 'communities', c.id, {
        verified: { booleanValue: decision === 'approved' },
        verifiedName: { stringValue: c.data.name || '' },
        verifiedAt: { timestampValue: reviewedAt.toISOString() }
      })))
    }
    res.status(200).json({ uid: found.user.id, status: decision, reviewedAt: reviewedAt.getTime(), note })
  } catch (e) {
    console.error('[Techable] admin-verifications:', e.message)
    res.status(502).json({ error: 'Could not reach the database. Try again.' })
  }
}
