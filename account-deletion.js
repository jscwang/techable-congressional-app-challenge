// ============================================================
// account-deletion.js — "Delete my account and my data"
//
// The one implementation of the account-deletion cascade. auth.js
// (TechableAuth.deleteAccount, used by profile.html) and senior-login.html
// both call deleteAccountAndData(). There used to be two copies, each with
// half the correct behaviour (audits/F08-account-deletion.md, TRIAGE X6-d).
//
// senior-login.html runs its own Firebase app on purpose (see auth.js,
// justSignedOut) and cannot load auth.js, so this module imports nothing:
// the caller passes its Firestore instance, the Firestore functions and
// deleteUser.
//
// The rule this file exists to keep: the sign-in is deleted LAST, and ONLY
// when every record was removed. Every delete rule in firestore.rules is
// bound to request.auth.uid, so once the sign-in is gone nobody — not the
// user, not us — can ever delete what was left behind. A failure therefore
// stops the cascade before deleteUser() and is reported, so they can retry.
// ============================================================

// Every query-able collection this account can erase under the current
// rules (firestore.rules), and the field that names it as the owner.
//
// Order matters:
//   - senior_link_directory matches go before this list (see below), and
//     residents go last in it: a family_links create needs both a directory
//     match and a live residents doc, so no new link can be made mid-way.
//   - communities go before registrations, so a centre stops being offered
//     on join.html before the registrations sent to it are cleared.
//   - the users doc (which holds the role) is not here — it goes after all
//     of these, so any failure leaves the account able to retry.
//
// Not here because the rules do not let this account delete them (they
// need a rules change or a server-side path — see audits/F08):
//   - visit_requests sent TO a manager (delete is residentUid-only)
//   - registrations a senior submitted on join.html (they are never signed in)
//   - Supabase verification documents (their paths are not stored anywhere
//     the browser can read, and the API only deletes by exact path)
// And one record left on purpose: deleted_profiles/{uid}, the tombstone
// written with the users delete (step 5 below). It holds only the role.
export const OWNED_RECORDS = [
  ['provider_connections', 'seniorUid'],
  ['provider_connections', 'providerUid'],
  ['family_contribution_media', 'familyUid'],
  ['family_contribution_media', 'seniorUid'],
  ['family_contributions', 'familyUid'],
  ['family_contributions', 'seniorUid'],
  ['family_chat', 'familyUid'],
  ['family_chat', 'seniorUid'],
  ['center_forms', 'authorUid'],
  ['center_forms', 'seniorUid'],
  ['member_announcements', 'authorUid'],
  ['member_announcements', 'seniorUid'],
  ['provider_follows', 'uid'],
  // The newest collections first. If the site ever goes live before their
  // rules, these queries are refused, and refusing here stops the cascade
  // before anything at all has been deleted.
  //
  // Family messages to a senior (F50), from both ends: what a family member
  // sent, and what a senior received. The recordings and photos first, so a
  // stop part-way never leaves bytes behind a message that is already gone.
  ['family_note_media', 'fromUid'],
  ['family_note_media', 'seniorUid'],
  ['family_notes',    'fromUid'],
  ['family_notes',    'seniorUid'],
  // Requests to join a centre (F45): the senior's own, and those sent to a
  // manager's centres.
  ['centre_requests', 'seniorUid'],
  ['centre_requests', 'managerUid'],
  ['center_connections', 'seniorUid'],
  ['center_connections', 'managerUid'],
  // Family links pointing at a senior (F32): the senior may delete them now,
  // so they go with the account instead of outliving it.
  ['family_links',    'seniorUid'],
  ['family_links',    'familyUid'],
  ['family_links',    'managerUid'],
  ['companion_settings', 'managerUid'],
  ['communities',     'managerUid'],
  ['registrations',   'centreId'],
  ['visit_requests',  'residentUid'],
  ['family_messages', 'fromUid'],
  ['family_messages', 'managerUid'],
  ['care_notes',      'providerUid'],
  ['provider_assignments', 'providerUid'],
  ['provider_assignments', 'managerUid'],
  ['provider_directory',   'providerUid'],
  ['sessions',        'ownerUid'],
  ['attendance',      'ownerUid'],
  ['attendance',      'managerUid'],
  ['residents',       'ownerUid'],
  ['residents',       'createdBy'],
  ['residents',       'centreId']
]

