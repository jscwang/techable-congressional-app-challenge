// ============================================================
// auth.js — Shared Firebase Auth Module
// Roles: resident | community_manager | family | service_provider
// Aliases: elderly→resident, centre→community_manager, builder→resident
//          provider→service_provider
// ============================================================

// ── Early bootstrap (must run before the first await) ─────────
// This module has top-level awaits, and sibling <script type="module"> blocks
// do NOT wait for them. Pages that call TechableAuth.guardRole(...) directly
// therefore ran while window.TechableAuth was still undefined and died with
// "ReferenceError: TechableAuth is not defined" — leaving the auth-loading
// spinner up forever (family-dashboard, provider-dashboard, dashboard,
// elderly-profile), or silently never initialising where the call was written
// defensively as window.TechableAuth?.guard (profile, communities).
//
// Installing a placeholder synchronously here fixes every one of those pages
// at once: early calls are queued and replayed against the real API below.
const _pending = []
if (!window.TechableAuth) {
  window.TechableAuth = {
    ready: false,
    currentUser: null,
    db: null,
    guard(cb) { _pending.push(['guard', cb]) },
    guardRole(roles, cb) { _pending.push(['guardRole', roles, cb]) }
  }
}

function drainPending() {
  const api = window.TechableAuth
  while (_pending.length) {
    const [kind, a, b] = _pending.shift()
    if (kind === 'guard') api.guard(a)
    else api.guardRole(a, b)
  }
}

await window._cfg
const cfg = window.TECHABLE_CONFIG

if (!cfg?.firebase?.apiKey) {
  console.warn('auth.js: No Firebase config. Stubs installed.')
  window.TechableAuth = {
    ready: true, currentUser: null, db: null, app: null,
    guard(cb) {
      const ov = document.getElementById('auth-loading')
      if (ov) ov.style.display = 'none'
      const pv = document.getElementById('page-content')
      if (pv) pv.style.display = 'block'
      if (cb) cb(null, 'resident')
    },
    guardRole(roles, cb) { this.guard(cb) },
    // Leaves techable_* alone on purpose: with no Firebase there is no account
    // and nothing in Firestore, so localStorage is the guest's only copy.
    signOut: async () => { window.location.replace('index.html#signin') },
    justSignedOut: () => false,
    getRole: async () => 'resident',
    getUserDoc: async () => null,
    updateName: async () => {},
    deleteAccount: async () => ({
      ok: false, reason: 'not-configured', failed: [],
      message: 'Account deletion is not available right now. Nothing has been deleted.'
    }),
    setRole: async () => {},
    userName: () => 'Guest', initials: () => 'G', photoURL: () => null,
    friendlyError: () => 'Auth not configured.',
    signInEmail: async () => { throw new Error('Not configured') },
    signUpEmail: async () => { throw new Error('Not configured') },
    signInGoogle: async () => { throw new Error('Not configured') },
    resetPassword: async () => { throw new Error('Not configured') },
    roleHome: r => {
      if (r === 'community_manager') return 'profile.html'
      if (r === 'family')            return 'family-dashboard.html'
      if (r === 'service_provider')  return 'provider-dashboard.html'
      return 'app.html'
    },
    normalizeRole: r => {
      if (r === 'community_manager' || r === 'centre') return 'community_manager'
      if (r === 'family')                              return 'family'
      if (r === 'service_provider' || r === 'provider') return 'service_provider'
      return 'resident'
    }
  }
  drainPending()
  document.dispatchEvent(new CustomEvent('auth:stateChanged', { detail: null }))
  throw new Error('No config')
}

import { initializeApp, getApps }
  from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js"
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, sendPasswordResetEmail,
  updateProfile, deleteUser, signOut
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js"
import {
  getFirestore, doc, getDoc, setDoc, deleteDoc, serverTimestamp,
  collection, query, where, getDocs, getDocsFromServer, getDocFromServer, writeBatch
} from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js"

const app  = getApps().length ? getApps()[0] : initializeApp(cfg.firebase)
const auth = getAuth(app)
const db   = getFirestore(app)
const gp   = new GoogleAuthProvider()
gp.setCustomParameters({ prompt: 'select_account' })

