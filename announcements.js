// announcements.js — centre news and provider programmes (F42).
//
// Community centres post news and events to the seniors who follow them;
// service providers post programmes (free phones, canes, paid drivers) to all
// seniors. Only accounts approved in the admin console may post: a "free iPad,
// send us your details" post from an unchecked account is a scam aimed at
// exactly this audience. firestore.rules enforces that; the checks here are
// for the person typing, not for security.
//
// Collections:
//   announcements/{auto}          { source: 'community'|'provider', communityId?, communityName?,
//                                   organisation?, authorUid, authorName, title, body,
//                                   eventDate ('YYYY-MM-DD' or ''), link (https or ''), createdAt }
//   follows/{uid}_{communityId}   { uid, communityId, communityName, createdAt }
//
// Every function that touches Firestore takes the page's modular Firestore
// functions as `fs` (collection, doc, query, where, orderBy, limit, getDocs, addDoc,
// setDoc, deleteDoc, serverTimestamp), so this module has no network imports
// and runs under the Node tests too. Everything rendered uses textContent.

export const LIMITS = { title: 120, body: 2000, link: 500 }
const FEED_LIMIT = 40
const IN_BATCH = 30   // Firestore's cap on the values in one "in" filter

// ── Input ───────────────────────────────────────────────────────────────────

// https only. A bare "example.org" is read as the address it was meant to be.
// Anything else (javascript:, data:, mailto:, plain http) is refused: a post
// is shown to every senior who follows the centre, and one tap on it must not
// run code or leave the encrypted web.
export function safeLink(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s
  try {
    const u = new URL(withScheme)
    return u.protocol === 'https:' && u.hostname.includes('.') ? u.href : ''
  } catch (_) { return '' }
}

// Returns { ok: true, data } ready for postAnnouncement, or { ok: false, error }
// in words a centre manager can act on. `who` carries the fields the page
// knows: source, communityId/communityName or organisation, authorUid/Name.
export function cleanAnnouncement(input, who) {
  const title = String(input?.title ?? '').trim()
  const body = String(input?.body ?? '').trim()
  const eventDate = String(input?.eventDate ?? '').trim()
  const rawLink = String(input?.link ?? '').trim()

  if (!title) return { ok: false, error: 'Add a title.' }
  if (title.length > LIMITS.title) return { ok: false, error: `Keep the title under ${LIMITS.title} characters.` }
  if (body.length > LIMITS.body) return { ok: false, error: `Keep the details under ${LIMITS.body} characters.` }
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return { ok: false, error: 'Pick the date from the calendar, or leave it empty.' }
  const link = safeLink(rawLink)
  if (rawLink && (!link || link.length > LIMITS.link)) return { ok: false, error: 'The link must be a web address starting with https://' }

  const data = {
    source: who.source,
    authorUid: who.authorUid,
    authorName: String(who.authorName || '').slice(0, 120),
    title, body, eventDate, link
  }
  if (who.source === 'community') {
    data.communityId = who.communityId
    data.communityName = String(who.communityName || '').slice(0, 120)
  } else {
    data.organisation = String(who.organisation || '').slice(0, 120)
  }
  return { ok: true, data }
}

// ── Verification ────────────────────────────────────────────────────────────

export function canPost(profile) {
  const status = profile?.verificationStatus || 'not_submitted'
  if (status === 'approved') return { ok: true, status, message: 'Your account is verified.' }
  if (status === 'pending') {
    return { ok: false, status, message: 'The Techable team is checking the documents you sent. You can post as soon as your account is approved.' }
  }
  if (status === 'rejected') {
    const note = String(profile?.verificationNote || '').trim()
    return { ok: false, status, message: 'Your account was not approved yet' + (note ? ': “' + note + '”.' : '.') + ' Please contact the Techable team to put this right.' }
  }
  return { ok: false, status, message: 'Your account has not been verified yet. The Techable team reviews every centre and provider before they can post to seniors.' }
}

// The reviewer's note for a rejection. It lives in verification_notes/{uid},
// which only its owner can read: users/{uid} of a manager is readable by
// every signed-in account (bug hunt 2026-10-22, BUG-008). Empty when there is
// none or it cannot be read — the message then simply has no reason in it.
export async function verificationNote(fs, db, uid) {
  if (!fs?.getDoc || !fs?.doc || !uid) return ''
  try {
    const snap = await fs.getDoc(fs.doc(db, 'verification_notes', uid))
    return snap.exists() ? String(snap.data()?.note || '').trim() : ''
  } catch (_) {
    return ''
  }
}

// ── Following ───────────────────────────────────────────────────────────────

export async function myFollows(fs, db, uid) {
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'follows'), fs.where('uid', '==', uid)))
  const ids = new Set()
  snap.forEach(d => { const c = d.data().communityId; if (c) ids.add(c) })
  return ids
}