// What to call each collection when telling someone it was not removed.
const LABELS = {
  family_contributions: 'family stories and photos, sent or received',
  users:                 'your profile',
  centres:               'your old centre profile',
  senior_link_directory: 'the entry family members use to find you',
  family_links:          'your family connections',
  communities:           'your centres',
  registrations:         'registrations sent to your centres',
  visit_requests:        'your visit requests',
  family_messages:       'messages you wrote',
  family_notes:          'family messages, sent or received',
  family_note_media:     'voice notes and photos in family messages',
  centre_requests:       'requests to join a centre',
  center_connections:    'your center connections and applications',
  care_notes:            'care notes you wrote',
  provider_assignments:  'provider assignments',
  provider_directory:    'your provider directory card',
  provider_follows:      'your provider program connections',
  residents:             'resident profiles',
  sessions:              'saved conversations and check-ins',
  attendance:            'attendance records'
}

// senior_link_directory/{sha256(kind:value)}/matches/{uid} — published by
// app.js ensureSeniorLinkDirectory for a senior's email and username. The
// parent collection cannot be listed, so the keys are recomputed here
// exactly the way app.js computes them.
const RESIDENT_ROLES = ['resident', 'elderly', 'builder']

// The same mapping as canonicalRole() in firestore.rules, which the
// deleted_profiles tombstone must match exactly: anything unrecognised is a
// resident, the least-privileged role.
export function canonicalRole(role) {
  if (role === 'community_manager' || role === 'centre') return 'community_manager'
  if (role === 'family') return 'family'
  if (role === 'service_provider' || role === 'provider') return 'service_provider'
  return 'resident'
}
const normalizedLinkIdentifier = value => String(value || '').trim().toLowerCase().replace(/^@/, '')