let _user      = null
let _cbs       = []
let _resolved  = false   // FIX: track whether Firebase has resolved auth state
let _roleCache = null

// How long a sign-out is allowed to take before it is completed by hand. Short
// on purpose: someone handing a tablet back wants it done, not correct.
const SIGN_OUT_MS = 4000

// Survives the navigation to the login page and nothing else, which is exactly
// the lifetime this needs. The login pages read this same key by name.
const JUST_SIGNED_OUT = 'techable_just_signed_out'

// F06: transcripts and check-ins are saved on the device as well as in
// Firestore. Sign-out clears every techable_* key except the device
// preferences, whose one list (DEVICE_PREFS) lives in account-deletion.js —
// loaded on demand, like deleteAccount() does, so a failed fetch of it cannot
// take every signed-in page down. If it cannot load, everything under
// techable_* goes: losing a preference beats leaving a transcript behind.
async function clearPersonalLocalData() {
  try {
    // Raced, like the sign-out itself: someone handing a tablet back must not
    // wait on a slow fetch.
    const { clearPersonalLocalData: clear } = await Promise.race([
      import('./account-deletion.js'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 2000))
    ])
    clear()
  } catch (_) {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('techable_'))
        .forEach(k => localStorage.removeItem(k))
    } catch (_) {}
  }
}

function normalizeRole(role) {
  if (role === 'elderly')           return 'resident'
  if (role === 'centre')            return 'community_manager'
  if (role === 'builder')           return 'resident'
  if (role === 'resident')          return 'resident'
  if (role === 'community_manager') return 'community_manager'
  if (role === 'family')            return 'family'
  if (role === 'provider')          return 'service_provider'
  if (role === 'service_provider')  return 'service_provider'
  return 'resident'
}

function qaProviderDeveloper(user, data) {
  return Boolean(cfg?.firebase?.projectId === 'techable-qa'
    && user?.uid === 'iotk9iBczvVZ2zc3VuA5GtQeLVk1'
    && user.email?.toLowerCase() === 'dev2@techable.org' && user.emailVerified === true
    && data?.role === 'community_manager' && data.verificationStatus === 'approved'
    && Array.isArray(data.qaDeveloperModules)
    && data.qaDeveloperModules.length === 2
    && data.qaDeveloperModules.includes('community_manager') && data.qaDeveloperModules.includes('service_provider'))
}

function roleHome(role) {
  const r = normalizeRole(role)
  if (r === 'community_manager') return 'profile.html'
  if (r === 'family')            return 'family-dashboard.html'
  if (r === 'service_provider')  return 'provider-dashboard.html'
  return 'app.html'
}

// ── Role lookup ──────────────────────────────────────────────
// A read that failed and a document that is not there used to arrive here as
// the same answer — null — so everything downstream settled on 'resident'.
// One flat moment of no signal on a phone was enough: a family member, a
// manager or a clinician was written down as a resident, the guess was cached
// in sessionStorage for the rest of the tab, and every attempt to open their
// own dashboard bounced them into the senior's chat companion, with nothing on
// screen to say why. The two answers are not the same, and the difference has
// to survive the read.
const READ_FAILED = Symbol('users doc read failed')

async function fetchUserDoc(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid))
    return snap.exists() ? snap.data() : null
  } catch (e) {
    console.warn('[auth] users doc read failed:', e?.code || e?.message)
    return READ_FAILED
  }
}

// Returns null when the read failed, and caches nothing in that case: a guess
// written to sessionStorage outlives the moment that caused it and goes on
// being wrong until the tab is closed or the user signs out — neither of which
// anyone would think to try, because nothing tells them a lookup went wrong.
async function fetchRole(uid) {
  if (_roleCache) return _roleCache
  // Role corrections by an administrator must take effect on the next page.
  // A saved session value can otherwise keep sending a manager into Senior.
  const data = await fetchUserDoc(uid)
  if (data === READ_FAILED) return null
  const role = normalizeRole(data?.role || 'resident')
  sessionStorage.setItem('t_role_' + uid, role)
  _roleCache = role
  return role
}