export async function follow(fs, db, uid, community) {
  await fs.setDoc(fs.doc(db, 'follows', uid + '_' + community.id), {
    uid, communityId: community.id,
    communityName: String(community.name || '').slice(0, 120),
    createdAt: fs.serverTimestamp()
  })
}

export async function unfollow(fs, db, uid, communityId) {
  await fs.deleteDoc(fs.doc(db, 'follows', uid + '_' + communityId))
}

export async function followerCount(fs, db, communityId) {
  const snap = await fs.getDocs(fs.query(fs.collection(db, 'follows'), fs.where('communityId', '==', communityId)))
  return snap.docs ? snap.docs.length : (snap.size || 0)
}

// ── Posts ───────────────────────────────────────────────────────────────────

function withTime(d) {
  const data = d.data()
  const at = data.createdAt?.toDate ? data.createdAt.toDate() : (data.createdAt ? new Date(data.createdAt) : null)
  return { id: d.id, ...data, createdAtMs: at ? at.getTime() : 0 }
}

const newestFirst = (a, b) => b.createdAtMs - a.createdAtMs

export async function postAnnouncement(fs, db, data) {
  const ref = await fs.addDoc(fs.collection(db, 'announcements'), { ...data, createdAt: fs.serverTimestamp() })
  return ref.id
}

export async function deleteAnnouncement(fs, db, id) {
  await fs.deleteDoc(fs.doc(db, 'announcements', id))
}

export async function myAnnouncements(fs, db, uid) {
  const snap = await fs.getDocs(fs.query(
    fs.collection(db, 'announcements'),
    fs.where('authorUid', '==', uid),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(100)
  ))
  const out = []
  snap.forEach(d => out.push(withTime(d)))
  return out.sort(newestFirst)
}

// News from the given centres plus every provider programme, newest first.
// Firestore must order before limiting: limiting its default document-id order
// and sorting that subset in the browser permanently hides newer posts once a
// source has more than FEED_LIMIT documents.
export async function loadFeed(fs, db, communityIds) {
  const ids = [...new Set(communityIds || [])]
  const coll = fs.collection(db, 'announcements')
  const queries = [fs.query(
    coll, fs.where('source', '==', 'provider'),
    fs.orderBy('createdAt', 'desc'), fs.limit(FEED_LIMIT)
  )]
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    queries.push(fs.query(
      coll, fs.where('communityId', 'in', ids.slice(i, i + IN_BATCH)),
      fs.orderBy('createdAt', 'desc'), fs.limit(FEED_LIMIT)
    ))
  }
  const snaps = await Promise.all(queries.map(q => fs.getDocs(q)))
  const seen = new Map()
  for (const snap of snaps) snap.forEach(d => seen.set(d.id, withTime(d)))
  return [...seen.values()].sort(newestFirst).slice(0, FEED_LIMIT)
}

// ── Rendering (browser only) ────────────────────────────────────────────────

const STYLE = `
.tn-feed{list-style:none;display:flex;flex-direction:column;gap:12px;margin:0;padding:0}
.tn-item{background:var(--white,#fff);border:1px solid var(--border,rgba(180,156,136,.22));border-left:4px solid var(--rust,#C4552B);border-radius:14px;padding:16px 18px}
.tn-item.tn-provider{border-left-color:var(--purple,#5B4DA8)}
.tn-from{font-size:14px;font-weight:600;color:var(--ink2,#4A3828);margin-bottom:4px}
.tn-title{font-size:19px;font-weight:600;color:var(--navy,#0D1B2A);line-height:1.35;margin:0}
.tn-when{display:inline-block;margin-top:6px;font-size:15px;font-weight:600;color:var(--rust,#C4552B)}
.tn-body{margin-top:8px;font-size:17px;line-height:1.6;color:var(--ink,#1A1208);white-space:pre-wrap;overflow-wrap:anywhere}
.tn-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:10px;font-size:14px;color:var(--ink2,#4A3828)}
.tn-foot a{display:inline-flex;align-items:center;min-height:44px;color:var(--rust,#C4552B);font-weight:600;font-size:16px}
.tn-empty{font-size:16px;color:var(--ink2,#4A3828);line-height:1.6}
.tn-status{padding:12px 14px;border-radius:12px;font-size:14px;line-height:1.55;margin-bottom:14px}
.tn-status.ok{background:var(--green-bg,#EBF5EF);color:var(--green,#2D6A4F)}
.tn-status.wait{background:#FBF4E3;color:#7A5208}
.tn-status.no{background:#FEF2EF;color:#9B2C2C}
.tn-form{display:flex;flex-direction:column;gap:12px}
.tn-form label{display:block;font-size:13px;font-weight:600;color:var(--ink2,#4A3828);margin-bottom:5px}
.tn-form input,.tn-form textarea,.tn-form select{width:100%;padding:11px 13px;border:1.5px solid var(--border2,rgba(180,156,136,.38));border-radius:10px;font:inherit;font-size:16px;color:var(--ink,#1A1208);background:#fff;box-sizing:border-box}
.tn-form textarea{min-height:96px;resize:vertical}
.tn-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:560px){.tn-row{grid-template-columns:1fr}}
.tn-post{align-self:flex-start;min-height:44px;padding:0 20px;border:none;border-radius:10px;background:var(--rust,#C4552B);color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.tn-post:disabled{opacity:.55;cursor:not-allowed}
.tn-msg{font-size:14px;line-height:1.5}
.tn-msg.err{color:#9B2C2C}.tn-msg.ok{color:var(--green,#2D6A4F)}
.tn-mine-h{font-size:15px;font-weight:600;color:var(--navy,#0D1B2A);margin:18px 0 8px}
.tn-del{min-height:40px;padding:0 14px;border:1.5px solid var(--border2,rgba(180,156,136,.38));border-radius:10px;background:#fff;color:#9B2C2C;font:inherit;font-size:14px;font-weight:600;cursor:pointer}
.tn-form input:focus-visible,.tn-form textarea:focus-visible,.tn-form select:focus-visible,.tn-post:focus-visible,.tn-del:focus-visible,.tn-foot a:focus-visible{outline:3px solid var(--rust,#C4552B);outline-offset:2px}
`

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById('tn-style')) return
  const s = document.createElement('style')
  s.id = 'tn-style'
  s.textContent = STYLE
  document.head.appendChild(s)
}

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