async function seniorDirectoryHash(kind, value) {
  const bytes = new TextEncoder().encode(`${kind}:${value}`)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

function directoryIdentifiers(user, profile) {
  const email = normalizedLinkIdentifier(user.email || profile?.email)
  const username = normalizedLinkIdentifier(
    profile?.username || profile?.usernameLower || (email.includes('@') ? email.split('@')[0] : '')
  )
  return [email && ['email', email], username && ['username', username]].filter(Boolean)
}

async function deleteDirectoryMatches(db, fs, user, profile, failed, ms) {
  if (profile && !RESIDENT_ROLES.includes(profile.role || 'resident')) return // only residents publish
  for (const [kind, value] of directoryIdentifiers(user, profile)) {
    try {
      const key = await seniorDirectoryHash(kind, value)
      await withTimeout(fs.deleteDoc(fs.doc(db, 'senior_link_directory', key, 'matches', user.uid)), ms)
    } catch (err) {
      // The delete rule reads resource.data.seniorUid, which the create rule
      // pins to this uid — so on this uid's own path, permission-denied can
      // only mean there is no such match (e.g. no username was published).
      if (err?.code === 'permission-denied') continue
      failed.push({ collection: 'senior_link_directory', id: kind, code: err?.code || 'delete-failed' })
      return
    }
  }
}

const label = name => LABELS[name] || name

// Firebase refuses deleteUser() with auth/requires-recent-login when the
// sign-in is more than five minutes old — the normal case for a manager who
// has had their profile page open for a while. That refusal used to arrive
// after every record was already gone: the account survived with no users
// doc, and on reload an ex-manager was treated as a resident. So the age of
// the sign-in is checked before anything is deleted, with a margin for the
// cascade itself, and again before the users doc goes.
export const RECENT_SIGN_IN_MS = 4 * 60 * 1000
const LAST_CHANCE_MS = 4.5 * 60 * 1000

// Both times come from Firebase, never from the device clock: a phone
// running a few minutes fast used to be unable to delete at all, and one
// running slow could start a cascade that deleteUser() would then refuse.
// A forced refresh is what makes issuedAtTime mean "now" — a cached token
// was issued whenever it was last refreshed. Offline, the refresh fails,
// which stops the cascade before it starts.
async function signInAgeMs(user, timeoutMs) {
  const token = await withTimeout(user.getIdTokenResult(true), timeoutMs)
  const signedIn = Date.parse(token?.authTime)
  const now = Date.parse(token?.issuedAtTime)
  if (!Number.isFinite(signedIn) || !Number.isFinite(now)) throw new Error('token times missing')
  return now - signedIn
}

// ── Offline is a failure, never an empty answer ───────────────────
// Once the Firestore web SDK decides it is offline, getDocs() does not
// throw: it answers from the local cache — for these queries, usually
// nothing — and writes are queued with promises that do not settle until
// the server acknowledges them. Read naively, that is "nothing to delete",
// then a deleted sign-in and everything else orphaned for good. So reads
// go to the server (getDocsFromServer / getDocFromServer when the caller
// passes them; otherwise a snapshot marked fromCache counts as a failure),
// and every read and write gets a deadline.
export const DEFAULT_TIMEOUT_MS = 15000

function withTimeout(promise, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('timed out')
      err.code = 'deadline-exceeded'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function offlineError() {
  const err = new Error('answered from the offline cache')
  err.code = 'unavailable'
  return err
}

async function serverQuery(fs, q, ms) {
  const snap = await withTimeout(fs.getDocsFromServer ? fs.getDocsFromServer(q) : fs.getDocs(q), ms)
  if (snap?.metadata?.fromCache === true) throw offlineError()
  return snap
}

async function serverGet(fs, ref, ms) {
  const snap = await withTimeout(fs.getDocFromServer ? fs.getDocFromServer(ref) : fs.getDoc(ref), ms)
  if (snap?.metadata?.fromCache === true) throw offlineError()
  return snap
}

const MSG_SIGN_IN_FIRST =
  'For your security, please sign in again and then delete your account. Nothing has been deleted.'
const MSG_SIGN_IN_TO_FINISH =
  'Your records have been removed, but for your security your sign-in can only be deleted ' +
  'right after you sign in. Please sign in once more and press delete again to finish.'
// deleteUser() refused AND the profile could not be written back. The
// account now has no users doc: reloading or signing in again opens it as a
// senior (resident) account with none of its old data. Say so plainly.
const MSG_PROFILE_LOST =
  'Your records have been removed, but your sign-in could not be deleted, and your profile ' +
  'could not be put back. Please stay on this page and press delete again now. If you reload ' +
  'or leave, this sign-in will open as an empty senior account that cannot be deleted from ' +
  'the app. If it keeps failing, contact Techable support to finish deleting it.'
// No "stay and retry" here: the retry would stop at the sign-in check, and
// signing in again lands them in an account with no delete button.
const MSG_PROFILE_LOST_SIGN_IN =
  'Your records have been removed, but for your security your sign-in can only be deleted right ' +
  'after you sign in, and your profile could not be put back. Please contact Techable support ' +
  'to finish deleting the sign-in. Until then it would open as an empty senior account.'
const MSG_CHECK_FAILED =
  'We could not check your sign-in just now. Please check your connection and try again. ' +
  'Nothing has been deleted.'

function describeFailures(failed) {
  const byCollection = new Map()
  for (const f of failed) byCollection.set(f.collection, (byCollection.get(f.collection) || 0) + 1)
  return [...byCollection.keys()].map(label).join(', ')
}

function failureMessage(failed) {
  return 'Your account has not been deleted, because some of your records could not be removed: ' +
    describeFailures(failed) + '. Please check your connection and try again — ' +
    'your sign-in is kept until everything is gone, so trying again is safe.'
}

// Delete everything one query finds. A failed or cached query is a
// failure, never "nothing to delete". Stops at the first failure: the
// cascade is going to stop before the sign-in anyway, and offline every
// further step would only wait out its own deadline.
async function deleteMatching(db, fs, collectionName, field, uid, seen, failed, ms) {
  let snap
  try {
    snap = await serverQuery(fs, fs.query(fs.collection(db, collectionName), fs.where(field, '==', uid)), ms)
  } catch (err) {
    failed.push({ collection: collectionName, field, code: err?.code || 'query-failed' })
    return
  }
  for (const d of snap.docs) {
    const path = d.ref?.path || collectionName + '/' + d.id
    if (seen.has(path)) continue
    seen.add(path)
    try {
      // A senior who joined this manager's centre owns their record. Deleting
      // the manager's account lets them go — the centre link cleared — and
      // never deletes the senior's profile, memories or life story.
      const data = typeof d.data === 'function' ? d.data() : null
      if (collectionName === 'residents' && field === 'centreId' && data?.ownerUid && data.ownerUid !== uid) {
        await withTimeout(fs.setDoc(d.ref,
          { centreId: '', communityId: '', communityName: '', updatedAt: fs.serverTimestamp() }, { merge: true }), ms)
      } else {
        await withTimeout(fs.deleteDoc(d.ref), ms)
      }
    } catch (err) {
      // A family link routed to this manager for a senior who has since left
      // their centre: the rules let only the senior or the family remove it
      // (BUG-004). It is theirs, not this account's, so it stays.
      if (collectionName === 'family_links' && field === 'managerUid' && err?.code === 'permission-denied') continue
      failed.push({ collection: collectionName, id: d.id, code: err?.code || 'delete-failed' })
      return
    }
  }
}

// localStorage keys that describe the DEVICE, not the person who used it, and
// so survive a sign-out (F06). Everything else under techable_* is personal:
// app.js writes every transcript and check-in to localStorage as well as to
// Firestore, and on a shared care-home tablet the next person could read them.
// An allowlist on purpose — a new key is cleared until someone decides it is a
// preference. This is the only copy of the list: auth.js and the four login
// pages load it from here.
//   techable_voice_pref   companion speaks aloud or not
//   techable_lang         interface language
//   techable_chat_mode    voice or typing, decides if the mic reopens
//   techable_voice_tell   the voice-diagnostics caption switch
//   techable_visit_stamp  homepage visit counter's once-a-day date
export const DEVICE_PREFS = Object.freeze([
  'techable_voice_pref', 'techable_lang', 'techable_chat_mode',
  'techable_voice_tell', 'techable_visit_stamp'
])

// Run on every sign-out of a real account. Never in the no-config guest mode,
// where this device is the guest's only copy. Leaves sessionStorage (and the
// techable_just_signed_out marker in it) alone.
export function clearPersonalLocalData() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('techable_') && !DEVICE_PREFS.includes(k))
      .forEach(k => localStorage.removeItem(k))
  } catch (_) {}
}