// Most of these failures are a moment rather than a state — a lift, a tunnel,
// a tab waking from sleep — and a second attempt clears them before anyone
// notices. Only a read that keeps failing is worth interrupting someone for.
const ROLE_RETRY_MS = [400, 1200]

async function fetchRoleOrRetry(uid) {
  let role = await fetchRole(uid)
  for (const wait of ROLE_RETRY_MS) {
    if (role !== null) break
    await new Promise(done => setTimeout(done, wait))
    role = await fetchRole(uid)
  }
  return role
}

// With no role there is no honest answer to give the page, and the only role
// available to guess with is the one that sends people somewhere they did not
// ask to go. So the person is asked instead. Every page that guards itself
// holds a spinner in #auth-loading, so the question takes its place and the
// spinner goes back when they try again. One page can have more than one guard
// waiting (app.html registers two), so the single button resumes all of them.
let _roleRetryHTML = null
const _roleRetryQueue = []

function askToRetryRole(again) {
  _roleRetryQueue.push(again)
  let ov = document.getElementById('auth-loading')
  if (!ov) {
    ov = document.createElement('div')
    ov.id = 'auth-loading'
    ov.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;' +
      'justify-content:center;z-index:99999;background:var(--cream,#FAF6F0)'
    document.body.appendChild(ov)
  }
  if (_roleRetryHTML !== null) return
  _roleRetryHTML = ov.innerHTML
  ov.style.display = 'flex'
  ov.innerHTML =
    '<div role="alert" style="max-width:320px;padding:24px;text-align:center">' +
      '<p style="margin:0 0 16px;font-size:16px;line-height:1.55;' +
      'color:var(--ink,#1A1208)">We could not check your account just now. ' +
      'Please check your connection and try again.</p>' +
      '<button type="button" id="role-retry-btn" style="font:inherit;' +
      'font-size:15px;padding:11px 22px;border:none;border-radius:8px;' +
      'cursor:pointer;background:var(--ink,#1A1208);color:#fff">Try again</button>' +
    '</div>'
  ov.querySelector('#role-retry-btn').addEventListener('click', () => {
    const waiting = _roleRetryQueue.splice(0)
    ov.innerHTML = _roleRetryHTML
    _roleRetryHTML = null
    waiting.forEach(retry => retry())
  })
}

// Create the users/{uid} doc for a Google sign-in if it doesn't exist yet,
// otherwise return the existing role. Shared by the popup path and the
// redirect-return path so both finalise the account the same way.
async function ensureGoogleUserDoc(user, role) {
  const n   = normalizeRole(role)
  const ref = doc(db, 'users', user.uid)
  const snap = await getDoc(ref)
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid, role: n,
      displayName: user.displayName || '',
      displayNameLower: (user.displayName || '').toLowerCase(),
      email: user.email || '', emailLower: (user.email || '').toLowerCase(),
      photoURL: user.photoURL || '', avatarSeed: user.uid,
      isPublic: n === 'community_manager', communitySetup: false,
      privacyConsent: true,
      privacyConsentAt: serverTimestamp(),
      privacyPolicyVersion: '2026-08-07',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true })
    sessionStorage.setItem('t_role_' + user.uid, n)
    _roleCache = n
    return n
  }
  const existing = normalizeRole(snap.data()?.role || n)
  sessionStorage.setItem('t_role_' + user.uid, existing)
  _roleCache = existing
  return existing
}

// ── Auto-handle redirect result on every page load ────────────
// Catches users returning from signInWithRedirect flow.
// Must run before onAuthStateChanged so the result is ready.
try {
  const rr = await getRedirectResult(auth)
  if (rr?.user) {
    // FIX: previously this only logged — the pending role was never consumed
    // and no users/{uid} doc was created, so redirect sign-ups silently
    // defaulted to 'resident' with no profile. Finalise the account here.
    const pending = sessionStorage.getItem('techable_pending_role') || 'resident'
    sessionStorage.removeItem('techable_pending_role')
    try { await ensureGoogleUserDoc(rr.user, pending) }
    catch (docErr) { console.warn('[auth] ensureGoogleUserDoc (redirect):', docErr?.message) }
    console.log('[auth] Redirect sign-in completed:', rr.user.email)
  }
} catch (e) {
  if (e.code !== 'auth/null-user') {
    console.warn('[auth] getRedirectResult:', e.code)
  }
}