export function formatEventDate(ymd) {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return isNaN(date) ? '' : date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

function postedOn(ms) {
  return ms ? 'Posted ' + new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''
}

function itemNode(a, extra) {
  const li = el('li', 'tn-item' + (a.source === 'provider' ? ' tn-provider' : ''))
  li.appendChild(el('div', 'tn-from', a.source === 'provider'
    ? (a.organisation || 'Service provider') + ' · Programme'
    : (a.communityName || 'Your community centre')))
  li.appendChild(el('h3', 'tn-title', a.title))
  if (a.eventDate) li.appendChild(el('span', 'tn-when', '📅 ' + formatEventDate(a.eventDate)))
  if (a.body) li.appendChild(el('p', 'tn-body', a.body))
  const foot = el('div', 'tn-foot')
  const link = safeLink(a.link)
  if (link) {
    const l = el('a', null, 'More details')
    l.href = link
    l.target = '_blank'
    l.rel = 'noopener noreferrer'
    foot.appendChild(l)
  }
  foot.appendChild(el('span', null, postedOn(a.createdAtMs)))
  if (extra) foot.appendChild(extra)
  li.appendChild(foot)
  return li
}

export function renderFeed(container, items, emptyText) {
  ensureStyle()
  container.textContent = ''
  if (!items.length) {
    container.appendChild(el('p', 'tn-empty', emptyText || 'Nothing posted yet.'))
    return
  }
  const ul = el('ul', 'tn-feed')
  items.forEach(a => ul.appendChild(itemNode(a)))
  container.appendChild(ul)
}

// The posting card for a centre manager (source 'community', `centres` = their
// communities) or a provider (source 'provider', `organisation`).
export function mountComposer(container, { fs, db, user, profile, source, centres = [], organisation = '', authorName = '' }) {
  ensureStyle()
  container.textContent = ''
  const gate = canPost(profile)
  const status = el('p', 'tn-status ' + (gate.ok ? 'ok' : gate.status === 'rejected' ? 'no' : 'wait'),
    gate.ok
      ? (source === 'community'
        ? '✓ Verified. Seniors who choose to follow your centre see what you post here.'
        : '✓ Verified. Programmes you post here are shown to every senior on Techable.')
      : gate.message)
  container.appendChild(status)
  if (gate.status === 'rejected' && !profile?.verificationNote) {
    verificationNote(fs, db, user?.uid).then(note => {
      if (note) status.textContent = canPost({ ...profile, verificationNote: note }).message
    })
  }

  if (source === 'community' && !centres.length) {
    container.appendChild(el('p', 'tn-empty', 'Set up your centre profile first, then you can post news and events for it.'))
    return
  }
  // Only centres the admin console verified can post (firestore.rules). A
  // centre added since the account was approved waits for the next review.
  const unverified = source === 'community' ? centres.filter(c => !c.verified) : []
  if (source === 'community') centres = centres.filter(c => c.verified)
  if (gate.ok && unverified.length) {
    container.appendChild(el('p', 'tn-status wait',
      (unverified.length === 1 ? unverified[0].name || 'Your new centre' : unverified.length + ' of your centres') +
      ' will appear here once the Techable team has reviewed ' + (unverified.length === 1 ? 'it' : 'them') + '.'))
  }
  if (source === 'community' && !centres.length) return

  const form = el('form', 'tn-form')
  form.noValidate = true
  const field = (label, input) => {
    const wrap = el('div')
    const id = 'tn-' + Math.random().toString(36).slice(2, 8)
    const lab = el('label', null, label)
    lab.htmlFor = id
    input.id = id
    wrap.appendChild(lab)
    wrap.appendChild(input)
    return wrap
  }

  let centreSelect = null
  if (source === 'community' && centres.length > 1) {
    centreSelect = el('select')
    centres.forEach(c => { const o = el('option', null, c.name || 'Unnamed centre'); o.value = c.id; centreSelect.appendChild(o) })
    form.appendChild(field('Centre', centreSelect))
  }
  const title = el('input'); title.maxLength = LIMITS.title
  title.placeholder = source === 'community' ? 'e.g. Piano concert this Saturday' : 'e.g. Free mobile phones for eligible seniors'
  form.appendChild(field('Title', title))
  const row = el('div', 'tn-row')
  const date = el('input'); date.type = 'date'
  row.appendChild(field(source === 'community' ? 'Date of the event (optional)' : 'Apply by (optional)', date))
  const link = el('input'); link.type = 'url'; link.placeholder = 'https://…'; link.maxLength = LIMITS.link
  row.appendChild(field('Link for more details (optional)', link))
  form.appendChild(row)
  const body = el('textarea'); body.maxLength = LIMITS.body
  body.placeholder = source === 'community' ? 'Where, what time, what to bring…' : 'Who qualifies and how to apply…'
  form.appendChild(field('Details', body))
  const post = el('button', 'tn-post', source === 'community' ? 'Post to followers' : 'Post programme')
  post.type = 'submit'
  form.appendChild(post)
  const msg = el('p', 'tn-msg')
  msg.setAttribute('role', 'status')
  form.appendChild(msg)

  if (!gate.ok) [centreSelect, title, date, link, body, post].forEach(x => { if (x) x.disabled = true })
  container.appendChild(form)

  const mineHead = el('h3', 'tn-mine-h', 'Your posts')
  const mine = el('div')
  container.appendChild(mineHead)
  container.appendChild(mine)

  async function refresh() {
    try {
      const posts = await myAnnouncements(fs, db, user.uid)
      mine.textContent = ''
      if (!posts.length) { mine.appendChild(el('p', 'tn-empty', 'You have not posted anything yet.')); return }
      const ul = el('ul', 'tn-feed')
      posts.forEach(a => {
        const del = el('button', 'tn-del', 'Delete')
        del.type = 'button'
        del.addEventListener('click', async () => {
          if (!confirm('Delete “' + a.title + '”? Seniors will no longer see it.')) return
          del.disabled = true
          try { await deleteAnnouncement(fs, db, a.id); refresh() }
          catch (e) { del.disabled = false; msg.className = 'tn-msg err'; msg.textContent = 'Could not delete (' + (e.code || e.message) + ').' }
        })
        ul.appendChild(itemNode(a, del))
      })
      mine.appendChild(ul)
    } catch (e) {
      mine.textContent = ''
      mine.appendChild(el('p', 'tn-empty', 'Could not load your posts (' + (e.code || e.message) + ').'))
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault()
    if (!gate.ok) return
    const centre = source === 'community'
      ? (centreSelect ? centres.find(c => c.id === centreSelect.value) : centres[0])
      : null
    const r = cleanAnnouncement({ title: title.value, body: body.value, eventDate: date.value, link: link.value }, {
      source, authorUid: user.uid, authorName,
      communityId: centre?.id, communityName: centre?.name, organisation
    })
    if (!r.ok) { msg.className = 'tn-msg err'; msg.textContent = r.error; return }
    post.disabled = true
    msg.className = 'tn-msg'; msg.textContent = 'Posting…'
    try {
      await postAnnouncement(fs, db, r.data)
      title.value = body.value = date.value = link.value = ''
      msg.className = 'tn-msg ok'
      msg.textContent = source === 'community'
        ? 'Posted. It now appears in the news for seniors who follow ' + (centre?.name || 'your centre') + '.'
        : 'Posted. It now appears in every senior’s news.'
      refresh()
    } catch (err) {
      msg.className = 'tn-msg err'
      msg.textContent = err.code === 'permission-denied'
        ? 'Techable would not accept this post. Your account may not be approved yet — reload the page to check.'
        : 'Could not post (' + (err.code || err.message) + ').'
    } finally { post.disabled = false }
  })

  refresh()
}