// Account deletion: everything, preferences included.
function clearLocalData() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith('techable_'))
      .forEach(k => localStorage.removeItem(k))
  } catch (_) {}
  try { sessionStorage.clear() } catch (_) {}
}

/**
 * Deletes everything the signed-in account owns, then the sign-in.
 *
 *   user       the Firebase Auth user (must be the signed-in one)
 *   db         a Firestore instance
 *   fs         { collection, query, where, getDocs, getDocsFromServer, doc,
 *                getDoc, getDocFromServer, setDoc, deleteDoc, writeBatch,
 *                serverTimestamp } — pass the
 *                *FromServer functions; without them a cached snapshot is
 *                treated as a failure
 *   deleteUser the firebase-auth deleteUser function
 *   timeoutMs  deadline for each read and write (default 15 s)
 *
 * Never throws. Resolves to { ok: true } or
 * { ok: false, reason, message, failed } where message is written for the
 * person pressing the button.
 */
export async function deleteAccountAndData({ user, db, fs, deleteUser, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!user?.uid) {
    return { ok: false, reason: 'signed-out', failed: [], message: 'You are not signed in.' }
  }
  const uid = user.uid
  const ms = timeoutMs
  const failed = []
  const seen = new Set()

  // 1. Is this sign-in fresh enough for Firebase to delete? If not, stop
  //    before touching anything.
  let age
  try { age = await signInAgeMs(user, ms) }
  catch (_) { return { ok: false, reason: 'check-failed', failed: [], message: MSG_CHECK_FAILED } }
  if (age > RECENT_SIGN_IN_MS) {
    return { ok: false, reason: 'recent-login', dataRemoved: false, failed: [], message: MSG_SIGN_IN_FIRST }
  }

  // 2. Keep a copy of the profile, so it can be put back if the sign-in
  //    itself refuses to go at the very end. A failed (or cached) read stops
  //    here too: nothing has been deleted yet.
  let profile = null
  try {
    const snap = await serverGet(fs, fs.doc(db, 'users', uid), ms)
    profile = snap.exists() ? snap.data() : null
  } catch (err) {
    const f = [{ collection: 'users', id: uid, code: err?.code || 'read-failed' }]
    return { ok: false, reason: 'data', failed: f, message: failureMessage(f) }
  }

  // 3. Everything the account owns: the directory entries that let family
  //    find a senior first, then every owned collection, then the legacy
  //    centres/{uid} doc (the rules let the uid delete it whether or not it
  //    exists). The first failure ends this step.
  await deleteDirectoryMatches(db, fs, user, profile, failed, ms)
  for (const [collectionName, field] of OWNED_RECORDS) {
    if (failed.length) break
    await deleteMatching(db, fs, collectionName, field, uid, seen, failed, ms)
  }
  if (!failed.length) {
    try { await withTimeout(fs.deleteDoc(fs.doc(db, 'centres', uid)), ms) }
    catch (err) { failed.push({ collection: 'centres', id: uid, code: err?.code || 'delete-failed' }) }
  }
  // The admin's review note for a manager or provider (written by the server,
  // deletable by its owner). Deleting a doc that is not there succeeds.
  if (!failed.length) {
    try { await withTimeout(fs.deleteDoc(fs.doc(db, 'verification_notes', uid)), ms) }
    catch (err) { failed.push({ collection: 'verification_notes', id: uid, code: err?.code || 'delete-failed' }) }
  }

  if (failed.length) {
    console.warn('[account-deletion] stopped before deleting the sign-in:', failed)
    return { ok: false, reason: 'data', failed, message: failureMessage(failed) }
  }

  // 4. A long cascade can outlast the sign-in window. Stop while the users
  //    doc (and so the role and the page they deleted from) still exists; a
  //    retry after signing in finds nothing left and finishes.
  try { age = await signInAgeMs(user, ms) } catch (_) { age = Infinity }
  if (age > LAST_CHANCE_MS) {
    return { ok: false, reason: 'recent-login', dataRemoved: true, failed: [], message: MSG_SIGN_IN_TO_FINISH }
  }

  // 5. The profile doc holds the role. It goes last of all the data, so any
  //    failure above leaves the account exactly as able to retry as it was.
  //    firestore.rules only allows this delete together with a tombstone,
  //    deleted_profiles/{uid}, naming the role the profile held — so a users
  //    doc re-created for this uid can come back as that role or as a
  //    resident, never as a new one. The tombstone is meant to stay: the
  //    rules do not let anyone delete it. With no profile left (a retry
  //    after an earlier run removed it) there is nothing to tombstone.
  if (profile) {
    try {
      const batch = fs.writeBatch(db)
      batch.set(fs.doc(db, 'deleted_profiles', uid), {
        role: canonicalRole(profile.role),
        deletedAt: fs.serverTimestamp()
      })
      batch.delete(fs.doc(db, 'users', uid))
      await withTimeout(batch.commit(), ms)
    } catch (err) {
      const f = [{ collection: 'users', id: uid, code: err?.code || 'delete-failed' }]
      return { ok: false, reason: 'data', failed: f, message: failureMessage(f) }
    }
  }

  // 6. The sign-in. No deadline here: a deleteUser() that went through late
  //    after the profile had been put back would leave a profile with no
  //    account. If it refuses, put the profile back: without it the account
  //    comes back as a resident on the next load.
  try {
    await deleteUser(user)
  } catch (err) {
    let profileRestored = !profile   // nothing to put back
    if (profile) {
      // The users create rule accepts only a canonical role, and after a
      // deletion only the tombstone's — so the copy goes back canonical.
      const restored = { ...profile, role: canonicalRole(profile.role) }
      try { await withTimeout(fs.setDoc(fs.doc(db, 'users', uid), restored), ms); profileRestored = true }
      catch (restoreErr) { console.warn('[account-deletion] could not restore users doc:', restoreErr?.code) }
    }
    const recent = err?.code === 'auth/requires-recent-login'
    return {
      ok: false, reason: recent ? 'recent-login' : 'auth', code: err?.code,
      dataRemoved: true, profileRestored, failed: [],
      message: !profileRestored
        ? (recent ? MSG_PROFILE_LOST_SIGN_IN : MSG_PROFILE_LOST)
        : recent
          ? MSG_SIGN_IN_TO_FINISH
          : 'Your records have been removed, but your sign-in could not be deleted just now. ' +
            'Please check your connection and try again.'
    }
  }

  clearLocalData()
  return { ok: true, failed: [] }
}