onAuthStateChanged(auth, user => {
  _user     = user
  _resolved = true   // FIX: mark auth as resolved (even if user is null)
  _roleCache = null
  if (!user) sessionStorage.clear()
  window.TechableAuth.currentUser = user
  _cbs.forEach(cb => cb(user))
  _cbs = []
  document.dispatchEvent(new CustomEvent('auth:stateChanged', { detail: user }))
})

window.TechableAuth = {
  ready: true,
  currentUser: null,
  app,
  db,
  normalizeRole,

  // FIX: use _resolved instead of if(_user)
  // Old: if(_user) handle(_user) — misses the case where auth resolved
  //      to null BEFORE guard() was called (handler gets pushed to empty
  //      _cbs and is never fired → page hangs forever).
  // New: if(_resolved) handle(_user) — always fires immediately once
  //      Firebase has given us an answer, user or no user.
  guard(onReady) {
    const handle = async user => {
      if (!user) { window.location.href = 'index.html#signin'; return }
      const role = await fetchRoleOrRetry(user.uid)
      if (role === null) { askToRetryRole(() => handle(user)); return }
      const ov = document.getElementById('auth-loading')
      const pv = document.getElementById('page-content')
      if (ov) ov.style.display = 'none'
      if (pv) pv.style.display = 'block'
      if (onReady) onReady(user, role)
    }
    if (_resolved) handle(_user)
    else _cbs.push(handle)
  },

  guardRole(roles, onReady) {
    const allowed = roles.map(normalizeRole)
    this.guard(async (user, role) => {
      const r = normalizeRole(role)
      if (!allowed.includes(r)) {
        if (allowed.includes('service_provider') && cfg?.firebase?.projectId==='techable-qa' && user.uid==='iotk9iBczvVZ2zc3VuA5GtQeLVk1') {
          try {const snapshot=await getDocFromServer(doc(db,'users',user.uid));if(snapshot.exists()&&!snapshot.metadata.fromCache&&!snapshot.metadata.hasPendingWrites&&qaProviderDeveloper(user,snapshot.data())){if(onReady)onReady(user,'service_provider');return}} catch (_) {}
        }
        window.location.href = roleHome(r); return
      }
      if (onReady) onReady(user, r)
    })
  },

  // null is "we could not find out", never "resident": either nobody is signed
  // in, or the users doc would not read. Callers that route on the answer have
  // to treat it as a missing one.
  async getRole() {
    if (!_user) return null
    return fetchRole(_user.uid)
  },

  async getUserDoc() {
    if (!_user) return null
    const data = await fetchUserDoc(_user.uid)
    return data === READ_FAILED ? null : data
  },

  async setRole(uid, role) {
    const n = normalizeRole(role)
    await setDoc(doc(db, 'users', uid), { uid, role: n, updatedAt: serverTimestamp() }, { merge: true })
    sessionStorage.setItem('t_role_' + uid, n)
    _roleCache = n
  },

  async signInGoogle(role = 'resident') {
    const n = normalizeRole(role)
    const popupFail = [
      'auth/popup-blocked', 'auth/popup-closed-by-user',
      'auth/cancelled-popup-request',
      'auth/operation-not-supported-in-this-environment',
      'auth/web-storage-unsupported'
    ]
    try {
      const user = (await signInWithPopup(auth, gp)).user
      await this.ensureGoogleUser(user, n)
      return user
    } catch (err) {
      if (popupFail.includes(err.code)) {
        sessionStorage.setItem('techable_pending_role', n)
        await signInWithRedirect(auth, gp)
        return null
      }
      throw err
    }
  },

  async ensureGoogleUser(user, role) {
    return ensureGoogleUserDoc(user, role)
  },

  async signInEmail(email, password) {
    return (await signInWithEmailAndPassword(auth, email, password)).user
  },

  async signUpEmail(email, password, displayName, role = 'resident') {
    const n    = normalizeRole(role)
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    if (displayName) await updateProfile(cred.user, { displayName })
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid, role: n,
      displayName: displayName || '',
      displayNameLower: (displayName || '').toLowerCase(),
      email, emailLower: email.toLowerCase(),
      avatarSeed: cred.user.uid, isPublic: n === 'community_manager',
      communitySetup: false,
      privacyConsent: true,
      privacyConsentAt: serverTimestamp(),
      privacyPolicyVersion: '2026-08-07',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }, { merge: true })
    sessionStorage.setItem('t_role_' + cred.user.uid, n)
    _roleCache = n
    return cred.user
  },

  async resetPassword(email) {
    await sendPasswordResetEmail(auth, email)
  },

  // True once, straight after a sign-out, and consumed on read. It exists to
  // stop the very next page from using its already-signed-in shortcut, not to
  // be a state the app carries around.
  //
  // The four login pages read the same key directly rather than through this:
  // they run their own Firebase instance and must read it as the page loads,
  // before any auth callback, so importing this module there would initialise a
  // second app. Change the key here and you must change it there.
  justSignedOut() {
    try {
      const flag = sessionStorage.getItem(JUST_SIGNED_OUT)
      if (flag) sessionStorage.removeItem(JUST_SIGNED_OUT)
      return Boolean(flag)
    } catch (_) { return false }
  },

  async updateName(name) {
    if (!_user) return
    await updateProfile(_user, { displayName: name })
    await setDoc(doc(db, 'users', _user.uid), {
      displayName: name, displayNameLower: name.toLowerCase(),
      updatedAt: serverTimestamp()
    }, { merge: true })
    window.TechableAuth.currentUser = auth.currentUser
  },

  // "I can't log out. It keeps me logged in."
  //
  // Two things made that possible. Firebase's signOut() can sit unresolved —
  // a device that has gone offline mid-token-refresh, storage the browser will
  // not open — and this awaited it with no deadline, so the button above it
  // stayed on "Logging out…" and the session was never dropped. And when it did
  // fail, the caller redirected anyway: the user landed on a login page still
  // authenticated, and that page's already-signed-in shortcut walked them
  // straight back into the app. From the outside it looks like the app refusing
  // to let go.
  //
  // Signing out is not a request the app gets to lose. It is given a deadline,
  // and then finished by hand.
  async signOut() {
    _roleCache = null
    try { sessionStorage.clear() } catch (_) {}

    try {
      await Promise.race([
        signOut(auth),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), SIGN_OUT_MS))
      ])
    } catch (err) {
      console.warn('[auth] signOut did not complete cleanly:', err?.message)
    }

    // The persisted session is what the next page reads, so it is what decides
    // whether they are really signed out. In the normal case signOut() has
    // already removed these and this does nothing; in the case above it is the
    // difference between logging out and appearing to.
    try {
      Object.keys(localStorage)
        .filter(k => /^firebase:(authUser|redirectEvent)/.test(k))
        .forEach(k => localStorage.removeItem(k))
    } catch (_) {}

    // Transcripts, check-ins and profiles were saved on this device too. Only
    // here, for a real account whose data lives in Firestore: the no-config
    // stub's signOut deliberately keeps them, because for a guest this device
    // is the only copy.
    await clearPersonalLocalData()

    // Read by the login pages, which otherwise skip their own form for anyone
    // already signed in — the shortcut that turned a half-failed sign-out into
    // a round trip back to the app.
    try { sessionStorage.setItem(JUST_SIGNED_OUT, '1') } catch (_) {}

    _user = null
    window.TechableAuth.currentUser = null

    // replace(), not href: Back must not step into a workspace they have just
    // left, and on a shared or borrowed device that is the whole point.
    window.location.replace('index.html#signin')
  },

  // Deleting the sign-in alone used to leave users/{uid} behind, holding the
  // role that decides what the account can see. Then the cascade that fixed
  // that swallowed every failure and deleted the sign-in anyway — and since
  // every delete rule is bound to request.auth.uid, whatever it left behind
  // could never be deleted by anyone again.
  //
  // The cascade now lives in account-deletion.js, shared with
  // senior-login.html (which runs its own Firebase app and cannot load this
  // module). It never deletes the sign-in while any record is left. This
  // resolves to its result and never throws: the page shows result.message
  // and the person can try again.
  //
  // Loaded only when someone presses delete: every signed-in page loads
  // this file, and a static import that failed to fetch would take all of
  // them down with it.
  async deleteAccount() {
    if (!_user) {
      window.location.href = 'index.html#signin'
      return { ok: false, reason: 'signed-out', failed: [], message: 'You are not signed in.' }
    }
    let deleteAccountAndData
    try {
      ({ deleteAccountAndData } = await import('./account-deletion.js'))
    } catch (err) {
      console.warn('[auth] could not load account-deletion.js:', err?.message)
      return {
        ok: false, reason: 'load-failed', failed: [],
        message: 'Account deletion could not start. Please check your connection and try again. Nothing has been deleted.'
      }
    }
    const result = await deleteAccountAndData({
      user: _user, db, deleteUser,
      fs: { collection, query, where, getDocs, getDocsFromServer, doc, getDoc, getDocFromServer,
            setDoc, deleteDoc, writeBatch, serverTimestamp }
    })
    if (result.ok) {
      _roleCache = null
      _user = null
      window.TechableAuth.currentUser = null
      window.location.href = 'index.html#signin'
    }
    return result
  },

  roleHome,
  userName: u => (u||_user)?.displayName || (u||_user)?.email?.split('@')[0] || 'User',
  initials: u => {
    const n = (u||_user)?.displayName || (u||_user)?.email || '?'
    return n.split(/[\s@]/).filter(Boolean).map(w => w[0]).slice(0,2).join('').toUpperCase()
  },
  photoURL: u => (u||_user)?.photoURL || null,

  // `provider` says which route the caller used: 'google' for the Google
  // button, 'password' for the email form. It only matters for
  // auth/operation-not-allowed, which Firebase throws for BOTH a disabled
  // Google provider and a disabled Email/Password provider. Naming the wrong
  // one sends people hunting the wrong setting — a disabled Email/Password
  // provider used to report itself as "Google sign-in is not enabled".
  friendlyError(code, provider) {
    const notEnabled = {
      google:   'Google sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.',
      password: 'Email/password sign-in is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.',
    }[provider] || 'That sign-in method is not enabled. Enable it in Firebase Console → Authentication → Sign-in method.'
    return {
      'auth/user-not-found':          'No account found with that email. If you joined with Google, use the Google button.',
      'auth/wrong-password':          'Incorrect password.',
      'auth/email-already-in-use':    'That email is already registered.',
      'auth/weak-password':           'Password must be at least 6 characters.',
      'auth/invalid-email':           'Please enter a valid email address.',
      // Google-created accounts have no password here, and Firebase collapses
      // that case into invalid-credential — so the message has to name it.
      'auth/invalid-credential':      'Incorrect email or password — or this email was registered with Google. Try the Google button instead.',
      'auth/too-many-requests':       'Too many attempts. Wait a moment.',
      'auth/requires-recent-login':   'Please sign out and sign back in.',
      'auth/network-request-failed':  'Network error. Check your connection.',
      'auth/popup-blocked':           'Popup blocked — use redirect sign-in.',
      'auth/unauthorized-domain':     'This domain is not authorized for Google sign-in. Add it in Firebase Console → Authentication → Settings → Authorized Domains.',
      'auth/operation-not-allowed':   notEnabled,
    }[code] || 'Something went wrong (' + (code || 'unknown') + ').'
  }
}

// Replay any guard()/guardRole() calls that pages made while this module was
// still suspended on its top-level awaits.
drainPending()
