// ============================================================
// app.js — Techable AI Companion
// Role-based resident/community-manager layout
// Firestore resident CRUD + DiceBear avatars
// No Firebase Storage / no paid storage required
// ============================================================

(function () {
  'use strict'

  const STORE_KEY = 'techable_residents_v3'
  const SELECTED_KEY = 'techable_selected_resident_id'
  const SESSION_PREFIX = 'techable_sessions_'
  const CHECKIN_PREFIX = 'techable_checkins_'

  const AVATAR_STYLES = [
    'lorelei-neutral',
    'adventurer',
    'micah',
    'personas',
    'bottts',
    'thumbs',
    'pixel-art',
    'fun-emoji',
    'shapes'
  ]

  let residents = []
  let communities = []
  let selectedId = null
  let activeTab = 'dashboard'
  let dirtyState = false
  let currentMessages = []
  let sessionStartedAt = null
  let recognition = null
  let recognizing = false

  // How many exchanges in a row have stayed on one subject. Sent to /api/chat,
  // which turns it into an instruction to change the subject. Counted here
  // rather than in the prompt because a model asked to keep a running tally of
  // its own questions does not reliably do it.
  const TOPIC_FLOOR = 3
  let topicRun = 0
  let topicKey = ''
  let topicSeed = ''
  let topicRotation = 0

  // How the senior last spoke to the companion — 'voice' or 'type' — which
  // decides whether the microphone reopens by itself after a reply. See
  // loadChatMode() for why a first visit starts as 'type'.
  const CHAT_MODE_KEY = 'techable_chat_mode'
  let chatMode = 'type'

  let db = null
  let fs = null
  let authUser = null
  let userDoc = null
  let role = 'resident'
  let firestoreReady = false
  let usingFirestore = false

  // True when we could not read this senior's own record and do not know what
  // is in the database. Everything that would WRITE under an id we are not sure
  // of is held back while this is set — otherwise a failed read becomes a
  // duplicate profile, and a check-in gets filed against an id nobody reads.
  let selfLoadFailed = false
  let deploymentAiModeCaptured = false
  let deploymentAiMode

  function $(id) { return document.getElementById(id) }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function nowIso() {
    return new Date().toISOString()
  }

  // The senior's controls — the talk button, the read-aloud switch, the bar
  // at the foot of the screen — in the language they speak. i18n.js holds the
  // words; the key itself is the last resort, so a missing translation shows
  // up in testing instead of as a blank button.
  function chrome(key, vars) {
    return window.TechableI18n?.t?.(key, vars) || key
  }

  // ── What to call them ─────────────────────────────────────────
  // The record holds a legal name ("Jessica Wang"); a companion says the one
  // name a friend would. Kept in step with givenName() in api/chat.js, which
  // repeats this for the prompt because the server cannot trust that an old
  // cached copy of this file did it.
  //
  // CJK names are returned whole: Chinese names are family-name-first, so the
  // trailing characters are the given name, and calling an elderly 王婉婷
  // "婉婷" is how a close relative speaks, not a companion.
  // The family forms ("Auntie Mary", "Uncle Lim", "Mdm Tan") are how many
  // seniors ask to be called — the first visit asks — and are kept whole too.
  const NAME_TITLE = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|lady|lord|rev|reverend|fr|father|sr|sister|capt|captain|col|colonel|maj|major|sgt|hon|aunt|auntie|aunty|uncle|grandma|grandpa|granny|grandad|granddad|nana|madam|mdm)\.?$/i

  function givenName(full) {
    const s = String(full ?? '').trim().replace(/\s+/g, ' ')
    if (!s) return ''
    if (/[㐀-鿿豈-﫿぀-ヿ]/.test(s)) return s

    // "Mrs Chan" is a decision about how to address someone, not a full name
    // left in by accident, so it is left exactly as it is.
    const words = s.split(' ')
    if (NAME_TITLE.test(words[0]) && words.length > 1) return s

    const first = words[0]
    if (/,$/.test(first) && words[1]) return words[1].replace(/,+$/, '')  // "Wang, Jessica"
    if (/^[A-Za-z]\.?$/.test(first) && words[1]) return words[1]          // "J. Wang"
    return first.replace(/,+$/, '')
  }

  // The name every spoken and written line should use for a resident record.
  function speakableName(r) {
    return givenName(r?.preferredName || r?.name || '')
  }

  function cryptoId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID()
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)
  }

  function normalizeRole(value) {
    if (window.TechableAuth?.normalizeRole) return window.TechableAuth.normalizeRole(value)
    if (value === 'elderly') return 'resident'
    if (value === 'centre') return 'community_manager'
    if (value === 'builder') return 'resident'
    if (value === 'community_manager') return 'community_manager'
    if (value === 'family') return 'family'
    if (value === 'provider' || value === 'service_provider') return 'service_provider'
    return 'resident'
  }

  function isResident() {
    return role === 'resident'
  }

  function isManager() {
    return role === 'community_manager'
  }

  function safeAvatarStyle(style) {
    if ([...AVATAR_STYLES, 'initials'].includes(style)) return style
    return 'lorelei-neutral'
  }

  function randomAvatarStyle() {
    return AVATAR_STYLES[Math.floor(Math.random() * AVATAR_STYLES.length)]
  }

  function randomAvatarSeed(prefix = 'resident') {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }

  function diceUrl(seed, style = 'lorelei-neutral') {
    const safeStyle = safeAvatarStyle(style)
    const params = new URLSearchParams({
      seed: seed || 'resident',
      radius: '50',
      backgroundColor: 'fdf0eb,faf6f0,ebf5ef,fbf4e3,e0f2fe',
      backgroundType: 'solid,gradientLinear',
      randomizeIds: 'true'
    })

    return `https://api.dicebear.com/9.x/${safeStyle}/svg?${params.toString()}`
  }

  // ── The life story book's shape ───────────────────────────────
  // residents/{id}.lifeStory: { id, chapter, text, prompt, createdAt, source },
  // every value a string. The family dashboard reads the same entries, and the
  // rules allow the list on the resident record, capped at STORY_MAX entries.
  // Chapter keys are storage values, in book order.
  const STORY_CHAPTERS = ['childhood', 'school', 'work', 'love', 'family', 'recipes', 'places', 'lessons', 'other']
  const STORY_SOURCES = ['story', 'conversation', 'manual']
  const STORY_MAX = 300
  const STORY_TEXT_MAX = 4000

  function normalizeStoryEntry(e) {
    if (!e || typeof e !== 'object') return null
    const text = String(e.text ?? '').trim().slice(0, STORY_TEXT_MAX)
    if (!text) return null
    return {
      id: String(e.id || cryptoId()).slice(0, 80),
      chapter: STORY_CHAPTERS.includes(e.chapter) ? e.chapter : 'other',
      text,
      prompt: String(e.prompt ?? '').slice(0, 300),
      createdAt: String(e.createdAt || nowIso()),
      source: STORY_SOURCES.includes(e.source) ? e.source : 'manual'
    }
  }

  function normalizeLifeStory(list) {
    return (Array.isArray(list) ? list : []).map(normalizeStoryEntry).filter(Boolean).slice(0, STORY_MAX)
  }

  // Roughly what the book weighs in the record, in UTF-8 bytes.
  const STORY_BYTES_MAX = 600000
  function storyBytes(list) {
    const json = JSON.stringify(list || [])
    try { return new TextEncoder().encode(json).length } catch (_) { return json.length * 3 }
  }

  function normalizeResident(id, d) {
    const seed = d.avatarSeed || d.name || id || cryptoId()

    return {
      id,
      name: d.name || '',
      preferredName: d.preferredName || '',
      age: Number.isFinite(Number(d.age)) ? Number(d.age) : null,
      room: d.room || '',
      status: d.status || 'active',
      communityId: d.communityId || '',
      communityName: d.communityName || '',
      background: d.background || '',
      family: d.family || '',
      medical: d.medical || '',
      notes: d.notes || '',
      // Which language Techable speaks to this person in: 'en', 'cmn'
      // (Mandarin) or 'yue' (Cantonese). Normalised so a record written by
      // hand with "zh-HK" or "Cantonese" still resolves.
      language: window.TechableI18n?.normalise(d.language) || 'en',
      avatarSeed: seed,
      avatarStyle: safeAvatarStyle(d.avatarStyle || 'lorelei-neutral'),
      memories: Array.isArray(d.memories) ? d.memories.map(m => ({
        id: m.id || cryptoId(),
        text: m.text || '',
        tag: m.tag || 'memory',
        createdAt: m.createdAt || nowIso()
      })) : [],
      lifeStory: normalizeLifeStory(d.lifeStory),
      // When they finished (or skipped) the first-visit welcome. Empty until then.
      onboardedAt: !d.onboardedAt ? '' : d.onboardedAt.toDate ? d.onboardedAt.toDate().toISOString() : String(d.onboardedAt),
      // Who may send them family messages, and who may not: theirs to decide.
      messageFrom: Array.isArray(d.messageFrom) ? d.messageFrom.filter(x => typeof x === 'string') : [],
      messageBlocked: Array.isArray(d.messageBlocked) ? d.messageBlocked.filter(x => typeof x === 'string') : [],
      wellnessForm: d.wellnessForm && typeof d.wellnessForm === 'object' ? { ...d.wellnessForm } : null,
      benefitDraft: d.benefitDraft && typeof d.benefitDraft === 'object' ? { ...d.benefitDraft } : null,
      myDetails: cleanMyDetails(d.myDetails),
      ownerUid: d.ownerUid || '',
      centreId: d.centreId || '',
      createdBy: d.createdBy || '',
      createdAt: d.createdAt || nowIso(),
      updatedAt: d.updatedAt || nowIso(),
      _source: d._source || 'firestore'
    }
  }

  function normalizeCommunity(id, d) {
    return {
      id,
      name: d.name || '',
      details: d.details || '',
      address: d.address || '',
      city: d.city || '',
      country: d.country || '',
      mapUrl: d.mapUrl || '',
      website: d.website || '',
      contactEmail: d.contactEmail || '',
      phone: d.phone || '',
      category: d.category || 'community',
      isPublic: d.isPublic !== false,
      // Set only by the admin console when it approves the manager. Only a
      // verified centre can be asked to join (firestore.rules).
      verified: d.verified === true,
      managerUid: d.managerUid || d.ownerUid || '',
      upcomingActivities: d.upcomingActivities || '',
      createdAt: d.createdAt || nowIso(),
      updatedAt: d.updatedAt || nowIso()
    }
  }

  function userDisplayName() {
    return userDoc?.displayName || authUser?.displayName || authUser?.email?.split('@')[0] || 'Resident'
  }

  // A name we are willing to say out loud — or nothing at all.
  //
  // userDisplayName() above falls back to the local part of the email address,
  // which is right for the sidebar and wrong for a companion: the name fields
  // on senior-login.html are optional, so an account with no name is ordinary,
  // and "mary.lim82" was being copied into the resident record and then spoken
  // — "Good morning, mary.lim82. It is good to hear from you."
  //
  // A resident with no name is already handled everywhere it matters: the
  // check-in addresses them as "there", the greeting closes the gap where the
  // name would go, and the profile header reads "Unnamed Resident". Saying
  // nothing is better than saying an email address.
  function accountRealName() {
    return String(userDoc?.displayName || authUser?.displayName || '').trim()
  }

  // The signed-in account's own id, normally. When there is no session to read
  // it from — a build with no Firebase configured, or auth that has not
  // resolved — this used to be a fresh random id on every page load, and every
  // record keyed by it was orphaned each time: the day's check-in marker, the
  // saved sessions, the check-in history. The visible symptom is the companion
  // asking "How are you feeling today?" again on every visit, because as far as
  // it could tell it was meeting a different person. Kept once and reused.
  const SELF_ID_KEY = 'techable_self_resident_id'

  function selfResidentId() {
    if (authUser?.uid) return authUser.uid
    try {
      const kept = localStorage.getItem(SELF_ID_KEY)
      if (kept) return kept
      const made = cryptoId()
      localStorage.setItem(SELF_ID_KEY, made)
      return made
    } catch (_) {
      return cryptoId()
    }
  }

  function defaultSelfResident() {
    const name = accountRealName()
    return normalizeResident(selfResidentId(), {
      name,
      // Left empty on purpose. Seeding this from the account pre-filled the
      // Preferred Name box on the profile page, and preferredName beats name in
      // speakableName() — so a senior who corrected their full name went on
      // being called the old one, with nothing on screen to say that a second
      // box was the one the companion actually reads. A preferred name is a
      // choice somebody makes, not a copy of their sign-in.
      preferredName: '',
      status: 'active',
      communityId: userDoc?.communityId || '',
      communityName: userDoc?.communityName || '',
      background: userDoc?.bio || '',
      avatarSeed: userDoc?.avatarSeed || authUser?.uid || name,
      avatarStyle: userDoc?.avatarStyle || 'lorelei-neutral',
      memories: [],
      ownerUid: authUser?.uid || '',
      centreId: '',
      createdBy: authUser?.uid || '',
      _source: 'self'
    })
  }

  function defaultResidents() {
    const source = window.TECHABLE_DATA?.residents
    if (!Array.isArray(source)) return []

    return source.map(r => normalizeResident(r.id || cryptoId(), {
      ...r,
      avatarSeed: r.avatarSeed || r.name || r.id,
      avatarStyle: r.avatarStyle || randomAvatarStyle(),
      ownerUid: isManager() ? authUser?.uid || '' : '',
      centreId: isManager() ? authUser?.uid || '' : '',
      createdBy: isManager() ? authUser?.uid || '' : '',
      createdAt: r.createdAt || nowIso(),
      updatedAt: r.updatedAt || nowIso(),
      _source: 'sample'
    }))
  }

  // A senior's own record, under a key of its own. Not the manager's
  // STORE_KEY list: the two roles can share a browser, and a resident written
  // into that array would turn up in a manager's roster.
  const SELF_PROFILE_KEY = 'techable_self_profile_'

  function loadLocalResidents() {
    if (isResident()) {
      const base = defaultSelfResident()
      try {
        const raw = localStorage.getItem(SELF_PROFILE_KEY + base.id)
        if (raw) {
          // Merged over the defaults rather than used as it stands, so a record
          // written by an older build still comes back with today's fields on
          // it. The id is the account's, never the file's.
          return [normalizeResident(base.id, { ...base, ...JSON.parse(raw), _source: 'self' })]
        }
      } catch (err) {
        console.warn('Local profile parse failed:', err)
      }
      return [base]
    }

    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          return parsed.map(r => normalizeResident(r.id || cryptoId(), { ...r, _source: 'local' }))
        }
      }
    } catch (err) {
      console.warn('Local resident parse failed:', err)
    }

    const seeded = defaultResidents()
    localStorage.setItem(STORE_KEY, JSON.stringify(seeded))
    return seeded
  }

  // Reached whenever there is no Firestore to write to — no Firebase config, or
  // a firebase-firestore.js import that did not land. This used to return here
  // for a resident and write nothing, while saveProfile() went on saying
  // "Profile saved locally ✓": a senior filled in their name, their family and
  // their medical notes, added memories, and got the account default back on
  // the next page load. Every visit, with the toast confirming it each time.
  function persistLocalResidents() {
    if (isResident()) {
      const self = residents[0]
      if (!self?.id) return
      try {
        localStorage.setItem(SELF_PROFILE_KEY + self.id, JSON.stringify(self))
      } catch (err) {
        console.warn('Local profile save failed:', err)
      }
      return
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(residents))
  }

  function avatarHTML(r) {
    const seed = r?.avatarSeed || r?.name || r?.id || 'resident'
    return `<img src="${diceUrl(seed, r?.avatarStyle || 'lorelei-neutral')}" alt="${esc(r?.name || 'Resident')}">`
  }

  function showToast(message) {
    const div = document.createElement('div')
    div.className = 'toast'
    div.textContent = message
    document.body.appendChild(div)
    setTimeout(() => div.remove(), 2600)
  }

  // A button that goes with its card (Delete, Keep, Block) takes the focus
  // with it, out to the page behind the screen. The screen's heading takes it
  // instead.
  function keepFocusIn(headingId) {
    const el = document.activeElement
    if (!el || el === document.body || el.isConnected === false) $(headingId)?.focus?.()
  }

  function openModal(id) {
    $(id)?.classList.add('open')
  }

  function closeModal(id) {
    $(id)?.classList.remove('open')
  }

  function getSelected() {
    return residents.find(r => r.id === selectedId) || residents[0] || null
  }

  // Point the whole senior-facing surface — check-in wording, speech
  // recognition, the synthesised voice — at the selected person's language.
  // Called whenever the selection or the profile changes, rather than read on
  // every string lookup, so a check-in cannot change language mid-sentence
  // because a profile was edited in another tab.
  function syncLanguage() {
    const code = window.TechableI18n?.set(getSelected()?.language || 'en')
    document.documentElement.lang =
      { cmn: 'zh-CN', yue: 'zh-HK' }[code] || 'en'
    window.TechableCheckIn?.refresh?.()
    applyChrome()
    return code
  }

  // Everything marked data-i18n in app.html, plus the few controls whose words
  // change with their state and are therefore written from here.
  function applyChrome() {
    document.querySelectorAll('[data-i18n]').forEach(node => {
      const text = window.TechableI18n?.t?.(node.getAttribute('data-i18n'))
      if (text) node.textContent = text
    })
    const input = $('chat-input')
    if (input) input.placeholder = chrome('chat.placeholder')
    if (!recognizing) {
      const lbl = $('talk-lbl')
      if (lbl) lbl.textContent = chrome('talk.idle')
      $('talk-btn')?.setAttribute('aria-label', chrome('talk.idle'))
    }
    Voice.syncButton()
    syncFinishButton()
  }

  function selectedSessions() {
    const r = getSelected()
    return r ? getSessions(r.id) : []
  }

  function getAllSessions() {
    const all = []
    residents.forEach(r => {
      getSessions(r.id).forEach(s => all.push({ ...s, residentName: r.preferredName || r.name || 'Unnamed' }))
    })
    return all.sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0))
  }

  async function waitForAuth() {
    return new Promise(resolve => {
      function check() {
        if (!window.TechableAuth?.ready) {
          setTimeout(check, 50)
          return
        }

        window.TechableAuth.guardRole(['resident'], async user => {
          authUser = user || null
          db = window.TechableAuth?.db || null
          try {
            role = normalizeRole(await window.TechableAuth?.getRole?.())
            userDoc = await window.TechableAuth?.getUserDoc?.()
          } catch (err) {
            console.warn('Role/user doc lookup failed:', err)
            role = 'resident'
            userDoc = null
          }
          resolve(authUser)
        })
      }

      check()
    })
  }

  async function initFirestore() {
    if (!db || !authUser) return false

    try {
      fs = await import('https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js')
      firestoreReady = true
      usingFirestore = true
      return true
    } catch (err) {
      console.warn('Firestore import failed:', err)
      firestoreReady = false
      usingFirestore = false
      return false
    }
  }

  async function loadCommunities() {
    communities = []

    if (!usingFirestore) return

    try {
      const snap = await fs.getDocs(fs.query(
        fs.collection(db, 'communities'),
        fs.where('isPublic', '==', true)
      ))

      snap.forEach(docSnap => {
        communities.push(normalizeCommunity(docSnap.id, docSnap.data()))
      })

      communities.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    } catch (err) {
      console.warn('Community load failed:', err)
    }
  }

  async function createSelfResidentInFirestore() {
    if (!firestoreReady || !authUser) return defaultSelfResident()

    const temp = defaultSelfResident()
    const payload = {
      ...residentToFirestorePayload(temp),
      ownerUid: authUser.uid,
      centreId: '',
      createdBy: authUser.uid,
      createdAt: fs.serverTimestamp(),
      updatedAt: fs.serverTimestamp()
    }

    try {
      const ref = await fs.addDoc(fs.collection(db, 'residents'), payload)
      return normalizeResident(ref.id, { ...payload, ...temp, id: ref.id })
    } catch (err) {
      console.warn('Could not create self resident workspace:', err)
      return temp
    }
  }

  async function loadResidentSelfFromFirestore() {
    if (!firestoreReady || !authUser) return [defaultSelfResident()]

    const found = new Map()
    const col = fs.collection(db, 'residents')
    const queries = [
      fs.query(col, fs.where('ownerUid', '==', authUser.uid)),
      fs.query(col, fs.where('createdBy', '==', authUser.uid))
    ]

    // Whether a query FAILED is different from whether it found nothing, and
    // conflating the two is how a senior lost their profile. Both queries
    // throwing — a dropped connection, a rules change, a missing index — left
    // `found` empty, which read as "this person has no record yet", and the
    // code below wrote them a fresh blank one. Their real profile was still
    // there; they just could not see it, an orphan was added to the collection,
    // and it happened again on the next hiccup.
    let queryFailed = false

    for (const q of queries) {
      try {
        const snap = await fs.getDocs(q)
        snap.forEach(docSnap => {
          if (!found.has(docSnap.id)) found.set(docSnap.id, normalizeResident(docSnap.id, docSnap.data()))
        })
      } catch (err) {
        queryFailed = true
        console.warn('Self resident query failed:', err)
      }
    }

    const list = Array.from(found.values()).filter(r => {
      return r.ownerUid === authUser.uid || r.createdBy === authUser.uid
    })

    if (list.length) {
      // Oldest first, so the answer does not depend on the order Firestore
      // happened to return rows in. Where duplicates already exist — this bug
      // has been creating them — the oldest is the one with their history on
      // it, and picking it consistently means the same profile every visit
      // rather than a different one each time.
      list.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      return [list[0]]
    }

    // Nothing found AND something went wrong: do not write a record on the
    // strength of an answer we never got. Degrade to a local view for this
    // load; the next successful one picks up the real profile.
    if (queryFailed) {
      selfLoadFailed = true
      showToast('Could not load your profile — please reload the page')
      return [defaultSelfResident()]
    }

    selfLoadFailed = false

    return [await createSelfResidentInFirestore()]
  }

  async function loadManagerResidentsFromFirestore() {
    if (!firestoreReady || !authUser) return []

    const map = new Map()
    const col = fs.collection(db, 'residents')
    const queries = [
      fs.query(col, fs.where('centreId', '==', authUser.uid)),
      fs.query(col, fs.where('createdBy', '==', authUser.uid)),
      fs.query(col, fs.where('ownerUid', '==', authUser.uid))
    ]

    for (const q of queries) {
      try {
        const snap = await fs.getDocs(q)
        snap.forEach(docSnap => {
          if (!map.has(docSnap.id)) map.set(docSnap.id, normalizeResident(docSnap.id, docSnap.data()))
        })
      } catch (err) {
        console.warn('Resident query failed:', err)
      }
    }

    return Array.from(map.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }

  function normalizedLinkIdentifier(value) {
    return String(value || '').trim().toLowerCase().replace(/^@/, '')
  }

  async function seniorDirectoryHash(kind, value) {
    const bytes = new TextEncoder().encode(`${kind}:${value}`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  // Publish only hashed lookup keys, and only while the senior has "Let my
  // family find me" on (audits/F32, finding 3). The directory used to list
  // every senior, whether they wanted to be found or not — under their email,
  // and under the part of it before the @ as a "username", which anyone could
  // guess. Now: their email (and a username they chose) while it is on, and
  // nothing while it is off; the old automatic username is cleared either
  // way. No browser reads the directory (api/find-senior.js does).
  //
  // A senior from before the setting is decided once, on their record:
  // findable if family is already connected, hidden otherwise (the user's
  // decision) — and only from a list that loaded, so a failed read never
  // hides anyone.
  async function ensureSeniorLinkDirectory(resident) {
    if (!usingFirestore || !isResident() || !authUser || !resident?.id || selfLoadFailed) return
    const ownsResident = resident.ownerUid === authUser.uid || resident.createdBy === authUser.uid
    if (!ownsResident) return

    if (typeof resident.findable !== 'boolean') {
      if (!links.loaded || links.failed) return
      const on = linkedAccounts().length > 0
      try {
        await fs.setDoc(fs.doc(db, 'residents', resident.id), { findable: on, updatedAt: fs.serverTimestamp() }, { merge: true })
        resident.findable = on
      } catch (err) {
        console.warn('[senior-directory] could not record whether they can be found:', err?.code || err?.message)
        return
      }
    }

    const email = normalizedLinkIdentifier(authUser.email || userDoc?.email)
    const username = normalizedLinkIdentifier(userDoc?.username || userDoc?.usernameLower || '')
    const derived = email.includes('@') ? email.split('@')[0] : ''
    const entries = [email && ['email', email], username && ['username', username]].filter(Boolean)
    const publish = resident.findable ? entries : []
    const clear = (resident.findable ? [] : entries)
      .concat(derived && !publish.some(([kind, value]) => kind === 'username' && value === derived) ? [['username', derived]] : [])
      .filter(([kind, value], i, all) => all.findIndex(([k, v]) => k === kind && v === value) === i)

    for (const [kind, value] of publish) {
      try {
        const key = await seniorDirectoryHash(kind, value)
        await fs.setDoc(fs.doc(db, 'senior_link_directory', key, 'matches', authUser.uid), {
          seniorUid: authUser.uid,
          residentId: resident.id,
          managerUid: resident.centreId || '',
          kind,
          updatedAt: fs.serverTimestamp()
        }, { merge: true })
      } catch (err) {
        console.warn('[senior-directory] could not publish ' + kind + ' lookup:', err?.code || err?.message)
      }
    }
    for (const [kind, value] of clear) {
      try {
        const key = await seniorDirectoryHash(kind, value)
        await fs.deleteDoc(fs.doc(db, 'senior_link_directory', key, 'matches', authUser.uid))
      } catch (err) {
        console.warn('[senior-directory] could not clear ' + kind + ' lookup:', err?.code || err?.message)
      }
    }
  }

  async function reloadResidents() {
    await loadCommunities()

    if (usingFirestore) {
      residents = isResident() ? await loadResidentSelfFromFirestore() : await loadManagerResidentsFromFirestore()
    } else {
      residents = loadLocalResidents()
    }

    // Before the chat opens, so the greeting can say what the family sent and
    // the centre card where a request to join stands.
    await loadInbox()
    await loadLinks()
    // After the links: a senior from before "Let my family find me" is
    // decided by whether family is already connected.
    if (isResident() && residents[0]) await ensureSeniorLinkDirectory(residents[0])
    await loadCentreRequests()

    if (isResident()) {
      selectedId = residents[0]?.id || null
    } else {
      selectedId = localStorage.getItem(SELECTED_KEY)
      if (!residents.some(r => r.id === selectedId)) selectedId = residents[0]?.id || null
      if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
    }

    syncLanguage()
    applyRoleLayout()
    renderList()
    renderProfile()
    renderMems()
    renderChips()
    renderChat(true)
    updateSessionStats()
    renderDashboard()
    syncCentreLink()
    renderForms()
    await recordAutomaticAttendance()

    // A senior opens this app to talk to someone, so the conversation is the
    // landing screen for them — not a dashboard of statistics written for
    // their centre manager. Everyone else keeps the workspace they had. On a
    // senior's first visit the welcome opens over it (startVisit).
    startVisit()
  }

  // Manager preferences used to live only in profile.html's localStorage,
  // which is a different browser and often a different device from the senior.
  // Read the manager's narrow companion-settings document attached to this
  // resident and apply the centre-wide defaults before the opening line or
  // first AI request. This never needs access to the manager's account profile.
  async function applyCompanionPreferences() {
    if (!usingFirestore || !isResident()) return
    const resident = getSelected()
    if (!resident?.centreId) return
    try {
      const manager = await fs.getDoc(fs.doc(db, 'companion_settings', resident.centreId))
      if (!manager.exists()) return
      const prefs = manager.data()
      if (!prefs || typeof prefs !== 'object') return
      const cfg = window.TECHABLE_CONFIG || (window.TECHABLE_CONFIG = {})
      if (!deploymentAiModeCaptured) {
        deploymentAiModeCaptured = true
        deploymentAiMode = cfg.aiMode
      }
      if (prefs.aiEnabled === false) cfg.aiMode = 'local'
      else if (prefs.aiEnabled === true) {
        if (deploymentAiMode === undefined) delete cfg.aiMode
        else cfg.aiMode = deploymentAiMode
      }
      if (typeof prefs.voiceEnabled === 'boolean') {
        localStorage.setItem('techable_voice_pref', prefs.voiceEnabled ? 'on' : 'off')
      }
    } catch (err) {
      console.warn('[preferences] could not load manager companion settings:', err?.code || err?.message)
    }
  }

  function setBadge() {
    const badge = $('ai-badge')
    if (!badge) return

    const cfg = window.TECHABLE_CONFIG
    // AI is available when the server proxy has a key (aiEnabled).
    const hasAI = Boolean(cfg?.aiEnabled && cfg.aiMode !== 'local')
    const dataMode = usingFirestore ? 'DB' : 'Local'
    const roleLabel = isManager() ? 'Manager' : 'Resident'

    // The badge used to read the AI's name purely because a key was configured, even
    // while every single reply was coming from the offline fallback. If a real
    // call has failed, say so — and put the reason in the tooltip.
    if (lastAIError) {
      badge.textContent = `● AI offline + ${dataMode} · ${roleLabel}`
      badge.title = 'Falling back to offline replies: ' + lastAIError
      badge.style.background = '#FDECEA'
      badge.style.color = 'var(--rust)'
      return
    }

    badge.title = ''
    badge.style.background = ''
    badge.style.color = ''
    badge.textContent = hasAI ? `● OpenAI + ${dataMode} · ${roleLabel}` : `● Local AI + ${dataMode} · ${roleLabel}`
  }

  function applyRoleLayout() {
    document.body.classList.toggle('resident-mode', isResident())
    document.body.classList.toggle('manager-mode', isManager())

    // The brand returns every role to the homepage without changing sign-in.
    const hdrLogo = document.querySelector('.hdr-logo')
    if (hdrLogo) {
      hdrLogo.setAttribute('href', 'index.html')
      hdrLogo.setAttribute('aria-label', 'Techable home')
      hdrLogo.onclick = () => pauseChatAudio()
    }

    const sidebarLabel = $('sidebar-mode-label')
    if (sidebarLabel) sidebarLabel.textContent = isManager() ? 'Manager Navigation' : 'Resident Navigation'

    const managerTools = $('manager-tools')
    if (managerTools) managerTools.classList.toggle('hidden', isResident())

    const mobManagerTools = $('mob-manager-tools')
    if (mobManagerTools) mobManagerTools.classList.toggle('hidden', isResident())

    const navProfile = $('nav-profile')
    if (navProfile) navProfile.style.display = ''

    const emptyTitle = $('empty-title')
    const emptyCopy = $('empty-copy')
    if (emptyTitle) emptyTitle.textContent = isManager() ? 'No elderly profile selected' : 'Your profile is loading'
    if (emptyCopy) emptyCopy.textContent = isManager()
      ? 'Choose an elderly profile from the sidebar or add a new one.'
      : 'Your private Techable workspace will appear here.'

    const addButtons = document.querySelectorAll('.add-res')
    addButtons.forEach(btn => {
      btn.style.display = isManager() ? '' : 'none'
    })

    const residentManagementFields = ['p-status', 'p-community', 'p-community-name', 'p-notes']
    residentManagementFields.forEach(id => {
      const el = $(id)
      if (!el) return
      el.disabled = isResident() && id !== 'p-community-name'
    })
  }

  function renderCommunityOptions(selectedId = '', manualName = '') {
    const opts = [
      `<option value="">No community selected</option>`,
      ...communities.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`),
      `<option value="manual">Manual / not listed</option>`
    ].join('')

    const p = $('p-community')
    const n = $('new-community')

    if (p) {
      p.innerHTML = opts
      p.value = selectedId || (manualName ? 'manual' : '')
    }

    if (n) n.innerHTML = opts
  }

  function onCommunitySelect() {
    const selected = $('p-community')?.value || ''
    const input = $('p-community-name')
    if (!input) return

    if (!selected) {
      input.value = ''
      return
    }

    if (selected === 'manual') {
      input.focus()
      return
    }

    const c = communities.find(x => x.id === selected)
    input.value = c?.name || ''
  }

  function renderList() {
    const lists = [$('res-list'), $('mob-res-list')].filter(Boolean)
    if (!lists.length) return

    if (isResident()) {
      lists.forEach(list => { list.innerHTML = '' })
      return
    }

    const html = residents.length
      ? residents.map(r => {
        const meta = [r.age ? `${r.age} yrs` : '', r.room || '', r.communityName || ''].filter(Boolean).join(' · ')
        return `
          <div class="res-card ${r.id === selectedId ? 'active' : ''}" data-rid="${esc(r.id)}">
            <div class="res-av">${avatarHTML(r)}</div>
            <div class="res-info">
              <div class="res-name">${esc(r.preferredName || r.name || 'Unnamed')}</div>
              <div class="res-meta">${esc(meta || 'No details')}</div>
            </div>
            <div class="res-dot"></div>
          </div>`
      }).join('')
      : '<div class="mem-empty" style="margin:10px">No elderly profiles yet.</div>'

    lists.forEach(list => {
      list.innerHTML = html
      list.querySelectorAll('.res-card').forEach(card => {
        card.addEventListener('click', () => selectRes(card.dataset.rid))
      })
    })
  }

  function filterRes(term) {
    if (isResident()) return
    const q = String(term || '').toLowerCase().trim()

    document.querySelectorAll('#res-list .res-card, #mob-res-list .res-card').forEach(card => {
      const r = residents.find(x => x.id === card.dataset.rid)
      const hay = [r?.name, r?.preferredName, r?.room, r?.communityName, r?.background].join(' ').toLowerCase()
      card.style.display = !q || hay.includes(q) ? '' : 'none'
    })
  }

  // ── The senior's community centre ─────────────────────────────
  // The public directory no longer appears on the homepage. After signing in,
  // a senior sees their centre here. It used to say "Ask your center manager
  // to connect your account" — and there was no way for a manager to do that
  // (audits/P3-senior-feedback.md, item 1). Now the senior asks: the card says
  // where that stands and offers the next step. Connected means the record
  // carries the centre's manager (centreId), which only the manager's approval
  // can set.
  let centreAction = null

  function syncCentreLink() {
    const card = $('centre-card')
    const name = $('centre-card-name')
    const details = $('centre-card-details')
    if (!card || !name || !details) return

    const resident = getSelected()
    const req = latestCentreRequest()
    const show = (title, text, action, empty) => {
      name.textContent = title
      details.textContent = text
      card.classList.toggle('centre-card-empty', empty)
      centreAction = action
      const btn = $('centre-card-action')
      if (btn) {
        btn.hidden = !action
        btn.textContent = action ? chrome(action) : ''
      }
    }

    if (resident?.centreId || req?.status === 'approved') {
      const centre = communities.find(c => c.id === (resident?.communityId || req?.communityId))
      const location = [centre?.city, centre?.country].filter(Boolean).join(', ')
      const upcoming = String(centre?.upcomingActivities || '').trim()
      return show(centre?.name || resident?.communityName || req?.communityName || chrome('centre.label'),
        upcoming ? chrome('centre.upcoming', { what: upcoming }) : (location || chrome('centre.connected')), null, false)
    }
    if (req?.status === 'pending') return show(req.communityName, chrome('centre.pending.details'), 'centre.cancel', true)
    if (req?.status === 'declined') {
      return show(chrome('centre.declined', { centre: req.communityName }), chrome('centre.declined.details'), 'centre.choose', true)
    }
    // A centre typed on the profile, but never joined.
    if (resident?.communityName) return show(resident.communityName, chrome('centre.notLinked.details'), 'centre.ask', true)
    return show(chrome('centre.none'), chrome('centre.none.details'), 'centre.choose', true)
  }

  async function centreCardAction() {
    if (centreAction === 'centre.cancel') return cancelCentreRequest(latestCentreRequest())
    pauseChatAudio()
    window.location.href = 'senior-centers.html'
  }

  function selectRes(id) {
    if (!id) return
    if (isResident() && id !== residents[0]?.id) return

    // Saved under the person it was with, before the selection moves.
    if (id !== selectedId && hasUnsavedTalk()) persistSession(null, { quiet: true })

    selectedId = id
    if (isManager()) localStorage.setItem(SELECTED_KEY, selectedId)

    currentMessages = []
    savedCount = 0
    savedAt = null
    conversationEnded = false
    conversationSeq++
    storyMode = null
    storyEditing = storyWriting = null
    sessionStartedAt = new Date()

    syncLanguage()
    renderList()
    renderProfile()
    renderMems()
    renderChips()
    renderChat(true)
    updateSessionStats()
    renderDashboard()
    syncCentreLink()
    closeDrawer()

    // Switching residents while the chat is open changes who is at the other
    // end, so the new person gets greeted by their own name rather than
    // inheriting an empty window.
    if (activeTab === 'conversation') maybeGreet()
  }

  // Shown to managers who have not created any elderly profile yet. Each panel
  // stays reachable and says what is missing, instead of the app going blank.
  const NO_RESIDENT_NOTICE = `
    <div class="mem-empty" style="text-align:center;padding:28px 16px;line-height:1.7">
      <div style="font-size:30px;margin-bottom:8px">👴👵</div>
      <strong>No elderly profile yet</strong><br />
      The AI companion talks <em>with</em> an elderly person, so it needs a profile first.
      <div style="margin-top:14px">
        <button class="btn btn-p btn-sm" onclick="openAddModal()">➕ Add elderly profile</button>
      </div>
    </div>`

  function renderNoResidentNotices() {
    if ($('rh-name')) $('rh-name').textContent = 'No elderly profile selected'
    if ($('rh-sub')) $('rh-sub').textContent = 'Add a profile to unlock chat, memories and check-ins'
    if ($('rh-av')) $('rh-av').innerHTML = '<span style="font-size:22px">👴</span>'

    const chat = $('chat-win')
    if (chat) chat.innerHTML = NO_RESIDENT_NOTICE

    const mems = $('mem-list')
    if (mems) mems.innerHTML = NO_RESIDENT_NOTICE

    const hist = $('hist-wrap')
    if (hist) hist.innerHTML = NO_RESIDENT_NOTICE
  }

  function clearNoResidentNotices() {
    // renderChat/renderMems/renderHistory repaint these panels themselves once
    // a resident exists; nothing to undo beyond letting them run.
  }

  function renderProfile() {
    const r = getSelected()
    const empty = $('empty-scr')
    const view = $('res-view')

    if (!r) {
      // FIX: a community manager with no elderly profiles yet used to lose the
      // whole res-view — tab bar included — the moment they opened any tab
      // other than Dashboard. The AI companion looked missing from their
      // account because there was no way to see or get back to the Chat tab.
      // Managers now always keep the shell; each panel explains what to do.
      if (isManager()) {
        if (empty) empty.style.display = 'none'
        if (view) view.style.display = 'flex'
        renderNoResidentNotices()
        if (activeTab === 'dashboard') renderDashboard()
        return
      }

      if (empty) empty.style.display = 'flex'
      if (view) view.style.display = 'none'
      return
    }

    clearNoResidentNotices()

    if (empty) empty.style.display = 'none'
    if (view) view.style.display = 'flex'

    if ($('rh-av')) $('rh-av').innerHTML = avatarHTML(r)
    if ($('rh-name')) $('rh-name').textContent = r.preferredName || r.name || 'Unnamed Resident'
    if ($('rh-sub')) $('rh-sub').textContent = [r.name, r.age ? `${r.age} years old` : '', r.room, r.communityName].filter(Boolean).join(' · ')

    const pill = document.querySelector('.rh-pill')
    if (pill) pill.textContent = r.status === 'archived' ? 'Archived' : r.status === 'inactive' ? 'Inactive' : 'Active'

    renderCommunityOptions(r.communityId, r.communityName)

    if ($('p-name')) $('p-name').value = r.name || ''
    if ($('p-preferred')) $('p-preferred').value = r.preferredName || ''
    if ($('p-age')) $('p-age').value = r.age ?? ''
    if ($('p-room')) $('p-room').value = r.room || ''
    if ($('p-status')) $('p-status').value = r.status || 'active'
    if ($('p-community-name')) $('p-community-name').value = r.communityName || ''
    if ($('p-background')) $('p-background').value = r.background || ''
    if ($('p-family')) $('p-family').value = r.family || ''
    if ($('p-medical')) $('p-medical').value = r.medical || ''
    if ($('p-notes')) $('p-notes').value = r.notes || ''
    if ($('p-language')) $('p-language').value = r.language || 'en'
    renderForms()

    dirtyState = false
  }

  // The language control applies immediately rather than waiting for Save, so
  // the dashboard card and the next check-in switch over while the person
  // choosing can still see the effect. Save persists it.
  function setResidentLanguage(value) {
    const r = getSelected()
    if (!r) return
    r.language = window.TechableI18n?.normalise(value) || 'en'
    syncLanguage()
    dirty()
    showToast(`Check-in language: ${window.TechableI18n?.label(r.language) || 'English'}`)
  }

  function previewAvatarSeed() {
    const r = getSelected()
    if (!r) return

    if ($('rh-av')) $('rh-av').innerHTML = avatarHTML(r)

    document.querySelectorAll(`[data-rid="${CSS.escape(r.id)}"] .res-av`).forEach(el => {
      el.innerHTML = avatarHTML(r)
    })
  }

  function randomizeAvatar() {
    if (!isManager()) return showToast('Avatar changes are managed by your community manager')

    const r = getSelected()
    if (!r) return

    r.avatarSeed = randomAvatarSeed('resident')
    r.avatarStyle = randomAvatarStyle()

    previewAvatarSeed()
    dirty()
    showToast('Avatar updated — save changes to keep it ✓')
  }

  function residentToFirestorePayload(r) {
    return {
      name: r.name || '',
      preferredName: r.preferredName || '',
      age: Number.isFinite(Number(r.age)) ? Number(r.age) : null,
      room: r.room || '',
      status: r.status || 'active',
      communityId: r.communityId || '',
      communityName: r.communityName || '',
      background: r.background || '',
      family: r.family || '',
      medical: r.medical || '',
      notes: r.notes || '',
      language: r.language || 'en',
      avatarSeed: r.avatarSeed || r.name || r.id,
      avatarStyle: safeAvatarStyle(r.avatarStyle || 'lorelei-neutral'),
      memories: r.memories || [],
      wellnessForm: r.wellnessForm || null,
      benefitDraft: r.benefitDraft || null,
      myDetails: r.myDetails || null,
      ownerUid: r.ownerUid || '',
      centreId: r.centreId || '',
      createdBy: r.createdBy || ''
    }
  }

  function profilePayload(existing) {
    const communityId = $('p-community')?.value === 'manual' ? '' : ($('p-community')?.value || '')
    const community = communities.find(c => c.id === communityId)
    const communityName = $('p-community-name')?.value.trim() || community?.name || ''

    return {
      name: $('p-name')?.value.trim() || existing?.name || '',
      preferredName: $('p-preferred')?.value.trim() || '',
      age: $('p-age')?.value ? Number($('p-age').value) : null,
      room: $('p-room')?.value.trim() || '',
      status: isResident() ? (existing?.status || 'active') : ($('p-status')?.value || 'active'),
      communityId: isResident() ? (existing?.communityId || communityId) : communityId,
      communityName: isResident() ? (communityName || existing?.communityName || '') : communityName,
      background: $('p-background')?.value.trim() || '',
      family: $('p-family')?.value.trim() || '',
      medical: $('p-medical')?.value.trim() || '',
      notes: isResident() ? (existing?.notes || '') : ($('p-notes')?.value.trim() || ''),
      language: window.TechableI18n?.normalise($('p-language')?.value || existing?.language) || 'en',
      avatarSeed: existing?.avatarSeed || existing?.name || existing?.id,
      avatarStyle: existing?.avatarStyle || 'lorelei-neutral',
      memories: existing?.memories || [],
      wellnessForm: existing?.wellnessForm || null,
      benefitDraft: existing?.benefitDraft || null,
      ownerUid: existing?.ownerUid || (isResident() ? authUser?.uid || '' : ''),
      centreId: existing?.centreId || (isManager() ? authUser?.uid || '' : ''),
      createdBy: existing?.createdBy || authUser?.uid || '',
      updatedAt: firestoreReady ? fs.serverTimestamp() : nowIso()
    }
  }

  async function saveResidentToFirestore(id, data, isNew) {
    if (!firestoreReady || !authUser) throw new Error('Firestore not ready')

    if (isNew) {
      const ref = await fs.addDoc(fs.collection(db, 'residents'), {
        ...data,
        createdAt: fs.serverTimestamp()
      })
      return ref.id
    }

    await fs.setDoc(fs.doc(db, 'residents', id), data, { merge: true })
    return id
  }

  async function saveProfile() {
    const r = getSelected()
    if (!r) return

    const name = $('p-name')?.value.trim()
    if (!name) {
      $('p-name')?.focus()
      showToast('Full name is required')
      return
    }

    // We are looking at a placeholder, not their record. Writing it back would
    // create a second profile beside the real one rather than update it.
    if (selfLoadFailed) {
      showToast('Your profile has not loaded yet — please reload before editing')
      return
    }

    // A centre may have approved this senior's request to join since the page
    // loaded. Saving the old, empty link back would be refused by the rules
    // (and would mean nothing anyway), so read it again first.
    if (usingFirestore && isResident()) await refreshResidentLink(r)

    const data = profilePayload(r)

    try {
      if (usingFirestore) await saveResidentToFirestore(r.id, data, false)

      Object.assign(r, {
        ...data,
        avatarSeed: r.avatarSeed || data.avatarSeed,
        avatarStyle: r.avatarStyle || data.avatarStyle || 'lorelei-neutral',
        updatedAt: nowIso()
      })

      if (!usingFirestore) persistLocalResidents()

      dirtyState = false
      syncLanguage()
      renderList()
      renderProfile()
      renderMems()
      renderChips()
      renderDashboard()
      showToast(usingFirestore ? 'Profile synced to DB ✓' : 'Profile saved locally ✓')
    } catch (err) {
      showToast('Save failed: ' + err.message)
    }
  }

  async function saveResidentPatch(patch, successMessage) {
    const r = getSelected()
    if (!r) return false
    if (selfLoadFailed) {
      showToast('Your profile has not loaded yet — please reload before saving')
      return false
    }

    try {
      if (usingFirestore) {
        await fs.setDoc(fs.doc(db, 'residents', r.id), {
          ...patch,
          updatedAt: fs.serverTimestamp()
        }, { merge: true })
      }
      Object.assign(r, patch, { updatedAt: nowIso() })
      if (!usingFirestore) persistLocalResidents()
      // Only the card that was saved is refilled; the others may hold typing
      // the senior has not saved yet.
      renderForms(Object.keys(patch))
      if (successMessage) showToast(successMessage)
      return true
    } catch (err) {
      showToast('Save failed: ' + (err?.message || err))
      return false
    }
  }

  function latestCheckIn() {
    const r = getSelected()
    if (!r) return null
    return getCheckIns(r.id).slice().sort((a, b) =>
      new Date(b.savedAt || b.recordedAt || 0) - new Date(a.savedAt || a.recordedAt || 0))[0] || null
  }

  // ── My details for forms ──────────────────────────────────────
  // Every benefit programme has its own forms, many repeated every six or
  // twelve months, and all of them ask for the same name, date of birth,
  // address and status. A senior types them once here; the forms below show
  // and save them, and "Copy my details" gives a block to paste into an
  // outside form. No ID numbers: the card says so, and there is no field for
  // them — a Medicare or Social Security number belongs on the official form
  // only, not in a companion app.
  const MY_DETAIL_FIELDS = {
    fullName: ['md-fullname', 120], dob: ['md-dob', 10], phone: ['md-phone', 40],
    email: ['md-email', 120], address: ['md-address', 300],
    emergencyName: ['md-emergency-name', 120], emergencyPhone: ['md-emergency-phone', 40],
    medicare: ['md-medicare', 10], medicaid: ['md-medicaid', 10], livesAlone: ['md-lives-alone', 10]
  }
  const MY_ANSWERS = { yes: 'Yes', no: 'No', unsure: 'Not sure' }

  function validDob(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false
    const d = new Date(ymd + 'T00:00:00')
    return !isNaN(d) && d <= new Date() && d.getFullYear() >= 1900
  }

  function cleanMyDetails(raw) {
    if (!raw || typeof raw !== 'object') return null
    const out = {}
    for (const [key, [, max]] of Object.entries(MY_DETAIL_FIELDS)) out[key] = String(raw[key] ?? '').trim().slice(0, max)
    if (!validDob(out.dob)) out.dob = ''
    for (const key of ['medicare', 'medicaid', 'livesAlone']) if (!MY_ANSWERS[out[key]]) out[key] = ''
    if (raw.savedAt) out.savedAt = String(raw.savedAt)
    return out
  }

  // The details the forms use: what was saved, with the profile name standing
  // in until a full name has been given.
  function myDetailsOf(r) {
    const d = r?.myDetails || {}
    return { ...d, fullName: d.fullName || r?.name || '' }
  }

  function formatDob(ymd) {
    if (!validDob(ymd || '')) return ''
    const [y, m, d] = ymd.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
  }

  function myDetailsLines(d) {
    return [
      d.fullName && `Full name: ${d.fullName}`,
      d.dob && `Date of birth: ${formatDob(d.dob)}`,
      d.phone && `Phone: ${d.phone}`,
      d.email && `Email: ${d.email}`,
      d.address && `Address: ${d.address.replace(/\s*\n+\s*/g, ', ')}`,
      (d.emergencyName || d.emergencyPhone) && `Emergency contact: ${[d.emergencyName, d.emergencyPhone].filter(Boolean).join(', ')}`,
      d.medicare && `Medicare: ${MY_ANSWERS[d.medicare]}`,
      d.medicaid && `Medicaid: ${MY_ANSWERS[d.medicaid]}`,
      d.livesAlone && `Lives alone: ${MY_ANSWERS[d.livesAlone]}`
    ].filter(Boolean)
  }

  // What a saved form keeps of the details it was prepared with, so an old
  // draft still says who it was for after the details change.
  function applicantSnapshot(r) {
    const d = myDetailsOf(r)
    const out = {}
    for (const key of Object.keys(MY_DETAIL_FIELDS)) out[key] = d[key] || ''
    return out
  }

  function applicantLine(r) {
    const d = myDetailsOf(r)
    if (!d.fullName) return 'Add your details once in “My details for forms” and they appear on every form.'
    return 'For: ' + [d.fullName, d.dob && 'born ' + formatDob(d.dob), d.phone].filter(Boolean).join(' · ')
  }

  async function saveMyDetails() {
    const raw = {}
    for (const [key, [id]] of Object.entries(MY_DETAIL_FIELDS)) raw[key] = $(id)?.value ?? ''
    const dob = String(raw.dob || '').trim()
    if (dob && !validDob(dob)) return showToast('Check the date of birth — it cannot be in the future')
    const d = cleanMyDetails(raw)
    d.savedAt = nowIso()
    await saveResidentPatch({ myDetails: d }, 'Your details are saved ✓ The forms now use them.')
  }

  async function copyMyDetails() {
    const lines = myDetailsLines(myDetailsOf(getSelected()))
    if (!lines.length) return showToast('Fill in your details first')
    try {
      await navigator.clipboard.writeText(lines.join('\n') + '\nCheck each detail before you use it.')
      showToast('Your details are copied ✓ Paste them into the form.')
    } catch (_) {
      showToast('Copy failed — select the details manually')
    }
  }

  // `only` names the record fields just saved (myDetails, wellnessForm,
  // benefitDraft); without it — a tab switch, another resident — every card
  // is filled from the record.
  function renderForms(only) {
    const r = getSelected()
    if (!r) return
    const w = r.wellnessForm || {}
    const b = r.benefitDraft || {}
    const set = (id, value) => { if ($(id)) $(id).value = value ?? '' }
    const refill = key => !only || only.includes(key)

    if ($('wf-applicant')) $('wf-applicant').textContent = applicantLine(r)
    if ($('bf-applicant')) $('bf-applicant').textContent = applicantLine(r)
    if (refill('myDetails')) {
      const md = myDetailsOf(r)
      for (const [key, [id]] of Object.entries(MY_DETAIL_FIELDS)) set(id, md[key])
      if ($('md-status')) $('md-status').textContent = r.myDetails?.savedAt ? `Saved ${new Date(r.myDetails.savedAt).toLocaleString()}` : 'Not saved yet.'
    }
    if (refill('wellnessForm')) {
      set('wf-mood', w.mood)
      set('wf-sleep', w.sleep)
      set('wf-appetite', w.appetite)
      set('wf-pain', w.pain)
      set('wf-mobility', w.mobility)
      set('wf-notes', w.notes)
      if ($('wf-confirm')) $('wf-confirm').checked = Boolean(w.reviewedWithSenior)
      if ($('wf-status')) $('wf-status').textContent = w.savedAt ? `Saved ${new Date(w.savedAt).toLocaleString()}` : 'No wellness form saved yet.'
    }

    if (refill('benefitDraft')) {
      set('bf-type', b.type)
      set('bf-program', b.program)
      set('bf-reference', b.reference)
      set('bf-status-select', b.status || 'draft')
      set('bf-notes', b.notes)
      if ($('bf-consent')) $('bf-consent').checked = Boolean(b.consent)
      if ($('bf-status')) $('bf-status').textContent = b.savedAt ? `Draft saved ${new Date(b.savedAt).toLocaleString()}` : 'No benefit application draft saved yet.'
    }

    const c = communities.find(x => x.id === r.communityId)
    const pageLocation = window.location || { origin:'', pathname:'app.html', search:'' }
    const link = r.communityId
      ? pageLocation.origin + pageLocation.pathname.replace(/app\.html$/, '') + 'app.html?centreCheckIn=' + encodeURIComponent(r.communityId)
      : ''
    if ($('attendance-link')) $('attendance-link').textContent = link || 'Assign a community center to this profile to create an attendance link.'
    if ($('attendance-status') && !pageLocation.search.includes('centreCheckIn=')) {
      $('attendance-status').textContent = c ? `Assigned to ${c.name}. Attendance is recorded only from its center link.` : ''
    }
  }

  function fillWellnessFromLatest() {
    const c = latestCheckIn()
    if (!c) return showToast('No completed check-in is available yet')
    const mood = String(c.moodLabel || c.mood || '')
    if ($('wf-mood')) {
      const match = ['Good', 'Okay', 'Tired', 'Low'].find(x => x.toLowerCase() === mood.toLowerCase())
      $('wf-mood').value = match || ''
    }
    const concerns = Array.isArray(c.concerns) ? c.concerns : []
    if ($('wf-sleep') && concerns.includes('sleep') && !$('wf-sleep').value) $('wf-sleep').value = 'Sleep concern reported during the latest check-in'
    if ($('wf-appetite') && concerns.includes('appetite') && !$('wf-appetite').value) $('wf-appetite').value = 'Appetite concern reported during the latest check-in'
    if ($('wf-pain') && concerns.includes('discomfort') && !$('wf-pain').value) $('wf-pain').value = 'Physical discomfort reported during the latest check-in'
    if ($('wf-notes')) $('wf-notes').value = c.summary || c.seniorWords || $('wf-notes').value
    showToast('Latest check-in added — review every field before saving')
  }

  async function saveWellnessForm() {
    if (!$('wf-confirm')?.checked) return showToast('Review the form with the senior before saving')
    const form = {
      mood: $('wf-mood')?.value || '',
      sleep: $('wf-sleep')?.value.trim() || '',
      appetite: $('wf-appetite')?.value.trim() || '',
      pain: $('wf-pain')?.value.trim() || '',
      mobility: $('wf-mobility')?.value.trim() || '',
      notes: $('wf-notes')?.value.trim() || '',
      applicant: { fullName: myDetailsOf(getSelected()).fullName, dob: myDetailsOf(getSelected()).dob || '' },
      reviewedWithSenior: true,
      savedAt: nowIso(),
      savedBy: authUser?.uid || 'local'
    }
    await saveResidentPatch({ wellnessForm: form }, 'Wellness form saved ✓')
  }

  function benefitDraftFromForm() {
    return {
      type: $('bf-type')?.value || '',
      program: $('bf-program')?.value.trim() || '',
      reference: $('bf-reference')?.value.trim() || '',
      status: $('bf-status-select')?.value || 'draft',
      notes: $('bf-notes')?.value.trim() || '',
      consent: Boolean($('bf-consent')?.checked)
    }
  }

  async function saveBenefitDraft() {
    const draft = benefitDraftFromForm()
    if (!draft.consent) return showToast('The senior’s consent is required before saving')
    if (!draft.type && !draft.program) return showToast('Choose a support type or name a program')
    await saveResidentPatch({ benefitDraft: {
      ...draft,
      applicant: applicantSnapshot(getSelected()),
      savedAt: nowIso(),
      savedBy: authUser?.uid || 'local'
    } }, 'Benefit application draft saved ✓')
  }

  async function copyBenefitSummary() {
    const r = getSelected()
    const d = benefitDraftFromForm()
    const who = myDetailsOf(r)
    const text = [
      `Applicant: ${who.fullName || 'Unnamed senior'}`,
      ...myDetailsLines(who).filter(line => !line.startsWith('Full name:')),
      `Support type: ${d.type || 'Not selected'}`,
      `Program or agency: ${d.program || 'Not recorded'}`,
      `Reference: ${d.reference || 'Not recorded'}`,
      `Status: ${d.status}`,
      `Information and next steps: ${d.notes || 'None recorded'}`,
      'Prepared in Techable. Review and submit through the relevant agency.'
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      showToast('Application summary copied ✓')
    } catch (_) {
      showToast('Copy failed — select the information manually')
    }
  }

  async function recordAutomaticAttendance() {
    const communityId = new URLSearchParams(window.location?.search || '').get('centreCheckIn') || ''
    if (!communityId || !usingFirestore || !authUser) return
    const r = getSelected()
    const community = communities.find(c => c.id === communityId)
    const belongs = isResident() && r && community
      && r.ownerUid === authUser.uid
      && r.communityId === communityId
      // Joined through the centre, not just named on the profile: the rules
      // refuse the row otherwise, so say so instead of failing to save it.
      && r.centreId === community.managerUid
    if (!belongs) {
      if ($('attendance-status')) $('attendance-status').textContent = 'Attendance was not recorded because this profile is not assigned to that center.'
      return
    }

    const today = new Date()
    const day = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-')
    const clean = s => String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
    const id = `${clean(communityId)}_${clean(r.id)}_${day}`
    const ref = fs.doc(db, 'attendance', id)
    try {
      const existing = await fs.getDoc(ref)
      if (!existing.exists()) {
        await fs.setDoc(ref, {
          communityId,
          communityName: community.name || r.communityName || '',
          managerUid: community.managerUid,
          residentId: r.id,
          residentName: r.preferredName || r.name || 'Unnamed senior',
          ownerUid: r.ownerUid || (isResident() ? authUser.uid : ''),
          day,
          method: 'centre_link',
          checkedInAt: fs.serverTimestamp()
        })
        showToast(`Checked in at ${community.name || 'your community center'} ✓`)
      }
      if ($('attendance-status')) $('attendance-status').textContent = `Attendance recorded for ${day} at ${community.name || 'your community center'}.`
    } catch (err) {
      console.warn('Attendance sign-in failed:', err)
      if ($('attendance-status')) $('attendance-status').textContent = 'Attendance could not be recorded. Please ask center staff for help.'
    }
  }

  async function createRes() {
    if (!isManager()) return showToast('Only community managers can add elderly profiles')

    const name = $('new-name')?.value.trim()
    const age = $('new-age')?.value ? Number($('new-age').value) : null
    const room = $('new-room')?.value.trim() || ''
    const communityId = $('new-community')?.value || ''
    const community = communities.find(c => c.id === communityId)

    if (!name) {
      $('new-name')?.focus()
      showToast('Elderly name is required')
      return
    }

    const temp = normalizeResident(cryptoId(), {
      name,
      age: Number.isFinite(age) ? age : null,
      room,
      status: 'active',
      communityId,
      communityName: community?.name || '',
      avatarSeed: randomAvatarSeed('resident'),
      avatarStyle: randomAvatarStyle(),
      memories: [],
      ownerUid: '',
      centreId: authUser?.uid || '',
      createdBy: authUser?.uid || ''
    })

    try {
      let id = temp.id

      if (usingFirestore) {
        id = await saveResidentToFirestore(null, {
          ...residentToFirestorePayload(temp),
          updatedAt: fs.serverTimestamp()
        }, true)
      }

      const resident = { ...temp, id }
      residents.push(resident)
      residents.sort((a, b) => (a.name || '').localeCompare(b.name || ''))

      if (!usingFirestore) persistLocalResidents()

      closeModal('add-modal')
      selectRes(id)
      switchTab('profile')
      showToast(usingFirestore ? 'Elderly profile created in DB ✓' : 'Elderly profile created locally ✓')
    } catch (err) {
      showToast('Create failed: ' + err.message)
    }
  }

  // An assignment would otherwise outlive the resident and keep its saved
  // sessions readable to the provider. Removed first, so a failure leaves the
  // resident in place to retry.
  async function deleteResidentRecord(id) {
    const assigned = await fs.getDocs(fs.query(fs.collection(db, 'provider_assignments'),
      fs.where('managerUid', '==', authUser.uid), fs.where('residentId', '==', id)))
    for (const d of assigned.docs) await fs.deleteDoc(d.ref)
    await fs.deleteDoc(fs.doc(db, 'residents', id))
  }

  // A senior who joined this centre with their own login owns their record —
  // their profile, memories, life story. The centre lets them go (the link
  // fields cleared) and never deletes it; the rules allow nothing else.
  // Records this centre created for someone with no login are deleted as before.
  const seniorOwned = r => Boolean(r?.ownerUid) && r.ownerUid !== authUser?.uid

  async function releaseResidentRecord(id) {
    const assigned = await fs.getDocs(fs.query(fs.collection(db, 'provider_assignments'),
      fs.where('managerUid', '==', authUser.uid), fs.where('residentId', '==', id)))
    for (const d of assigned.docs) await fs.deleteDoc(d.ref)
    await fs.setDoc(fs.doc(db, 'residents', id),
      { centreId: '', communityId: '', communityName: '', updatedAt: fs.serverTimestamp() }, { merge: true })
  }

  async function deleteResident() {
    if (!isManager()) return showToast('Only community managers can delete elderly profiles')

    const r = getSelected()
    if (!r) return

    const owned = seniorOwned(r)
    const label = r.preferredName || r.name || 'this elderly profile'
    if (!confirm(owned
      ? `Remove ${label} from your members? Their own account, memories and life story stay theirs.`
      : `Delete ${label}? This cannot be undone.`)) return

    try {
      if (usingFirestore) await (owned ? releaseResidentRecord(r.id) : deleteResidentRecord(r.id))

      localStorage.removeItem(SESSION_PREFIX + r.id)
      residents = residents.filter(x => x.id !== r.id)

      if (!usingFirestore) persistLocalResidents()

      selectedId = residents[0]?.id || null
      if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
      else localStorage.removeItem(SELECTED_KEY)

      currentMessages = []
      renderList()
      renderProfile()
      renderMems()
      renderChips()
      renderChat(true)
      renderDashboard()
      showToast(owned ? 'Removed from your members ✓' : 'Elderly profile deleted ✓')
    } catch (err) {
      showToast('Delete failed: ' + err.message)
    }
  }

  function renderMems() {
    const r = getSelected()
    const list = $('mem-list')
    const count = $('mem-count')

    if (!list || !r) return

    const memories = r.memories || []
    if (count) count.textContent = `(${memories.length})`

    if (!memories.length) {
      list.innerHTML = '<div class="mem-empty">No memories yet.</div>'
      return
    }

    list.innerHTML = memories.map(m => `
      <div class="mem-row">
        <div class="mem-txt">${esc(m.text)}</div>
        <div class="mem-badge">${esc(m.tag || 'memory')}</div>
        <button class="mem-del-btn" data-mid="${esc(m.id)}">×</button>
      </div>`).join('')

    list.querySelectorAll('.mem-del-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteMem(btn.dataset.mid))
    })
  }

  async function persistMemories(r) {
    if (usingFirestore) {
      await fs.setDoc(fs.doc(db, 'residents', r.id), {
        memories: r.memories || [],
        updatedAt: fs.serverTimestamp()
      }, { merge: true })
    } else {
      persistLocalResidents()
    }
  }

  async function addMem() {
    const r = getSelected()
    const text = $('mem-input')?.value.trim()
    if (!r || !text) return

    r.memories = r.memories || []
    const entry = {
      id: cryptoId(),
      text,
      tag: $('mem-tag')?.value || 'memory',
      createdAt: nowIso()
    }
    r.memories.push(entry)

    $('mem-input').value = ''

    try {
      await persistMemories(r)
      renderMems()
      renderChips()
      renderDashboard()
      showToast('Memory saved ✓')
    } catch (err) {
      // Put it back the way it was. Leaving the memory in the list while the
      // toast says the save failed shows it sitting there as though it had
      // worked — until the next reload takes it away without explanation. The
      // text goes back in the box so it is not lost along with the attempt.
      r.memories = r.memories.filter(m => m.id !== entry.id)
      if ($('mem-input')) $('mem-input').value = entry.text
      renderMems()
      showToast('Memory save failed: ' + err.message)
    }
  }

  // ── Learning from the conversation ────────────────────────────
  // Nothing the senior said was ever kept. Someone could tell the companion
  // "my name is Jessica and I have a son" and the Memory Bank stayed empty, so
  // the next session started from nothing and the AI had nothing personal to
  // draw on. These patterns capture only durable facts about the person —
  // never moods, complaints, or anything about how they feel today, which
  // belong to the check-in record and change from day to day.
  const LEARNERS = [
    { tag: 'family',
      re: /\bi\s+have\s+(?:a|an|two|three|four|\d+)?\s*(son|daughter|sons|daughters|grandson|granddaughter|grandchildren|grandkids|brother|sister|wife|husband)\b/i,
      make: m => `Has a ${m[1].toLowerCase()}` },
    { tag: 'family',
      re: /\bmy\s+(son|daughter|wife|husband|grandson|granddaughter|brother|sister|mother|father)(?:'s name)?\s+is\s+(?:called\s+)?([A-Z][a-z]{1,20})\b/,
      make: m => `${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()} is called ${m[2]}` },
    // "I like to go on walks near the river" was stored verbatim as "Enjoys go
    // on walks near the river", which then reached the senior as "Is it
    // because you spent some time on go on walks near the river?". The "to" is
    // dropped by the pattern, so the verb has to be put into its -ing form for
    // the sentence to survive.
    { tag: 'hobby',
      re: /\bi\s+(?:love|enjoy|like)\s+(?:to\s+)?([a-z][a-z\s]{2,40}?)(?:\.|,|$| and | but )/i,
      make: m => `Enjoys ${toGerund(m[1].trim())}` },
    // Who someone was: "I was a teacher", "I used to be a bus driver in Ipoh",
    // "I worked as a seamstress". Not when: "when I was a little girl my mother
    // and I…" was kept as the job "Used to be a little girl my mother", and
    // offered back as "When you were a little girl my mother". A voice
    // transcript has no full stops, so the job ends where the next clause
    // starts — a person, "my", "and" — and jobRole() has the last word.
    { tag: 'other',
      re: /\b(?:(when|while|since|as|if|because|until|till|before|after|once)\s+)?i\s+(?:used\s+to\s+be|used\s+to\s+work\s+as|worked\s+as|was)\s+(an?)\s+([a-z]+(?:\s+[a-z]+){0,4}?)(?=\s*(?:[.,!?;:]|$)|\s+(?:and|but|or|so|then|later|for|because|when|while|until|till|before|after|since|who|which|that|i|we|he|she|they|you|it|my|our|his|her|their|your)\b)/i,
      make: m => {
        if (m[1]) return null
        const role = jobRole(m[3])
        return role ? `Used to be ${m[2].toLowerCase()} ${role}` : null
      } },
    { tag: 'place',
      re: /\bi\s+(?:grew up|was born|lived)\s+in\s+([A-Z][A-Za-z\s]{2,28}?)(?:\.|,|$| and )/,
      make: m => `Grew up in ${m[1].trim()}` }
  ]

  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

  // A job or a role, as said after "I was a…": never an age, an amount or a
  // while ("a little girl", "a bit tired", "an hour early"), and never running
  // on into the next clause. A little word left at the end ("a nurse at",
  // before "my local hospital") is dropped. null when it is not a role.
  const NOT_A_ROLE = new Set(['little', 'bit', 'lot', 'while', 'long', 'few', 'couple', 'hour', 'minute', 'moment',
    'day', 'week', 'month', 'year', 'child', 'kid', 'baby', 'boy', 'girl', 'teenager', 'teen', 'toddler',
    'youngster', 'young', 'small', 'mess', 'wreck', 'guest', 'patient', 'visitor', 'passenger'])
  const CLAUSE_START = new Set(['and', 'but', 'or', 'so', 'then', 'later', 'because', 'when', 'while', 'until',
    'till', 'before', 'after', 'since', 'who', 'which', 'that', 'i', 'we', 'he', 'she', 'they', 'you', 'it',
    'my', 'our', 'his', 'her', 'their', 'your'])
  const ROLE_TAIL = new Set(['a', 'an', 'the', 'of', 'at', 'in', 'on', 'to', 'from', 'near', 'by', 'with', 'as'])

  function jobRole(text) {
    const words = String(text || '').trim().split(/\s+/).filter(Boolean)
    while (words.length && ROLE_TAIL.has(words[words.length - 1].toLowerCase())) words.pop()
    if (!words.length || words.some(w => NOT_A_ROLE.has(w.toLowerCase()) || CLAUSE_START.has(w.toLowerCase()))) return null
    return words.join(' ')
  }

  // A job the old pattern kept from a time or a run-on sentence. Seniors on
  // the live site may still have some; they stay in the Memory Bank for the
  // senior or the centre to delete, and are never offered back.
  function garbledJob(text) {
    const m = String(text || '').trim().replace(/[.!]+$/, '').match(/^used to be an?\s+(.+)$/i)
    return Boolean(m) && !jobRole(m[1])
  }

  // "go on walks near the river" → "going on walks near the river". Lives in
  // i18n.js with the rest of the language handling; the fallback keeps capture
  // working if that file ever fails to load.
  const toGerund = s => window.TechableI18n?.toGerund?.(s) ?? s

  async function learnFrom(text) {
    const r = getSelected()
    if (!r || !text) return

    // A manager typing on a resident's behalf is speaking as that resident, so
    // the same capture applies either way.
    const found = []
    for (const l of LEARNERS) {
      // Every match, not only the first: in "when I was a little girl we
      // lived by the river, and later I was a dressmaker" the job is second.
      for (const m of text.matchAll(new RegExp(l.re.source, l.re.flags.replace('g', '') + 'g'))) {
        const made = l.make(m)
        if (made && made.length <= 90) { found.push({ text: made, tag: l.tag }); break }
      }
    }
    if (!found.length) return

    r.memories = r.memories || []
    const seen = new Set(r.memories.map(m => norm(m.text)))
    const fresh = found.filter(f => !seen.has(norm(f.text)))
    if (!fresh.length) return

    fresh.forEach(f => r.memories.push({ id: cryptoId(), text: f.text, tag: f.tag, createdAt: nowIso(), source: 'conversation' }))

    // If they introduced themselves and we had no preferred name, take it.
    // Case-insensitive on the phrase — the sentence usually starts with "My",
    // so a case-sensitive \bmy never matched — then normalise the name itself.
    // Only unambiguous introductions. "I am ..." is NOT included: "I am tired"
    // would have set the person's preferred name to "Tired".
    const called = text.match(/\b(?:my name is|my name's|you can call me|call me)\s+([a-z]{2,20})\b/i)
    if (called && !r.preferredName) {
      const n = called[1]
      r.preferredName = n[0].toUpperCase() + n.slice(1).toLowerCase()
    }

    try {
      await persistMemories(r)
      if (r.preferredName) await persistResidentName(r)
      renderMems()
      renderChips()
      showToast(`Remembered: ${fresh[0].text}`)
    } catch (err) {
      console.warn('Could not save learned memory:', err)
    }
  }

  async function persistResidentName(r) {
    if (usingFirestore) {
      await fs.setDoc(fs.doc(db, 'residents', r.id), {
        preferredName: r.preferredName || '',
        updatedAt: fs.serverTimestamp()
      }, { merge: true })
    } else {
      persistLocalResidents()
    }
  }

  async function deleteMem(id) {
    const r = getSelected()
    if (!r) return

    r.memories = (r.memories || []).filter(m => m.id !== id)

    try {
      await persistMemories(r)
      renderMems()
      renderChips()
      renderDashboard()
    } catch (err) {
      showToast('Delete memory failed: ' + err.message)
    }
  }

  function renderChips() {
    const r = getSelected()
    const chips = $('chips')
    if (!chips || !r) return

    const memories = (r.memories || []).slice(0, 8)

    chips.innerHTML = memories.length
      ? memories.map(m => `<button class="chip" data-text="${esc(m.text)}">${esc(m.text)}</button>`).join('')
      : '<span style="font-size:12px;color:var(--ink3)">No memories yet.</span>'

    chips.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const input = $('chat-input')
        if (!input) return
        input.value = chip.dataset.text || ''
        input.focus()
      })
    })
  }

  // ── The life story book ───────────────────────────────────────
  // A friend of the founder asked for somewhere the stories a senior tells are
  // kept — a memoir their family can read (audits/P3-senior-feedback.md, item
  // 5). Memories are one-line facts for the companion; these are the senior's
  // own words, in chapters, and they stay theirs: every story can be changed,
  // moved, removed and printed.
  //
  // Stories arrive three ways: told in story mode (from a chapter in My Story
  // or a chapter tile under the greeting), kept automatically when a long
  // reminiscence is said in an ordinary chat, or written by hand.
  async function persistLifeStory(r) {
    if (usingFirestore) {
      await fs.setDoc(fs.doc(db, 'residents', r.id), {
        lifeStory: r.lifeStory || [],
        updatedAt: fs.serverTimestamp()
      }, { merge: true })
    } else {
      persistLocalResidents()
    }
  }

  // Every change goes through here: made, saved, and taken back if the save
  // fails, so a story is never on the page looking kept when it is not.
  async function commitStory(change, toastKey, opts = {}) {
    const r = getSelected()
    if (!r) return false
    if (selfLoadFailed) {
      showToast(chrome('story.toast.failed'))
      return false
    }
    const before = (r.lifeStory || []).map(e => ({ ...e }))
    const after = normalizeLifeStory(change(before.map(e => ({ ...e }))))
    // The book shares one record with the profile and memories, and a record
    // has a 1 MiB limit: past it every write to the senior fails, the profile
    // included. 300 stories of 4000 characters would be well over (CJK text is
    // 3 bytes a character), so the book stops growing at a size, not a count.
    if (storyBytes(after) > STORY_BYTES_MAX && storyBytes(after) > storyBytes(before)) {
      showToast(chrome('story.toast.full'))
      return false
    }
    r.lifeStory = after
    try {
      await persistLifeStory(r)
      if (activeTab === 'story') renderStory()
      if (toastKey) showToast(chrome(toastKey, opts.vars))
      return true
    } catch (err) {
      console.warn('[story] could not save the life story:', err?.code || err?.message)
      r.lifeStory = before
      if (activeTab === 'story') renderStory()
      if (!opts.quietFail) showToast(chrome('story.toast.failed'))
      return false
    }
  }

  async function addStoryEntry(chapter, text, extra = {}) {
    const r = getSelected()
    const entry = normalizeStoryEntry({
      id: extra.id || cryptoId(), chapter, text, prompt: extra.prompt || '', createdAt: nowIso(), source: extra.source || 'manual'
    })
    if (!r || !entry) return null
    if ((r.lifeStory || []).length >= STORY_MAX) {
      if (!extra.quietFail) showToast(chrome('story.toast.full'))
      return null
    }
    const toast = extra.toast === undefined ? 'story.toast.saved' : extra.toast
    const ok = await commitStory(list => [...list, entry], toast, { vars: extra.vars, quietFail: extra.quietFail })
    return ok ? entry : null
  }

  // The senior's next answer in story mode, as the next paragraph.
  function appendToStory(id, text) {
    return commitStory(list => list.map(e => e.id === id
      ? { ...e, text: (e.text + '\n' + String(text).trim()).slice(0, STORY_TEXT_MAX) } : e), null)
  }

  async function editStoryEntry(id, text, chapter) {
    const clean = String(text ?? '').trim()
    if (!clean) return false
    return commitStory(list => list.map(e => e.id === id
      ? { ...e, text: clean, chapter: STORY_CHAPTERS.includes(chapter) ? chapter : e.chapter } : e), 'story.toast.updated')
  }

  // An explicitly reviewed blog entry uses the existing life-story storage and
  // sharing policy. It is not published on the public web.
  async function saveBlogEntry(draft) {
    const title = String(draft?.title || '').trim()
    const text = String(draft?.text || '').trim()
    if (!title || title.length > 120 || !text || text.length > STORY_TEXT_MAX) return null
    const r = getSelected()
    if (!r) return null
    const prompt = 'Blog: ' + title
    if (!draft.id) return addStoryEntry('other', text, { source: 'manual', prompt })
    const old = (r.lifeStory || []).find(e => e.id === draft.id && String(e.prompt || '').startsWith('Blog: '))
    if (!old) return null
    const updated = { ...old, text, prompt }
    const ok = await commitStory(list => list.map(e => e.id === old.id ? updated : e), 'story.toast.updated')
    return ok ? updated : null
  }

  async function removeStoryEntry(id) {
    if (!confirm(chrome('story.confirmRemove'))) return false
    const ok = await commitStory(list => list.filter(e => e.id !== id), 'story.toast.removed')
    keepFocusIn('story-title')
    return ok
  }

  // Which chapter a story belongs in, from the words in it. First match wins,
  // so the strongest signal goes first: "when I was a little girl…" is a
  // childhood story even when there is soup in it. Anything else is Other
  // stories, which the senior can move from My Story.
  const STORY_CUES = [
    ['childhood', /\b(when i was (?:a )?(?:little|small|young|child|kid|boy|girl)|as a (?:child|kid|little (?:boy|girl))|childhood|growing up|grew up)\b/i, /(小时候|小時候|細個|童年)/],
    ['school',    /\b(school|teacher|classmates?|exams?|university|college|headmaster|headmistress)\b/i, /(学校|學校|老师|老師|同学|同學|读书|讀書|考试|考試)/],
    ['love',      /\b(married|marry|wedding|husband|wife|fianc[eé]e?|boyfriend|girlfriend|courting|fell in love|sweetheart)\b/i, /(结婚|結婚|婚礼|婚禮|老公|老婆|丈夫|妻子|拍拖|谈恋爱|談戀愛)/],
    ['work',      /\b(work(?:ed|ing)?|job|office|factory|boss|career|retired|business|colleagues?)\b/i, /(工作|上班|返工|工厂|工廠|老板|老闆|生意|退休)/],
    ['recipes',   /\b(recipes?|cook(?:ed|ing)?|bak(?:e|ed|ing)|dish(?:es)?|soup|curry|rendang|laksa|dumplings?|noodles|kitchen|ingredients?)\b/i, /(做菜|煮|食谱|食譜|拿手菜|好餸|蒸|炒)/],
    ['places',    /\b(travel(?:l?ed|l?ing)?|trip|holiday|visited|abroad|journey|ship|moved to|emigrated|overseas|flew to)\b/i, /(旅行|旅游|旅遊|出国|出國|坐船|移民|去过|去過)/],
    ['family',    /\b(son|daughter|grandson|granddaughter|grandchildren|grandkids|my children|my kids|our family|my family|was born)\b/i, /(儿子|兒子|女儿|女兒|孙|孫|家人|屋企人|仔女)/],
    ['lessons',   /\b(learn(?:ed|t)|lessons?|advice|taught me|always tell|never give up)\b/i, /(道理|教会|教會|教識|学会|學會)/]
  ]

  function storyChapterOf(text) {
    const said = String(text || '')
    for (const [chapter, en, zh] of STORY_CUES) if (en.test(said) || zh.test(said)) return chapter
    return 'other'
  }

  // A reminiscence said in passing: long, and looking back. Long enough that it
  // is a story and not a remark; looking back so that "I made soup for the
  // whole building tonight" stays a chat.
  //
  // It is only ever offered, never filed. Kept automatically, a chat went
  // straight into a book the family, the centre and providers can read — a
  // diagnosis the senior said their children must never know, a nephew taking
  // their money, all of it, with a toast that is easy to miss when nobody is
  // looking at the screen (P3 QA). Now a suggestion waits on this device, in
  // My Story, and goes into the book only if the senior taps Keep. Never a
  // disclosure, pain, illness, money, violence or a secret — those are not
  // even suggested.
  const STORY_SUGGEST_KEY = 'techable_story_suggestions_'
  const STORY_SENSITIVE = /\b(hiv|aids|cancer|tumou?r|diagnos\w*|dementia|alzheimer\w*|depress\w*|anxiety|psychiatr\w*|medication|chemo\w*|stroke|heart attack|diabet\w*|pension|savings|bank|money|loan|debt|owed?|scam\w*|steal\w*|stole|stolen|hit (me|us|her|him)|beat (me|us|her|him)|beaten|abus\w*|violen\w*|assault\w*|raped?|secret|never told|nobody knows|no one knows|don'?t tell|do not tell)\b|(癌|病|诊断|診斷|失智|抑郁|抑鬱|吃药|食藥|钱|錢|银行|銀行|退休金|骗|騙|打我|虐待|暴力|秘密|唔好話|不要告诉|不要告訴|冇人知|没人知道|沒人知道)/i
  const REMINISCE = /\b(when i was|i remember|i used to|we used to|years ago|back then|in those days|as a (?:child|girl|boy|kid)|growing up|grew up|in (?:19|20)\d\d)\b|(以前|记得|記得|小时候|小時候|細個|当年|當年|那时候|那時候|嗰陣|年轻时|年輕時|後生)/i
  const CAPTURE_MIN_WORDS = 25
  const CAPTURE_MIN_CJK = 30

  function storySuggestions(r = getSelected()) {
    if (!r) return []
    try {
      const list = JSON.parse(localStorage.getItem(STORY_SUGGEST_KEY + r.id) || '[]')
      return Array.isArray(list) ? list.map(normalizeStoryEntry).filter(Boolean) : []
    } catch (_) { return [] }
  }

  function saveStorySuggestions(r, list) {
    try { localStorage.setItem(STORY_SUGGEST_KEY + r.id, JSON.stringify(list.slice(-20))) } catch (_) {}
  }

  function maybeCaptureStory(text) {
    const r = getSelected()
    const said = String(text || '').trim()
    if (!r || !said) return null
    const cjk = /[㐀-鿿豈-﫿]/.test(said)
    const size = cjk ? said.replace(/[\s，。！？、,.!?]/g, '').length : said.split(/\s+/).filter(Boolean).length
    if (size < (cjk ? CAPTURE_MIN_CJK : CAPTURE_MIN_WORDS) || !REMINISCE.test(said)) return null
    if (window.TechableCheckIn?.scanUrgent?.(said) || pats().concerns?.discomfort?.test(said)) return null
    if (STORY_SENSITIVE.test(said)) return null
    const waiting = storySuggestions(r)
    if ([...(r.lifeStory || []), ...waiting].some(e => norm(e.text) === norm(said))) return null
    const chapter = storyChapterOf(said)
    const suggestion = normalizeStoryEntry({ id: cryptoId(), chapter, text: said, prompt: '', createdAt: nowIso(), source: 'conversation' })
    saveStorySuggestions(r, [...waiting, suggestion])
    showToast(chrome('story.suggested'))
    if (activeTab === 'story') renderStory()
    return suggestion
  }

  // Keep: into the book, under the chapter it was guessed for (it can be moved
  // there). Not this one: gone from the device.
  async function keepStorySuggestion(id) {
    const r = getSelected()
    const s = storySuggestions(r).find(x => x.id === id)
    if (!s) return false
    const entry = await addStoryEntry(s.chapter, s.text, { source: 'conversation' })
    if (!entry) return false
    saveStorySuggestions(r, storySuggestions(r).filter(x => x.id !== id))
    renderStory()
    keepFocusIn('story-title')
    return true
  }

  function dismissStorySuggestion(id) {
    const r = getSelected()
    if (!r) return
    saveStorySuggestions(r, storySuggestions(r).filter(x => x.id !== id))
    renderStory()
    keepFocusIn('story-title')
  }

  // ── Story mode ────────────────────────────────────────────────
  // The companion asks about one chapter, and the senior's answers — the first
  // and up to two follow-ups — are kept as one story in their own words. It
  // ends after three answers, on "that's all" or a no, on a goodbye, or with
  // the conversation.
  const STORY_TURNS = 3
  let storyMode = null

  function startStory(chapter) {
    const r = getSelected()
    if (!r) return false
    const ch = STORY_CHAPTERS.includes(chapter) ? chapter : 'other'
    // Choosing a story is choosing not to carry on with the check-in.
    const ci = window.TechableCheckIn
    if (ci?.isActive?.()) ci.stop()
    if (activeTab !== 'conversation') switchTab('conversation')
    if (conversationEnded) newSession({ greet: false })
    pendingOffer = null
    const ask = chrome('story.ask.' + ch)
    storyMode = { chapter: ch, prompt: ask, entryId: null, turns: 0, seq: conversationSeq }
    currentMessages.push({ role: 'ai', text: ask, at: nowIso() })
    renderChat(false)
    updateSessionStats()
    speakThenListen(ask)
    return true
  }

  // A word or two that is only "no" or "I don't know", or "that's all" said
  // any way: the senior has finished. "No, my son was born the year after…" is
  // the story going on, so only a short no counts.
  function storyIsDone(text, read) {
    const said = String(text || '').trim()
    const cjk = /[㐀-鿿豈-﫿]/.test(said)
    const size = cjk ? said.replace(/[\s，。！？、,.!?]/g, '').length : said.split(/\s+/).filter(Boolean).length
    if (pats().done?.test(said) || STORY_REFUSE.test(said)) return true
    return (read.no || read.unsure) && size <= (cjk ? 4 : 3)
  }

  // Not wanting to tell this story, at any length: "I don't want to talk
  // about my childhood, it was too sad", "can we talk about something else?"
  // Those were being filed in the book word for word, and asked about again.
  // Narrow on purpose: "my mother would rather not talk about the storm" and
  // "another time, we went to the beach" are stories, so "don't want to talk
  // about" counts only said by the senior (I, we), and "another time", "rather
  // not" and "let's not" only as the whole answer. "She was too sad to eat" is
  // a story too: only "too sad to talk about" counts.
  const STORY_REFUSE = /\b(i|we)('d| would)? (really |just )?(rather not|don'?t|do not|won'?t|will not|can'?t|cannot) (want to |like to |bear to )?(talk|say|tell|go into|think|speak) about\b|\b(i'?d|i would) rather not (talk|say|tell|go into|speak)\b|\b((talk|chat|speak|tell you) about (something|anything) else|something else instead|change the subject|too (sad|painful|hard|upsetting) to (talk|think) about)\b|^\W*(no,? )?(i'?d rather not|i would rather not|let'?s not|(maybe |perhaps )?(another|some other) (time|day)|not (now|today))(,? (please|thanks|thank you|dear))?\W*$|(不想(说|讲|講|谈|談|提)|唔想(講|傾|提)|讲别的|講第二|傾第二|聊别的|聊點別|聊点别|换个话题|換個話題)|^\W*(下次(吧|啦|先|再说|再講)?|改天(吧|再说)?|第日(先|再講|啦)?)\W*$/i

  // Something the senior says they have kept from others does not belong in a
  // book their family can read, even in story mode.
  const STORY_SECRET = /\b(secret|never told|nobody knows|no one knows|don'?t tell|do not tell|must not know|(won'?t|will not|do not|don'?t) want (them|anyone|him|her|my \w+) to (know|find out))\b|(秘密|唔好話|不要告诉|不要告訴|冇人知|没人知道|沒人知道)/i

  // Returns true when it has answered the turn. A goodbye is left to the
  // ordinary path, which says goodbye and puts the chat away.
  async function storyTurn(text) {
    const s = storyMode
    if (!s || s.seq !== conversationSeq) { storyMode = null; return false }
    const read = readAnswer(text)
    const chapter = chrome('story.ch.' + s.chapter)
    const answer = reply => {
      currentMessages.push({ role: 'ai', text: reply, at: nowIso() })
      renderChat(false)
      speakThenListen(reply)
    }

    if (read.bye) { storyMode = null; return false }
    // A disclosure, or a complaint of pain, is not a story for a book the
    // family reads. Story mode ends here and the ordinary conversation
    // answers it, as it would have if no story had been asked for.
    if (window.TechableCheckIn?.scanUrgent?.(text) || pats().concerns?.discomfort?.test(text)) {
      storyMode = null
      return false
    }
    const kept = s.entryId && !s.failed
    if (storyIsDone(text, read)) {
      storyMode = null
      answer(chrome(kept ? 'story.saved' : 'story.notnow', { chapter }))
      return true
    }
    if (STORY_SECRET.test(text)) {
      storyMode = null
      answer(chrome('story.private'))
      return true
    }

    // "Yes" on its own is not a story; it is a cue to go on.
    const bare = read.yes && text.trim().split(/\s+/).length <= 2
    if (!bare) {
      // Kept without waiting: an offline write does not settle until the
      // server answers, and the senior is waiting for a reply, not a save.
      // The entry is on the page at once; a save that fails takes it back off.
      if (!s.entryId) {
        s.entryId = cryptoId()
        addStoryEntry(s.chapter, text, { id: s.entryId, source: 'story', prompt: s.prompt })
          .then(entry => { if (!entry) s.failed = true })
      } else {
        appendToStory(s.entryId, text).then(ok => { if (!ok) s.failed = true })
      }
      s.turns++
    }

    if (s.turns >= STORY_TURNS) {
      storyMode = null
      answer(s.failed ? chrome('story.thanks') : chrome('story.saved', { chapter }))
      return true
    }
    const reply = bare ? chrome('story.go')
      : await askAI(undefined, { storyChapter: s.chapter, dayDiscussed: dayDiscussedNow() })
    // Finished, or another conversation started, while the reply was coming:
    // a follow-up question after the goodbye would be the wrong last word.
    if (storyMode !== s || s.seq !== conversationSeq || conversationEnded) return true
    answer(reply)
    return true
  }

  // A chapter worth suggesting under the greeting: one of the emptiest, so the
  // book fills out rather than the first chapter growing. "Other stories" is a
  // drawer, not a subject, so it is never suggested.
  function suggestChapter(r, turn) {
    const count = ch => (r.lifeStory || []).filter(e => e.chapter === ch).length
    const open = STORY_CHAPTERS.filter(ch => ch !== 'other')
    const least = Math.min(...open.map(count))
    const pool = open.filter(ch => count(ch) === least)
    return pool[turn % pool.length]
  }

  // ── My Story ──────────────────────────────────────────────────
  // Nine chapters in book order, each with its stories, "Talk about it" and
  // "Write it myself". One story at a time can be changed (and moved to another
  // chapter); clicks are handled once on the container, so nothing here builds
  // an inline handler out of a story's id.
  let storyEditing = null
  let storyWriting = null

  function storyDate(iso) {
    const d = new Date(iso)
    if (!d.getTime()) return ''
    try { return d.toLocaleDateString(document.documentElement.lang || undefined, { day: 'numeric', month: 'short', year: 'numeric' }) }
    catch (_) { return d.toDateString() }
  }

  function storyEntryHTML(e) {
    const id = esc(e.id)
    if (storyEditing === e.id) {
      return `
        <div class="story-entry story-editing">
          <label class="sr-only" for="story-edit-${id}">${esc(chrome('story.yours'))}</label>
          <textarea class="story-input" id="story-edit-${id}" rows="6" maxlength="${STORY_TEXT_MAX}">${esc(e.text)}</textarea>
          <label class="story-move">${esc(chrome('story.chapter'))}
            <select id="story-move-${id}">${STORY_CHAPTERS.map(c =>
              `<option value="${c}"${c === e.chapter ? ' selected' : ''}>${esc(chrome('story.ch.' + c))}</option>`).join('')}</select>
          </label>
          <div class="story-btns">
            <button type="button" class="btn btn-p story-btn" data-act="save-edit" data-id="${id}">${esc(chrome('story.save'))}</button>
            <button type="button" class="btn btn-s story-btn" data-act="cancel">${esc(chrome('story.cancel'))}</button>
          </div>
        </div>`
    }
    const about = esc(clip(e.text.replace(/\s+/g, ' '), 40))
    return `
      <article class="story-entry">
        <p class="story-text">${esc(e.text)}</p>
        <div class="story-meta">
          <span>${esc([storyDate(e.createdAt), chrome('story.src.' + e.source)].filter(Boolean).join(' · '))}</span>
          <span class="story-entry-btns">
            <button type="button" class="story-link" data-act="edit" data-id="${id}" aria-label="${esc(chrome('story.edit'))}: ${about}">${esc(chrome('story.edit'))}</button>
            <button type="button" class="story-link" data-act="remove" data-id="${id}" aria-label="${esc(chrome('story.remove'))}: ${about}">${esc(chrome('story.remove'))}</button>
          </span>
        </div>
      </article>`
  }

  function renderStory() {
    const box = $('story-chapters')
    if (!box) return
    const r = getSelected()
    if (!r) { box.innerHTML = ''; return }
    const entries = (r.lifeStory || []).filter(e => !String(e.prompt || '').startsWith('Blog: '))
    const waiting = storySuggestions(r)
    const suggested = !waiting.length ? '' : `
        <section class="card story-ch story-waiting" aria-labelledby="story-h-waiting">
          <div class="story-ch-hd"><h3 class="story-ch-title" id="story-h-waiting">${esc(chrome('story.waiting.title'))}</h3></div>
          <p class="story-empty">${esc(chrome('story.waiting.intro'))}</p>
          ${waiting.map(s => `
            <article class="story-entry">
              <p class="story-text">${esc(s.text)}</p>
              <div class="story-btns">
                <button type="button" class="btn btn-p story-btn" data-act="keep" data-id="${esc(s.id)}">${esc(chrome('story.keep', { chapter: chrome('story.ch.' + s.chapter) }))}</button>
                <button type="button" class="btn btn-s story-btn" data-act="dismiss" data-id="${esc(s.id)}">${esc(chrome('story.dismiss'))}</button>
              </div>
            </article>`).join('')}
        </section>`
    box.innerHTML = suggested + STORY_CHAPTERS.map(ch => {
      const list = entries.filter(e => e.chapter === ch)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      const writing = storyWriting !== ch ? '' : `
        <div class="story-entry story-editing">
          <label class="sr-only" for="story-new-${ch}">${esc(chrome('story.yours'))}</label>
          <textarea class="story-input" id="story-new-${ch}" rows="6" maxlength="${STORY_TEXT_MAX}"></textarea>
          <div class="story-btns">
            <button type="button" class="btn btn-p story-btn" data-act="save-new" data-chapter="${ch}">${esc(chrome('story.save'))}</button>
            <button type="button" class="btn btn-s story-btn" data-act="cancel">${esc(chrome('story.cancel'))}</button>
          </div>
        </div>`
      return `
        <section class="card story-ch" data-chapter="${ch}" aria-labelledby="story-h-${ch}">
          <div class="story-ch-hd">
            <h3 class="story-ch-title" id="story-h-${ch}">${esc(chrome('story.ch.' + ch))}</h3>
            <span class="story-count" aria-hidden="true">${list.length}</span>
          </div>
          ${list.map(storyEntryHTML).join('') || `<p class="story-empty">${esc(chrome('story.empty'))}</p>`}
          ${writing}
          <div class="story-btns">
            <button type="button" class="btn btn-s story-btn" data-act="tell" data-chapter="${ch}"><span aria-hidden="true">🎙</span> ${esc(chrome('story.tell'))}</button>
            <button type="button" class="btn btn-s story-btn" data-act="write" data-chapter="${ch}"><span aria-hidden="true">✍️</span> ${esc(chrome('story.write'))}</button>
          </div>
        </section>`
    }).join('')
    if (!box.storyWired) {
      box.storyWired = true
      box.addEventListener('click', ev => {
        const btn = ev.target?.closest?.('[data-act]')
        if (btn && box.contains(btn)) storyAction(btn.dataset.act, btn.dataset)
      })
    }
  }

  async function storyAction(act, data = {}) {
    if (act === 'tell') return startStory(data.chapter)
    if (act === 'remove') return removeStoryEntry(data.id)
    if (act === 'keep') return keepStorySuggestion(data.id)
    if (act === 'dismiss') return dismissStorySuggestion(data.id)
    if (act === 'write' || act === 'edit' || act === 'cancel') {
      storyWriting = act === 'write' ? data.chapter : null
      storyEditing = act === 'edit' ? data.id : null
      renderStory()
      $(act === 'write' ? 'story-new-' + data.chapter : 'story-edit-' + data.id)?.focus()
      return
    }
    if (act === 'save-new') {
      const box = $('story-new-' + data.chapter)
      if (!box?.value.trim()) return box?.focus()
      if (await addStoryEntry(data.chapter, box.value)) { storyWriting = null; renderStory() }
      return
    }
    if (act === 'save-edit') {
      const box = $('story-edit-' + data.id)
      if (!box?.value.trim()) return box?.focus()
      if (await editStoryEntry(data.id, box.value, $('story-move-' + data.id)?.value)) { storyEditing = null; renderStory() }
    }
  }

  // The book, for the browser's print dialog — which is also how a phone or a
  // computer saves a PDF. Only chapters with stories in them, in book order.
  // The page is put back by the afterprint event: some browsers return from
  // print() before the dialog closes, and taking the book away then would
  // print the chat instead.
  function printStory() {
    const r = getSelected()
    const out = $('story-print')
    if (!r || !out) return
    const entries = r.lifeStory || []
    out.innerHTML = `<h1>${esc(chrome('story.book', { name: r.name || r.preferredName || '' }))}</h1>` +
      STORY_CHAPTERS.map(ch => {
        const list = entries.filter(e => e.chapter === ch)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        if (!list.length) return ''
        return `<section class="sp-ch"><h2>${esc(chrome('story.ch.' + ch))}</h2>${
          list.map(e => `<p class="story-text">${esc(e.text)}</p>`).join('')}</section>`
      }).join('')
    document.body.classList.add('print-story')
    const done = () => {
      document.body.classList.remove('print-story')
      window.removeEventListener?.('afterprint', done)
    }
    window.addEventListener?.('afterprint', done)
    window.print()
  }

  // ── The family inbox ──────────────────────────────────────────
  // Nothing a family sent ever reached the senior: family_messages go to the
  // centre manager, and only when there is one (audits/P3-senior-feedback.md,
  // item 6). A linked family member now sends a message, a voice note or a
  // photo from family-dashboard.html into family_notes, addressed to the
  // senior's own login, with the bytes apart in family_note_media.
  //
  // Here: the senior's notes are read with one equality query (sorted in the
  // browser — no new index), the greeting says what is waiting, a yes or a tap
  // plays or shows it in the chat, and heardAt is written when it is. The bytes
  // are fetched only when a message is opened. Only the senior's own login
  // reads them — a manager driving a resident's chat never does, and the rules
  // would refuse it anyway.
  const NOTE_KINDS = ['text', 'voice', 'photo']
  const NOTE_RELATIONS = ['daughter', 'son', 'granddaughter', 'grandson', 'grandchild', 'wife', 'husband', 'partner',
    'sister', 'brother', 'niece', 'nephew', 'cousin', 'friend', 'neighbour', 'carer']
  const NOTE_MEDIA_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'image/jpeg']
  let inbox = { loaded: false, failed: false, notes: [] }
  // note id → its data: URL, or null when it could not be fetched or was not
  // what the note said it was.
  const noteMedia = new Map()
  // Notes opened on the Family screen, showing their player or photo.
  const famOpen = new Set()
  // The greeting asks once a visit; "not now" is the answer for this visit.
  let inboxDeclined = false

  function noteDate(v) {
    const d = v?.toDate?.() || (v instanceof Date ? v : v ? new Date(v) : null)
    return d && !isNaN(d.getTime()) ? d : new Date()
  }

  function normalizeNote(id, d) {
    if (!d || !NOTE_KINDS.includes(d.kind)) return null
    return {
      id: String(id),
      kind: d.kind,
      text: String(d.text || ''),
      fromUid: String(d.fromUid || ''),
      fromName: String(d.fromName || ''),
      relation: NOTE_RELATIONS.includes(d.relation) ? d.relation : '',
      mediaType: String(d.mediaType || ''),
      at: noteDate(d.createdAt).getTime(),
      heard: Boolean(d.heardAt)
    }
  }

  // Heard on this screen, whether or not the write reached the server, so a
  // refresh does not bring a message back as new.
  const heardHere = new Set()

  async function loadInbox() {
    let notes = []
    let failed = false
    if (usingFirestore && isResident() && authUser?.uid) {
      try {
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'family_notes'), fs.where('seniorUid', '==', authUser.uid)))
        snap.forEach(d => notes.push(normalizeNote(d.id, d.data())))
        notes = notes.filter(Boolean).sort((a, b) => b.at - a.at)
        notes.forEach(n => { if (heardHere.has(n.id)) n.heard = true })
      } catch (err) {
        // The rules may not be deployed yet, or the device is offline. The
        // Family screen says so; nothing else depends on this. A refresh that
        // fails keeps what the last one found.
        failed = true
        console.warn('[inbox] could not load family messages:', err?.code || err?.message)
      }
    }
    inbox = failed && inbox.notes.length
      ? { loaded: true, failed: false, notes: inbox.notes }
      : { loaded: true, failed, notes }
    afterInboxChange()
    return inbox.notes
  }

  // ── Who may reach the senior ─────────────────────────────────
  // Linking to a senior needs only their email address (audits/F32, finding
  // 1, still open), and a message here is announced by the companion itself:
  // "Your grandson Ben left you a voice message". Unchecked, that is a voice
  // the senior trusts introducing whoever typed "grandson" (P3 QA). So the
  // first message from anyone is held back: the Family screen asks whether
  // the senior knows them, and nothing they sent is announced, played or
  // shown until the senior says yes. No blocks them, and the rules then
  // refuse anything more from them.
  function trustedNote(n) {
    const r = getSelected()
    return Boolean(r && n.fromUid && (r.messageFrom || []).includes(n.fromUid) && !(r.messageBlocked || []).includes(n.fromUid))
  }

  function trustedNotes() {
    return inbox.notes.filter(trustedNote)
  }

  // Senders waiting for a yes or no, one entry each, newest note first.
  function senderRequests() {
    const r = getSelected()
    const seen = new Map()
    for (const n of inbox.notes) {
      if (!n.fromUid || trustedNote(n) || (r?.messageBlocked || []).includes(n.fromUid) || seen.has(n.fromUid)) continue
      seen.set(n.fromUid, { fromUid: n.fromUid, fromName: n.fromName, relation: n.relation })
    }
    return [...seen.values()]
  }

  // Oldest first: several waiting are opened in the order they were sent.
  function unheardNotes() {
    return trustedNotes().filter(n => !n.heard).sort((a, b) => a.at - b.at)
  }

  async function saveMessagingLists(r, patch) {
    if (usingFirestore) {
      await fs.setDoc(fs.doc(db, 'residents', r.id), { ...patch, updatedAt: fs.serverTimestamp() }, { merge: true })
    }
    Object.assign(r, patch)
    if (!usingFirestore) persistLocalResidents()
  }

  async function allowSender(uid) {
    const r = getSelected()
    const req = senderRequests().find(x => x.fromUid === uid)
    if (!r || !req) return false
    try {
      await saveMessagingLists(r, { messageFrom: [...new Set([...(r.messageFrom || []), uid])].slice(-100) })
      afterInboxChange()
      keepFocusIn('family-title')
      showToast(chrome('inbox.allowed', { name: givenName(req.fromName) || chrome('inbox.who.someone') }))
      return true
    } catch (err) {
      console.warn('[inbox] could not save who may send messages:', err?.code || err?.message)
      showToast(chrome('inbox.saveFailed'))
      return false
    }
  }

  // Blocked: their messages go, and the rules refuse anything more from them.
  async function blockSender(uid) {
    const r = getSelected()
    const req = senderRequests().find(x => x.fromUid === uid)
    if (!r || !req) return false
    const name = givenName(req.fromName) || chrome('inbox.who.someone')
    if (!confirm(chrome('inbox.confirmBlock', { name }))) return false
    try {
      await saveMessagingLists(r, { messageBlocked: [...new Set([...(r.messageBlocked || []), uid])].slice(-100) })
      const theirs = inbox.notes.filter(n => n.fromUid === uid)
      if (usingFirestore && theirs.length) {
        const batch = fs.writeBatch(db)
        theirs.forEach(n => {
          batch.delete(fs.doc(db, 'family_notes', n.id))
          if (n.kind !== 'text') batch.delete(fs.doc(db, 'family_note_media', n.id))
        })
        await batch.commit().catch(err => console.warn('[inbox] blocked, but their messages were not all deleted:', err?.code || err?.message))
      }
      inbox.notes = inbox.notes.filter(n => n.fromUid !== uid)
      afterInboxChange()
      keepFocusIn('family-title')
      showToast(chrome('inbox.blocked', { name }))
      return true
    } catch (err) {
      console.warn('[inbox] could not block a sender:', err?.code || err?.message)
      showToast(chrome('inbox.saveFailed'))
      return false
    }
  }

  function afterInboxChange() {
    syncInboxBadge()
    starters.stale = true
    renderStarters()
    if (activeTab === 'family') renderFamily()
  }

  function syncInboxBadge() {
    const count = unheardNotes().length + senderRequests().length + linkRequests().length
    const badge = $('family-badge')
    if (badge) {
      badge.hidden = !count
      badge.textContent = count ? String(count) : ''
    }
    // The number alone would be read as "Family 2"; say what it counts.
    const btn = document.querySelector('.senior-nav [data-tab="family"]')
    if (btn) {
      if (count) btn.setAttribute('aria-label', chrome('inbox.navLabel', { n: count }))
      else btn.removeAttribute('aria-label')
    }
  }

  // "your granddaughter Lily", "Lily", "your son", or "someone in your family".
  function noteWho(n) {
    const person = givenName(n.fromName)
    const relation = n.relation ? chrome('rel.' + n.relation) : ''
    if (relation && person) return chrome('inbox.who.rel', { relation, person })
    if (person) return person
    if (relation) return chrome('inbox.who.relOnly', { relation })
    return chrome('inbox.who.someone')
  }

  // When, the way a person says it: this afternoon, yesterday, on Monday.
  function noteWhen(n) {
    const d = new Date(n.at)
    const now = new Date()
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const days = Math.round((day(now) - day(d)) / 86400000)
    if (days <= 0) {
      const h = d.getHours()
      return chrome(h < 12 ? 'when.morning' : h < 17 ? 'when.afternoon' : 'when.evening')
    }
    if (days === 1) return chrome('when.yesterday')
    if (days < 7) {
      const locale = { cmn: 'zh-CN', yue: 'zh-HK' }[langCode()] || 'en-US'
      return chrome('when.day', { day: d.toLocaleDateString(locale, { weekday: 'long' }) })
    }
    return chrome('when.recent')
  }

  const whoVars = n => { const who = noteWho(n); return { who, Who: capitalise(who) } }

  // What the greeting says when something is waiting, or nothing.
  function inboxAnnouncement() {
    const waiting = unheardNotes()
    if (!waiting.length || inboxDeclined) return ''
    if (waiting.length > 1) return chrome('inbox.many', { n: waiting.length })
    const n = waiting[0]
    return chrome('inbox.' + n.kind + '.left', { ...whoVars(n), when: noteWhen(n) })
  }

  // Only a data: URL of the note's own type, base64 and nothing else, is ever
  // put in a src attribute — the bytes were written by another account.
  function safeMediaUrl(data, type) {
    const prefix = 'data:' + type + ';base64,'
    if (!NOTE_MEDIA_TYPES.includes(type) || typeof data !== 'string') return null
    if (!data.startsWith(prefix) || data.length > 900000) return null
    return /^[A-Za-z0-9+/=]+$/.test(data.slice(prefix.length)) ? data : null
  }

  async function loadNoteMedia(n) {
    if (n.kind === 'text') return null
    if (noteMedia.get(n.id)) return noteMedia.get(n.id)
    try {
      if (!usingFirestore) throw new Error('no database')
      const snap = await fs.getDoc(fs.doc(db, 'family_note_media', n.id))
      noteMedia.set(n.id, snap.exists() ? safeMediaUrl(snap.data()?.data, n.mediaType) : null)
    } catch (err) {
      console.warn('[inbox] could not load a recording or photo:', err?.code || err?.message)
      noteMedia.set(n.id, null)
    }
    return noteMedia.get(n.id)
  }

  function noteMediaHTML(id, kind, who) {
    const url = noteMedia.get(id)
    if (url === undefined) return `<div class="msg-note">${esc(chrome('inbox.loading'))}</div>`
    if (!url) return `<div class="msg-note msg-note-err">${esc(chrome('inbox.mediaFailed'))}</div>`
    return kind === 'voice'
      ? `<div class="msg-note"><audio controls preload="auto" src="${esc(url)}"></audio></div>`
      : `<div class="msg-note"><img class="msg-photo" src="${esc(url)}" alt="${esc(chrome('inbox.photoAlt', { who: who || '' }))}"></div>`
  }

  // Heard once, on the server's clock. A write that fails leaves it heard on
  // this screen — asking again would be worse than the sender not seeing a tick.
  async function markNoteHeard(n) {
    if (!n || n.heard) return
    n.heard = true
    heardHere.add(n.id)
    afterInboxChange()
    if (!usingFirestore) return
    try {
      await fs.updateDoc(fs.doc(db, 'family_notes', n.id), { heardAt: fs.serverTimestamp() })
    } catch (err) {
      console.warn('[inbox] could not mark a message heard:', err?.code || err?.message)
    }
  }

  const noteSel = id => (window.CSS?.escape ? CSS.escape(id) : id)

  function playNoteInChat(id) {
    const audio = $('chat-win')?.querySelector?.(`[data-note="${noteSel(id)}"] audio`)
    if (!audio || !audio.paused) return
    // After a voice message, the next one waiting is offered.
    audio.onended = () => offerNextNote()
    // Some phones (iOS Safari) only play audio straight from a tap. The
    // player is on screen with its controls either way; say so.
    audio.play?.()?.catch?.(() => showToast(chrome('inbox.tapToPlay')))
  }

  function offerNextNote() {
    const next = unheardNotes()[0]
    if (!next || conversationEnded) return
    const text = chrome('inbox.another', whoVars(next))
    pendingOffer = 'familynote'
    currentMessages.push({ role: 'ai', text, at: nowIso() })
    renderChat(false)
    speakThenListen(text)
  }

  // The companion opens a message in the chat, as its own turn: it reads a
  // written one out, and introduces a recording or a photo, which appears
  // under the line. A recording plays once the introduction has been said.
  async function presentNote(n) {
    if (!n) return false
    const v = whoVars(n)
    const caption = n.text.trim()
    const person = givenName(n.fromName)
    const wrote = !caption ? '' : ' ' + (person
      ? chrome('inbox.caption.by', { person, text: caption })
      : chrome('inbox.caption', { text: caption }))
    let text = n.kind === 'text'
      ? chrome('inbox.says', { ...v, text: caption })
      : chrome('inbox.' + n.kind + '.here', v) + wrote
    const next = unheardNotes().find(x => x.id !== n.id)
    // A recording asks about the next one when it has finished playing.
    if (next && n.kind !== 'voice') {
      text += ' ' + chrome('inbox.another', whoVars(next))
      pendingOffer = 'familynote'
    }
    currentMessages.push({ role: 'ai', text, at: nowIso(), note: { id: n.id, kind: n.kind, who: v.who } })
    renderChat(false)
    updateSessionStats()
    markNoteHeard(n)

    // A recording plays when both have happened, in whichever order: the
    // introduction has been said, and the bytes have arrived.
    let introduced = false
    if (n.kind === 'voice') Voice.speak(text, () => { introduced = true; playNoteInChat(n.id) })
    else speakThenListen(text)
    if (n.kind !== 'text') {
      await loadNoteMedia(n)
      renderChat(false)
      if (n.kind === 'voice' && introduced) playNoteInChat(n.id)
    }
    return true
  }

  // The answer to "would you like to hear it?".
  const INBOX_OPEN = /\b(play|read|show|hear|listen|open|see)\b|(听|聽|播|睇|看|读|讀|打开|打開)/i

  async function answerInboxOffer(text) {
    const read = readAnswer(text)
    const p = pats()
    if (!read.no && (read.yes || p.consent?.test(text) || INBOX_OPEN.test(text))) {
      return presentNote(unheardNotes()[0])
    }
    if (read.no || p.decline?.test(text)) {
      inboxDeclined = true
      const reply = chrome('inbox.later')
      currentMessages.push({ role: 'ai', text: reply, at: nowIso() })
      renderChat(false)
      speakThenListen(reply)
      return true
    }
    return false
  }

  // ── The Family screen ─────────────────────────────────────────
  function famNoteHTML(n) {
    const v = whoVars(n)
    const id = esc(n.id)
    const icon = { text: '✍️', voice: '🎙', photo: '📷' }[n.kind]
    const [act, label] = n.kind === 'voice' ? ['play', 'inbox.play'] : n.kind === 'photo' ? ['show', 'inbox.show'] : ['read', 'inbox.read']
    return `
      <article class="card fam-note" data-note="${id}">
        <div class="fam-note-hd">
          <span class="fam-from"><span aria-hidden="true">${icon}</span> ${esc(v.Who)}</span>
          <span class="fam-when">${esc(noteWhen(n))}</span>
          ${n.heard ? '' : `<span class="fam-new">${esc(chrome('inbox.new'))}</span>`}
        </div>
        ${n.text ? `<p class="story-text">${esc(n.text)}</p>` : ''}
        ${famOpen.has(n.id) && n.kind !== 'text' ? noteMediaHTML(n.id, n.kind, v.who) : ''}
        <div class="story-btns">
          <button type="button" class="btn btn-p story-btn" data-act="${act}" data-id="${id}">${esc(chrome(label))}</button>
          <button type="button" class="btn btn-s story-btn" data-act="delete" data-id="${id}" aria-label="${esc(chrome('inbox.delete'))}: ${esc(v.who)}">${esc(chrome('inbox.delete'))}</button>
        </div>
      </article>`
  }

  function senderRequestHTML(req) {
    const uid = esc(req.fromUid)
    const name = req.fromName.trim() || chrome('inbox.who.someone')
    const relation = req.relation ? chrome('inbox.ask.relation', { relation: chrome('rel.' + req.relation) }) : ''
    return `
      <article class="card fam-note fam-request" data-sender="${uid}">
        <p class="fam-from">${esc(chrome('inbox.ask', { name }))}</p>
        ${relation ? `<p class="story-text">${esc(relation)}</p>` : ''}
        <p class="story-text">${esc(chrome('inbox.ask.q'))}</p>
        <div class="story-btns">
          <button type="button" class="btn btn-p story-btn" data-act="allow" data-id="${uid}">${esc(chrome('inbox.allow'))}</button>
          <button type="button" class="btn btn-s story-btn" data-act="block" data-id="${uid}">${esc(chrome('inbox.block'))}</button>
        </div>
      </article>`
  }

  function renderFamily() {
    const box = $('family-list')
    if (!box) return
    const say = key => `<p class="story-empty">${esc(chrome(key))}</p>`
    // Someone asking to connect comes first: it is the one thing here the
    // senior has to decide. Who is connected comes last, always within reach.
    const asks = linkRequests().map(linkRequestHTML).join('')
    const requests = senderRequests()
    const notes = trustedNotes()
    box.innerHTML = asks + (!inbox.loaded ? say('inbox.loading')
      : inbox.failed ? say('inbox.loadFailed')
      : !notes.length && !requests.length ? (asks ? '' : say('inbox.empty'))
      : requests.map(senderRequestHTML).join('') + notes.map(famNoteHTML).join('')) + linkedHTML() + findableHTML()
    if (!box.inboxWired) {
      box.inboxWired = true
      box.addEventListener('click', ev => {
        const btn = ev.target?.closest?.('[data-act]')
        if (btn && box.contains(btn)) inboxAction(btn.dataset.act, btn.dataset.id)
      })
    }
  }

  async function inboxAction(act, id) {
    if (act === 'linkAllow') return answerLink(id, true)
    if (act === 'linkBlock') return answerLink(id, false)
    if (act === 'linkRemove') return removeLink(id)
    if (act === 'findable') return setFindable(getSelected()?.findable !== true)
    if (act === 'allow') return allowSender(id)
    if (act === 'block') return blockSender(id)
    // Only messages from someone the senior allowed can be opened.
    const n = trustedNotes().find(x => x.id === id)
    if (!n) return
    if (act === 'delete') return deleteNote(n)
    if (act === 'read') {
      markNoteHeard(n)
      Voice.speak(chrome('inbox.says', { ...whoVars(n), text: n.text }))
      return
    }
    famOpen.add(n.id)
    markNoteHeard(n)
    renderFamily()
    await loadNoteMedia(n)
    renderFamily()
    if (act === 'play') $('family-list')?.querySelector?.(`[data-note="${noteSel(n.id)}"] audio`)?.play?.()?.catch?.(() => {})
  }

  // The note and its recording or photo go together, in one batch. The sender
  // may have removed the recording already; the rules let that delete pass.
  async function deleteNote(n) {
    if (!confirm(chrome('inbox.confirmDelete'))) return false
    try {
      if (usingFirestore) {
        const batch = fs.writeBatch(db)
        batch.delete(fs.doc(db, 'family_notes', n.id))
        if (n.kind !== 'text') batch.delete(fs.doc(db, 'family_note_media', n.id))
        await batch.commit()
      }
      inbox.notes = inbox.notes.filter(x => x.id !== n.id)
      noteMedia.delete(n.id)
      famOpen.delete(n.id)
      afterInboxChange()
      renderFamily()
      keepFocusIn('family-title')
      showToast(chrome('inbox.deleted'))
      return true
    } catch (err) {
      console.warn('[inbox] could not delete a message:', err?.code || err?.message)
      showToast(chrome('inbox.deleteFailed'))
      return false
    }
  }

  // ── Who is connected to the senior (F32) ──────────────────────
  // A family account used to link itself to a senior in no centre with only
  // their email address, and see their profile, chats, check-ins and life
  // story without the senior ever being asked or told (audits/F32, finding
  // 1). Now a link is a request (firestore.rules): the Family screen asks the
  // senior, a yes makes it active and lets that person send messages without
  // a second question, and a no declines it and blocks them. Every active
  // link is listed with Remove, the ones made before anyone was asked
  // included (finding 4). Never announced by the companion's voice, for the
  // same reason as a message from someone new.
  let links = { loaded: false, failed: false, list: [] }
  const LINK_STATUSES = ['pending', 'active']

  function normalizeLink(id, d) {
    if (!d || typeof d.familyUid !== 'string' || !d.familyUid || !LINK_STATUSES.includes(d.status)) return null
    return {
      id: String(id),
      familyUid: d.familyUid,
      familyName: typeof d.familyName === 'string' ? d.familyName.trim().slice(0, 120) : '',
      status: d.status,
      at: noteDate(d.createdAt)
    }
  }

  async function loadLinks() {
    let list = []
    let failed = false
    if (usingFirestore && isResident() && authUser?.uid) {
      try {
        const snap = await fs.getDocs(fs.query(fs.collection(db, 'family_links'), fs.where('seniorUid', '==', authUser.uid)))
        snap.forEach(d => list.push(normalizeLink(d.id, d.data())))
        list = list.filter(Boolean).sort((a, b) => b.at - a.at)
      } catch (err) {
        // Rules not deployed yet, or offline. Said on the Family screen, never
        // shown as "nobody is connected"; a refresh that fails keeps the list.
        failed = true
        console.warn('[links] could not load family connections:', err?.code || err?.message)
      }
    }
    links = failed && links.list.length
      ? { loaded: true, failed: false, list: links.list }
      : { loaded: true, failed, list }
    afterInboxChange()
    return links.list
  }

  function linkRequests() { return links.list.filter(l => l.status === 'pending') }
  function linkedAccounts() { return links.list.filter(l => l.status === 'active') }
  const linkFullName = l => l.familyName || capitalise(chrome('inbox.who.someone'))
  const linkName = l => givenName(l.familyName) || chrome('inbox.who.someone')

  // Yes, or no and block: the answer, and the message list that goes with it,
  // in one batch — a yes never half-saved, a block never without the no.
  async function answerLink(id, yes) {
    const r = getSelected()
    const l = linkRequests().find(x => x.id === id)
    if (!r || !l || !usingFirestore || !authUser?.uid) return false
    const name = linkName(l)
    if (!yes && !confirm(chrome('link.confirmBlock', { name }))) return false
    const field = yes ? 'messageFrom' : 'messageBlocked'
    const patch = { [field]: [...new Set([...(r[field] || []), l.familyUid])].slice(-100) }
    try {
      const batch = fs.writeBatch(db)
      batch.set(fs.doc(db, 'family_links', l.id),
        { status: yes ? 'active' : 'rejected', reviewedBy: authUser.uid, reviewedAt: fs.serverTimestamp() }, { merge: true })
      batch.set(fs.doc(db, 'residents', r.id), { ...patch, updatedAt: fs.serverTimestamp() }, { merge: true })
      await batch.commit()
    } catch (err) {
      console.warn('[links] could not save the answer:', err?.code || err?.message)
      showToast(chrome('inbox.saveFailed'))
      return false
    }
    Object.assign(r, patch)
    links.list = yes
      ? links.list.map(x => (x.id === l.id ? { ...x, status: 'active' } : x))
      : links.list.filter(x => x.id !== l.id)
    afterInboxChange()
    renderFamily()
    keepFocusIn('family-title')
    showToast(chrome(yes ? 'link.allowed' : 'link.blocked', { name }))
    return true
  }

  async function removeLink(id) {
    const l = linkedAccounts().find(x => x.id === id)
    if (!l || !usingFirestore) return false
    const name = linkName(l)
    if (!confirm(chrome('link.confirmRemove', { name }))) return false
    try {
      await fs.deleteDoc(fs.doc(db, 'family_links', l.id))
    } catch (err) {
      console.warn('[links] could not remove a connection:', err?.code || err?.message)
      showToast(chrome('inbox.saveFailed'))
      return false
    }
    links.list = links.list.filter(x => x.id !== l.id)
    afterInboxChange()
    renderFamily()
    keepFocusIn('family-title')
    showToast(chrome('link.removed', { name }))
    return true
  }

  // "Let my family find me": saved on their record first, then the directory
  // follows it — published while on, cleared while off.
  async function setFindable(on) {
    const r = getSelected()
    if (!r || !usingFirestore || !isResident()) return false
    const next = Boolean(on)
    try {
      await fs.setDoc(fs.doc(db, 'residents', r.id), { findable: next, updatedAt: fs.serverTimestamp() }, { merge: true })
    } catch (err) {
      console.warn('[senior-directory] could not save whether they can be found:', err?.code || err?.message)
      showToast(chrome('inbox.saveFailed'))
      return false
    }
    r.findable = next
    await ensureSeniorLinkDirectory(r)
    renderFamily()
    // The switch was drawn again under the finger: the focus goes back to it,
    // not out to the page behind the screen.
    const had = document.activeElement
    if (!had || had === document.body || had.isConnected === false) $('family-list')?.querySelector?.('[data-act="findable"]')?.focus?.()
    showToast(chrome(next ? 'find.saved.on' : 'find.saved.off'))
    return true
  }

  // The switch, built like "Read replies aloud" so the two read the same way.
  function findableHTML() {
    const r = getSelected()
    if (!usingFirestore || !isResident() || !r) return ''
    const on = r.findable === true
    return `
      <section class="card fam-linked fam-findable" aria-labelledby="fam-find-title">
        <h3 class="story-ch-title" id="fam-find-title">${esc(chrome('find.title'))}</h3>
        <p class="story-empty">${esc(chrome('find.intro'))}</p>
        <button type="button" class="aloud-switch" role="switch" aria-checked="${on}" aria-labelledby="fam-find-title" data-act="findable">
          <span class="aloud-state">${esc(chrome(on ? 'aloud.on' : 'aloud.off'))}</span>
          <span class="aloud-track" aria-hidden="true"><span class="aloud-knob"></span></span>
        </button>
      </section>`
  }

  function linkRequestHTML(l) {
    const id = esc(l.id)
    return `
      <article class="card fam-note fam-request" data-link="${id}">
        <p class="fam-from">${esc(chrome('link.ask', { name: linkFullName(l) }))}</p>
        <p class="story-text">${esc(chrome('link.ask.what'))}</p>
        <p class="story-text">${esc(chrome('inbox.ask.q'))}</p>
        <div class="story-btns">
          <button type="button" class="btn btn-p story-btn" data-act="linkAllow" data-id="${id}">${esc(chrome('link.allow'))}</button>
          <button type="button" class="btn btn-s story-btn" data-act="linkBlock" data-id="${id}">${esc(chrome('inbox.block'))}</button>
        </div>
      </article>`
  }

  // Who can see their profile, chats, check-ins and life story, with Remove.
  function linkedHTML() {
    if (links.failed) return `<p class="story-empty">${esc(chrome('link.loadFailed'))}</p>`
    const active = linkedAccounts()
    if (!active.length) return ''
    return `
      <section class="card fam-linked" aria-labelledby="fam-linked-title">
        <h3 class="story-ch-title" id="fam-linked-title">${esc(chrome('link.title'))}</h3>
        <p class="story-empty">${esc(chrome('link.intro'))}</p>
        <ul class="fam-linked-list">${active.map(l => `
          <li class="fam-linked-row">
            <span class="fam-from">${esc(linkFullName(l))}</span>
            <button type="button" class="btn btn-s story-btn" data-act="linkRemove" data-id="${esc(l.id)}" aria-label="${esc(chrome('link.remove'))}: ${esc(linkFullName(l))}">${esc(chrome('link.remove'))}</button>
          </li>`).join('')}
        </ul>
      </section>`
  }

  // ── Asking a centre to join ───────────────────────────────────
  // centre_requests/{seniorUid}_{communityId}: the senior asks, the centre's
  // manager decides in profile.html, and an approval links the senior's own
  // record (centreId, communityId, communityName) in the same batch — the
  // rules allow that link on no other terms. One request at a time: asking
  // again clears the earlier one first, since the id is fixed per centre.
  let centreRequests = []

  function latestCentreRequest() {
    return centreRequests[0] || null
  }

  async function loadCentreRequests() {
    if (!usingFirestore || !isResident() || !authUser?.uid) { centreRequests = []; return centreRequests }
    try {
      const snap = await fs.getDocs(fs.query(fs.collection(db, 'centre_requests'), fs.where('seniorUid', '==', authUser.uid)))
      const list = []
      snap.forEach(d => {
        const x = d.data() || {}
        list.push({ id: d.id, communityId: String(x.communityId || ''), communityName: String(x.communityName || ''),
          status: String(x.status || ''), at: noteDate(x.createdAt).getTime() })
      })
      centreRequests = list.sort((a, b) => b.at - a.at)
    } catch (err) {
      // Not deployed yet, or offline: the card falls back to what the record says.
      console.warn('[centre] could not load join requests:', err?.code || err?.message)
    }
    return centreRequests
  }

  // A write that has not settled in this long is reported as not sent. Offline,
  // a Firestore write waits for the server indefinitely, and the senior would
  // be left looking at a button that did nothing.
  const JOIN_DEADLINE_MS = 10000
  const withDeadline = (p, ms) => Promise.race([p,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out'), { code: 'deadline-exceeded' })), ms))])

  async function askToJoin() {
    const r = getSelected()
    const c = joinableCentres().find(x => x.id === onb.centre)
    if (!c) { onb.status = chrome('onb.centre.pick'); return renderOnboarding() }
    if (!r || !usingFirestore || !authUser?.uid || selfLoadFailed) { onb.status = chrome('onb.centre.failed'); return renderOnboarding() }
    const id = authUser.uid + '_' + c.id
    // Exactly the fields the rules allow, the centre named as it names itself
    // and routed to its own manager — the rules check both against the centre.
    const request = {
      seniorUid: authUser.uid,
      residentId: r.id,
      seniorName: String(r.name || r.preferredName || accountRealName()).trim().slice(0, 120),
      communityId: c.id,
      communityName: c.name,
      managerUid: c.managerUid,
      status: 'pending',
      createdAt: fs.serverTimestamp()
    }
    try {
      for (const old of centreRequests) {
        // One the manager already cleared is simply gone.
        await withDeadline(fs.deleteDoc(fs.doc(db, 'centre_requests', old.id)), JOIN_DEADLINE_MS).catch(() => {})
      }
      centreRequests = []
      await withDeadline(fs.setDoc(fs.doc(db, 'centre_requests', id), request), JOIN_DEADLINE_MS)
      centreRequests = [{ id, communityId: c.id, communityName: c.name, status: 'pending', at: Date.now() }]
      onb.status = chrome('onb.centre.asked', { centre: c.name })
    } catch (err) {
      console.warn('[centre] could not send the join request:', err?.code || err?.message)
      onb.status = chrome('onb.centre.failed')
    }
    syncCentreLink()
    renderOnboarding()
    announceOnb(onb.status)
  }

  async function cancelCentreRequest(req) {
    if (!req || !usingFirestore) return false
    // The brightest button on the chat screen while a request waits, and easy
    // to tap by accident.
    if (!confirm(chrome('centre.confirmCancel', { centre: req.communityName }))) return false
    try {
      // The manager may have answered while the app was open. Cancelling an
      // approved request would delete the record of it and leave the link,
      // with the senior believing they had withdrawn.
      const now = await fs.getDoc(fs.doc(db, 'centre_requests', req.id))
      if (now.exists() && now.data()?.status !== 'pending') {
        await refreshCentreState()
        return false
      }
      await fs.deleteDoc(fs.doc(db, 'centre_requests', req.id))
      centreRequests = centreRequests.filter(x => x.id !== req.id)
      onb.status = ''
      syncCentreLink()
      if (onb.open) renderOnboarding()
      showToast(chrome('centre.cancelled'))
      return true
    } catch (err) {
      console.warn('[centre] could not cancel the join request:', err?.code || err?.message)
      showToast(chrome('onb.centre.failed'))
      return false
    }
  }

  // What the app knows can be stale: the manager approves in profile.html
  // while the senior's app is open. Requests are read again, and the record's
  // centre link with them, when the app comes back to the screen and before
  // anything acts on them.
  async function refreshCentreState() {
    if (!usingFirestore || !isResident()) return
    await loadCentreRequests()
    const r = getSelected()
    if (r) await refreshResidentLink(r)
    syncCentreLink()
    if (onb.open) renderOnboarding()
  }

  async function refreshResidentLink(r) {
    if (!usingFirestore || !r?.id) return
    try {
      const snap = await fs.getDoc(fs.doc(db, 'residents', r.id))
      if (!snap.exists()) return
      const d = snap.data() || {}
      Object.assign(r, { centreId: d.centreId || '', communityId: d.communityId || '', communityName: d.communityName || '' })
    } catch (err) {
      console.warn('[centre] could not re-read the centre link:', err?.code || err?.message)
    }
  }

  // Public, verified by the admin console, and with a manager.
  function joinableCentres() {
    return communities.filter(c => c.isPublic && c.verified && c.managerUid)
  }

  // ── The first visit ───────────────────────────────────────────
  // A new senior used to be dropped straight into "How are you feeling
  // today?" with nothing explained (audits/P3-senior-feedback.md, item 1).
  // Now the first visit is a short welcome: language, what to call them, what
  // they enjoy, their family, their centre, how the app works — then a first
  // greeting that uses what they said. Every step can be skipped, and skipping
  // counts as done. The same screen, with only the centre step, is how the
  // card on the chat screen asks a centre later.
  const ONB_KEY = 'techable_onboarded_'
  const ONB_STEPS = ['lang', 'name', 'interests', 'family', 'centre', 'how']
  const ONB_TITLES = { lang: 'onb.lang.title', name: 'onb.name.title', interests: 'onb.int.title',
    family: 'onb.fam.title', centre: 'onb.centre.title', how: 'onb.how.title' }
  const ONB_LANGS = [['en', 'English'], ['cmn', '普通話 · Mandarin'], ['yue', '廣東話 · Cantonese']]
  const ONB_INTERESTS = [['gardening', '🌱'], ['cooking', '🍳'], ['music', '🎵'], ['mahjong', '🀄'], ['walking', '🚶'],
    ['reading', '📚'], ['tv', '📺'], ['faith', '🙏'], ['crafts', '🧶'], ['pets', '🐾']]
  const ONB_FAMILY = [['children', '👪'], ['grandchildren', '🧒'], ['spouse', '💑'], ['siblings', '🧑‍🤝‍🧑'], ['friends', '🤝'], ['pet', '🐕']]
  let onb = { open: false }

  function shouldOnboard() {
    const r = getSelected()
    if (!isResident() || !r || selfLoadFailed || r.onboardedAt) return false
    try { if (localStorage.getItem(ONB_KEY + r.id)) return false } catch (_) {}
    // Someone who has used the app before this welcome existed has no
    // onboardedAt either. "I would like to get to know you" is the wrong thing
    // to say to them; the centre card still offers to join a centre.
    if (usedBefore(r)) return false
    return true
  }

  function usedBefore(r) {
    return Boolean(r.preferredName || (r.memories || []).length || (r.lifeStory || []).length ||
      r.centreId || getSessions(r.id).length)
  }

  // What a visit opens on: the welcome the first time, the chat after that.
  // The chat is opened underneath first, so finishing lands there; its
  // greeting waits for the welcome to close.
  function startVisit() {
    switchTab(isResident() ? 'conversation' : 'dashboard')
    if (shouldOnboard()) openOnboarding('full')
  }

  function openOnboarding(mode) {
    const r = getSelected()
    if (!r) return
    const preset = communities.find(c => c.isPublic && !r.centreId && c.name === r.communityName)
    onb = {
      open: true,
      mode,
      step: mode === 'centre' ? 'centre' : 'lang',
      name: speakableName(r) || givenName(accountRealName()),
      langChosen: false,
      interests: [],
      intMore: '',
      family: [],
      famNames: '',
      findable: false,
      centre: preset?.id || '',
      filter: '',
      status: ''
    }
    renderOnboarding()
  }

  function onbSteps() {
    return onb.mode === 'centre' ? ['centre'] : ONB_STEPS
  }

  const pressed = on => `aria-pressed="${on ? 'true' : 'false'}"`

  function onbTiles(list, act, chosen, labelKey) {
    return `<div class="onb-grid">${list.map(([key, icon]) => `
      <button type="button" class="onb-tile" data-act="${act}" data-value="${key}" ${pressed(chosen.includes(key))}>
        <span class="onb-tile-main"><span aria-hidden="true">${icon}</span> ${esc(chrome(labelKey + key))}</span>
      </button>`).join('')}</div>`
  }

  function onbField(id, field, label, value) {
    return `
      <div class="onb-field">
        <label for="${id}">${esc(chrome(label))}</label>
        <input class="onb-input" id="${id}" type="text" maxlength="200" data-field="${field}" value="${esc(value)}" autocomplete="off" />
      </div>`
  }

  function onbCentreList() {
    const q = onb.filter.trim().toLowerCase()
    return joinableCentres()
      .filter(c => !q || [c.name, c.city, c.country].join(' ').toLowerCase().includes(q))
      .map(c => `
        <button type="button" class="onb-tile" data-act="centre" data-value="${esc(c.id)}" ${pressed(onb.centre === c.id)}>
          <span class="onb-tile-main">${esc(c.name)}</span>
          ${c.city || c.country ? `<span class="onb-tile-sub">${esc([c.city, c.country].filter(Boolean).join(', '))}</span>` : ''}
        </button>`).join('')
  }

  function onbCentreHTML() {
    const r = getSelected()
    if (r?.centreId) {
      const centre = communities.find(c => c.id === r.communityId)
      return `<p class="onb-text">${esc(chrome('onb.centre.member', { centre: centre?.name || r.communityName }))}</p>`
    }
    const pending = centreRequests.find(x => x.status === 'pending')
    let html = ''
    if (pending) {
      // Just asked: the confirmation under the button already says so.
      if (!onb.status) html += `<p class="onb-text onb-strong">${esc(chrome('onb.centre.pending', { centre: pending.communityName }))}</p>`
      html += `<div><button type="button" class="btn btn-s onb-btn" data-act="cancel">${esc(chrome('onb.centre.cancel'))}</button></div>`
    }
    if (!joinableCentres().length) {
      return html + `<p class="onb-text">${esc(chrome('onb.centre.none'))}</p>`
    }
    if (joinableCentres().length > 6) html += onbField('onb-centre-filter', 'filter', 'onb.centre.search', onb.filter)
    return html + `
      <div class="onb-grid onb-list" id="onb-centre-list">${onbCentreList()}</div>
      <div><button type="button" class="btn btn-p onb-btn" data-act="ask">${esc(chrome('onb.centre.ask'))}</button></div>`
  }

  function onbStepHTML(step) {
    if (step === 'lang') {
      const code = langCode()
      return `<p class="onb-text">${esc(chrome('onb.welcome'))}</p>
        <div class="onb-grid onb-list">${ONB_LANGS.map(([c, label]) => `
          <button type="button" class="onb-tile" data-act="lang" data-value="${c}" ${pressed(code === c)} lang="${{ cmn: 'zh-CN', yue: 'zh-HK' }[c] || 'en'}">
            <span class="onb-tile-main">${esc(label)}</span>
          </button>`).join('')}</div>`
    }
    if (step === 'name') {
      return onbField('onb-name', 'name', 'onb.name.label', onb.name) + `<p class="onb-hint">${esc(chrome('onb.name.hint'))}</p>`
    }
    if (step === 'interests') {
      return `<p class="onb-hint">${esc(chrome('onb.int.hint'))}</p>` + onbTiles(ONB_INTERESTS, 'interest', onb.interests, 'onb.int.') +
        onbField('onb-int-more', 'intMore', 'onb.int.more', onb.intMore)
    }
    if (step === 'family') {
      return `<p class="onb-hint">${esc(chrome('onb.fam.hint'))}</p>` + onbTiles(ONB_FAMILY, 'family', onb.family, 'onb.fam.') +
        onbField('onb-fam-names', 'famNames', 'onb.fam.names', onb.famNames) +
        // "Let my family find me" (F32, finding 3): off until they say so.
        (usingFirestore ? `
        <div class="onb-grid onb-list">
          <button type="button" class="onb-tile" data-act="findable" ${pressed(onb.findable)}>
            <span class="onb-tile-main"><span aria-hidden="true">🔎</span> ${esc(chrome('onb.find'))}</span>
            <span class="onb-tile-sub">${esc(chrome('onb.find.hint'))}</span>
          </button>
        </div>` : '')
    }
    if (step === 'centre') return onbCentreHTML()
    return `<ul class="onb-how">${[['🎙', 1], ['💾', 2], ['📖', 3], ['💌', 4]].map(([icon, n]) =>
      `<li><span aria-hidden="true">${icon}</span><span>${esc(chrome('onb.how.' + n))}</span></li>`).join('')}</ul>`
  }

  function renderOnboarding() {
    const box = $('onboarding')
    if (!box) return
    box.hidden = !onb.open
    if (!onb.open) return
    const steps = onbSteps()
    const i = Math.max(0, steps.indexOf(onb.step))
    const last = i === steps.length - 1
    const had = onb.focused === onb.step ? onbFocusKey(box) : null
    const stepLine = $('onb-step')
    if (stepLine) stepLine.textContent = steps.length > 1 ? chrome('onb.step', { n: i + 1, total: steps.length }) : ''
    $('onb-title').textContent = chrome(ONB_TITLES[onb.step])
    $('onb-body').innerHTML = onbStepHTML(onb.step)
    const button = (act, key, cls) => `<button type="button" class="btn ${cls} onb-btn" data-act="${act}">${esc(chrome(key))}</button>`
    $('onb-actions').innerHTML =
      (i > 0 ? button('back', 'onb.back', 'btn-s') : '') +
      (onb.mode === 'full' && !last ? button('skipAll', 'onb.skipAll', 'onb-skip') : '') +
      (onb.mode === 'centre' ? button('close', 'onb.done', 'btn-p onb-next')
        : last ? button('finish', 'onb.start', 'btn-p onb-next') : button('next', 'onb.next', 'btn-p onb-next'))

    if (!box.onbWired) {
      box.onbWired = true
      box.addEventListener('click', ev => {
        const btn = ev.target?.closest?.('[data-act]')
        if (btn && box.contains(btn)) onbAct(btn.dataset.act, btn.dataset.value)
      })
      box.addEventListener('input', ev => {
        const field = ev.target?.dataset?.field
        if (field) onbAct(field, ev.target.value)
      })
      box.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && ev.target?.dataset?.field && ev.target.dataset.field !== 'filter') { ev.preventDefault(); onbAct('next') }
      })
    }
    // A new step is announced by its question, which takes the focus — only a
    // new step: a tap on a tile redraws the step, and moving focus then would
    // throw a keyboard or screen-reader user back to the top every time.
    if (onb.focused !== onb.step) {
      onb.focused = onb.step
      $('onb-title')?.focus?.()
      announceOnb(onb.step === 'centre' ? onb.status : '')
    } else if (had) {
      // The tiles were rebuilt under the focus, which would otherwise drop out
      // of the dialog to the page behind it: back to the same control, or to
      // the question when that control is gone (Cancel, once cancelled).
      ;(box.querySelector?.(had) || $('onb-title'))?.focus?.()
    }
  }

  // A selector for the control in the welcome that has the focus, if any.
  const cssEsc = s => (window.CSS?.escape ? CSS.escape(s) : String(s))
  function onbFocusKey(box) {
    const el = document.activeElement
    if (!el || el === document.body || !box.contains?.(el)) return null
    if (el.id) return '#' + cssEsc(el.id)
    const act = el.dataset?.act
    if (!act) return null
    return `[data-act="${cssEsc(act)}"]` + (el.dataset.value ? `[data-value="${cssEsc(el.dataset.value)}"]` : '')
  }

  // The welcome's status line lives outside the redrawn body, so a message
  // put in it is announced rather than drawn in place with the rest.
  function announceOnb(text) {
    const line = $('onb-status')
    if (line) line.textContent = text || ''
  }

  async function onbAct(act, value) {
    const toggle = (list, key) => (list.includes(key) ? list.filter(k => k !== key) : [...list, key])
    const steps = onbSteps()
    const i = steps.indexOf(onb.step)
    switch (act) {
      case 'lang': {
        const r = getSelected()
        if (!r) return
        r.language = window.TechableI18n?.normalise(value) || 'en'
        onb.langChosen = true
        syncLanguage()
        break
      }
      // Typing: kept as it goes, without redrawing under the cursor.
      case 'name': onb.name = String(value ?? ''); return
      case 'intMore': onb.intMore = String(value ?? ''); return
      case 'famNames': onb.famNames = String(value ?? ''); return
      case 'filter': {
        onb.filter = String(value ?? '')
        const list = $('onb-centre-list')
        if (list) list.innerHTML = onbCentreList()
        return
      }
      case 'interest': onb.interests = toggle(onb.interests, value); break
      case 'family': onb.family = toggle(onb.family, value); break
      case 'findable': onb.findable = !onb.findable; break
      case 'centre': onb.centre = value; onb.status = ''; announceOnb(''); break
      case 'ask': return askToJoin()
      case 'cancel': return cancelCentreRequest(centreRequests.find(x => x.status === 'pending'))
      case 'back': if (i > 0) onb.step = steps[i - 1]; break
      case 'next':
        if (i >= steps.length - 1) return onb.mode === 'centre' ? closeOnboarding() : finishOnboarding()
        onb.step = steps[i + 1]
        break
      case 'finish': return finishOnboarding()
      case 'skipAll': return skipOnboarding()
      case 'close': return closeOnboarding()
      default: return
    }
    renderOnboarding()
  }

  // What they said goes on their own record, and the welcome is marked done
  // there and on this device. If the rules do not know onboardedAt yet (the
  // site went live before them), the answers are saved without it rather than
  // lost, and this device remembers not to ask again.
  //
  // Done here first and saved after: offline, a Firestore write does not
  // settle until the server answers, and "Start chatting" must not sit there
  // doing nothing while it waits.
  function saveOnboarding(patch) {
    const r = getSelected()
    if (!r) return Promise.resolve()
    const done = nowIso()
    Object.assign(r, patch, { onboardedAt: done })
    if (!usingFirestore) persistLocalResidents()
    try { localStorage.setItem(ONB_KEY + r.id, done) } catch (_) {}
    syncLanguage()
    renderProfile()
    renderMems()
    return saveOnboardingRemote(r, patch)
  }

  async function saveOnboardingRemote(r, patch) {
    if (usingFirestore && !selfLoadFailed) {
      const ref = fs.doc(db, 'residents', r.id)
      try {
        await fs.setDoc(ref, { ...patch, onboardedAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() }, { merge: true })
      } catch (err) {
        console.warn('[onboarding] could not save with onboardedAt:', err?.code || err?.message)
        // And without findable: rules from before either refuse both, and
        // what they said matters more than the switch, which waits on its own.
        const { findable, ...answers } = patch
        if (Object.keys(answers).length) {
          try {
            await fs.setDoc(ref, { ...answers, updatedAt: fs.serverTimestamp() }, { merge: true })
          } catch (err2) {
            console.warn('[onboarding] could not save the answers:', err2?.code || err2?.message)
            showToast(chrome('onb.saveFailed'))
          }
        }
      }
    }
  }

  async function finishOnboarding() {
    const r = getSelected()
    if (!r) return closeOnboarding()
    const patch = {}
    const name = onb.name.trim().slice(0, 200)
    if (name) {
      patch.preferredName = name
      if (!r.name) patch.name = name
    }
    if (onb.langChosen) patch.language = r.language
    // Kept in the same shapes the companion learns them in, so the starters
    // and the prompt read them like any other memory.
    const said = [
      ...onb.interests.map(k => ({ text: chrome('onb.int.' + k + '.mem'), tag: 'hobby' })),
      { text: onb.intMore.trim().slice(0, 200), tag: 'hobby' },
      ...onb.family.map(k => ({ text: chrome('onb.fam.' + k + '.mem'), tag: 'family' })),
      { text: onb.famNames.trim().slice(0, 200), tag: 'family' }
    ]
    const seen = new Set((r.memories || []).map(m => norm(m.text)))
    const added = said.filter(m => m.text && !seen.has(norm(m.text)))
      .map(m => ({ id: cryptoId(), text: m.text, tag: m.tag, createdAt: nowIso() }))
    if (added.length) patch.memories = [...(r.memories || []), ...added]
    // Asked in the family step: findable only if they said so. Then the
    // directory follows, once the record says it.
    if (usingFirestore) patch.findable = onb.findable === true
    const interest = onb.interests[0] ? chrome('onb.int.' + onb.interests[0] + '.topic') : ''
    const saving = saveOnboarding(patch).then(() => ensureSeniorLinkDirectory(r))
    closeOnboarding({ welcome: interest || true })
    return saving
  }

  async function skipOnboarding() {
    // A language they chose before skipping is still the one they chose.
    const r = getSelected()
    const saving = saveOnboarding(onb.langChosen && r ? { language: r.language } : {})
    closeOnboarding()
    return saving
  }

  function closeOnboarding(opts = {}) {
    onb.open = false
    onb.focused = null
    renderOnboarding()
    syncCentreLink()
    if (activeTab !== 'conversation') switchTab('conversation')
    if (opts.welcome) {
      newSession({ greet: false })
      greet({ welcome: opts.welcome })
    } else if (!currentMessages.length && getSelected()) {
      greet({ offerGame: shouldOfferGame() })
    }
    // Back where the conversation is, on the one way to talk — not the text
    // box, which would pull a phone's keyboard up over the greeting.
    $('talk-btn')?.focus?.()
  }

  // ── The tell: which voice spoke this reply ──────────────────────
  // Reported: "it takes a while to speak the first five or so, and afterwards
  // it reads them out instantly." Both halves were the same fault, and neither
  // half is visible: the app falls back silently by design, so a spent quota, a
  // slow network and a browser refusing to play audio all look identical from
  // the sofa. Answering it took a console, a key, and a person who knew what to
  // look for.
  //
  // Off by default, and deliberately so — a caption under every reply is
  // clutter for the person this app is actually for. ?voicetell=1 turns it on
  // and it is remembered, because what it explains only shows up several
  // replies into a visit, which is too late to go and switch something on.
  const VOICE_TELL_KEY = 'techable_voice_tell'

  // Kept BESIDE the transcript, never inside it. Hanging the report on the
  // message object itself was the obvious way to do this and quietly wrong:
  // sessionObj carries `messages: currentMessages` straight into localStorage
  // and Firestore, and into the body of every /api/chat request. Each AI turn
  // would have been saved with a second copy of its own text plus timings —
  // roughly double the size — and writeCapped() sheds the oldest transcripts
  // when storage fills. A diagnostic nobody asked for would have halved how
  // much history a senior keeps.
  //
  // Keyed on the message object rather than its index, so nothing has to be
  // renumbered when the transcript is cleared or a session is loaded over it.
  const spokenBy = new WeakMap()

  function voiceTellOn() {
    try { return localStorage.getItem(VOICE_TELL_KEY) === 'on' } catch (_) { return false }
  }

  function setVoiceTell(on) {
    try { localStorage.setItem(VOICE_TELL_KEY, on ? 'on' : 'off') } catch (_) {}
    renderChat(false)
    return voiceTellOn()
  }

  // ?voicetell=1 to switch it on, ?voicetell=0 to switch it back off. Absent
  // leaves whatever was set last, so the URL is a switch and not a mode.
  function readVoiceTellParam() {
    let p = null
    try { p = new URLSearchParams(location.search).get('voicetell') } catch (_) { return }
    if (p === null) return
    setVoiceTell(!/^(0|off|no|false)$/i.test(p))
  }

  // One line in the same plain language as the rest of the app: who spoke, how
  // long the senior waited to hear it, and — when it was not the good voice —
  // what pushed it off. "Device voice (Microsoft Zira) — neural quota spent" is
  // the whole diagnosis of the original report, in a place it cannot be missed.
  function voiceTellText(info) {
    if (!info) return ''
    const took = Number.isFinite(info.ms)
      ? (info.ms >= 100 ? `${(info.ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(info.ms))}ms`)
      : ''
    const after = took ? ` · ${took} to the first word` : ''

    if (info.engine === 'neural') {
      // A cached piece asked the engine for nothing, so its timing says nothing
      // about the engine. Saying "0.0s" there would read as the good voice being
      // instant, which is the exact misreading this whole thing exists to stop.
      return info.cached ? '🎙️ neural voice · made in advance' : `🎙️ neural voice${after}`
    }
    if (info.engine === 'device') {
      return `💻 device voice${info.voice ? ` (${info.voice})` : ''}`
        + (info.why ? ` — ${info.why}` : '') + after
    }
    if (info.engine === 'held') return '⏸ held until the screen is touched'
    return `🔇 not spoken — ${info.why || 'no voice available'}`
  }

  // The line just spoken is the most recent reply whose text matches it. Both
  // the chat and the check-in push the message first and speak it after, and
  // the same prompt can be said more than once in a visit, so this runs
  // backwards and stops at the first match.
  function noteSpokenBy(info) {
    if (!info?.text) return
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i]
      if (m.role !== 'ai' || Voice.clean(m.text) !== info.text) continue
      spokenBy.set(m, info)
      // Patched in place rather than re-rendered. The tell lands seconds after
      // the reply did, and renderChat scrolls to the bottom — which would jerk
      // the chat out from under someone who had started reading back through it.
      const node = $('chat-win')?.querySelector(`.chat-msg[data-i="${i}"] .msg-voice`)
      if (node) node.textContent = voiceTellText(info)
      return
    }
  }

  function renderChat(reset) {
    const win = $('chat-win')
    const r = getSelected()
    if (!win) return

    if (reset || !currentMessages.length) {
      currentMessages = []
      // Deliberately empty when someone is selected. This used to print
      // "Hi. I'm ready to talk with Jessica Wang." — the app talking ABOUT the
      // senior in the third person, by their full name, in a bubble that was
      // never a message and so was never read aloud. The companion's own
      // greeting lands here a moment later as a real turn; see greet().
      win.innerHTML = r
        ? ''
        : '<div class="chat-empty-s"><div class="ce">💬</div><p>Select an elderly profile to start chatting.</p></div>'
      renderStarters()
      return
    }

    // The empty tell node is rendered up front when the tell is on, so the
    // report that arrives a few seconds later has somewhere to land without a
    // re-render. CSS hides it while it is empty.
    const tell = voiceTellOn()
    // A family message opened in the chat carries its recording or photo
    // under the companion's line (see presentNote()).
    win.innerHTML = currentMessages.map((m, i) => `
      <div class="chat-msg ${m.role === 'user' ? 'user' : 'ai'}" data-i="${i}"${m.note ? ` data-note="${esc(m.note.id)}"` : ''}>
        <div class="msg-bubble">${esc(m.text)}</div>
        ${m.note && m.note.kind !== 'text' ? noteMediaHTML(m.note.id, m.note.kind, m.note.who) : ''}
        ${m.role === 'ai' && tell ? `<div class="msg-voice">${esc(voiceTellText(spokenBy.get(m)))}</div>` : ''}
      </div>`).join('') + (conversationEnded ? `
      <div class="chat-end" role="note">
        <span class="chat-end-note">${esc(chrome('chat.ended'))}</span>
        <button class="btn btn-p chat-again" type="button" onclick="startNewChat()">${esc(chrome('chat.again'))}</button>
      </div>` : '')

    // The starters first: showing or hiding them resizes the window, and
    // scrolling before that left a greeting cut off at its first line with
    // its question out of sight under the tiles.
    renderStarters()
    win.scrollTop = win.scrollHeight
    // A photo has no height until it has decoded; scroll again once it has,
    // or it sits under the fold with only its top edge showing.
    win.querySelectorAll?.('img.msg-photo').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => { win.scrollTop = win.scrollHeight }, { once: true })
    })
  }

  // Everything the AI is told about who it is talking to.
  //
  // This is deliberately wider than the resident record. It also carries the
  // signed-in account profile and a digest of earlier conversations, because a
  // companion that starts cold every session cannot say anything better than
  // "tell me more about that". Previously only the resident row and its
  // memories were sent, so the model had nothing to be specific about.
  //
  // Internal centre notes (r.notes) are deliberately NOT sent — they are staff
  // notes about the person, not context to speak back to them.
  // Where this person actually is, for the weather lookup. The resident record
  // only stores a community *name*, so resolve it against the loaded
  // communities to get city/country. Falls back to the bare name, which
  // OpenWeather can often still resolve.
  function residentLocation(r) {
    const byId = communities.find(c => c.id && c.id === r?.communityId)
    const byName = communities.find(c =>
      (c.name || '').toLowerCase() === (r?.communityName || '').toLowerCase())
    const c = byId || byName
    return {
      city: c?.city || r?.communityName || '',
      country: c?.country || '',
      place: c?.name || r?.communityName || ''
    }
  }

  function residentContext() {
    const r = getSelected()
    const sessions = r ? getSessions(r.id) : []
    const checkIns = r ? getCheckIns(r.id) : []
    const hour = new Date().getHours()

    return {
      name: r?.name || '',
      preferredName: r?.preferredName || '',
      age: r?.age || '',
      room: r?.room || '',
      communityName: r?.communityName || '',
      background: r?.background || '',
      family: r?.family || '',
      medical: r?.medical || '',
      location: residentLocation(r),
      // Just the code. api/chat.js owns the wording of the instruction it
      // turns into, so a tampered client cannot inject prompt text here.
      // Sent for ordinary chat too, not only the check-in: a conversation that
      // opened in Cantonese must not switch to English the moment the scripted
      // part ends and the model takes over.
      language: window.TechableI18n?.code?.() || 'en',
      memories: (r?.memories || []).slice(0, 40).map(m => ({ text: m.text, tag: m.tag })),

      // The signed-in account profile. For a resident using their own login
      // this is the person themselves; for a manager it is the staff member
      // driving the conversation on a resident's behalf.
      account: {
        displayName: userDoc?.displayName || authUser?.displayName || '',
        communityName: userDoc?.communityName || '',
        bio: userDoc?.bio || '',
        speakingRole: isManager() ? 'community_manager' : 'resident'
      },

      // Cross-session memory: what was talked about on previous days, and the
      // senior's own words from the last conversation.
      previousConversations: sessions.slice(0, 4).map(s => ({
        when: relativeDay(s.savedAt),
        topics: s.topicsDiscussed || [],
        checkInMood: s.checkIn?.moodLabel || null,
        theySaid: (s.messages || [])
          .filter(m => m.role === 'user' && m.text)
          .slice(-2)
          .map(m => m.text.slice(0, 160))
      })),

      recentCheckIns: checkIns.slice(0, 3).map(c => ({
        when: relativeDay(c.savedAt),
        mood: c.moodLabel || null,
        about: c.reasonLabel || null,
        concerns: c.concerns || []
      })),

      now: {
        partOfDay: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
        weekday: new Date().toLocaleDateString(undefined, { weekday: 'long' })
      }
    }
  }

  // "today" / "yesterday" / "3 days ago" reads far more naturally back to the
  // senior than an ISO timestamp, and keeps the model from inventing dates.
  function relativeDay(iso) {
    const then = new Date(iso || 0)
    if (!then.getTime()) return 'earlier'
    const days = Math.floor((Date.now() - then.getTime()) / 86400000)
    if (days <= 0) return 'earlier today'
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    if (days < 14) return 'last week'
    return `${Math.floor(days / 7)} weeks ago`
  }

  // ── Offline replies ────────────────────────────────────────────
  // Used only when the AI cannot be reached: no key, a timeout, an outage.
  //
  // The version before this is what a new senior met in testing (audits/
  // P3-senior-feedback.md, item 2), and every complaint about it was fair:
  //
  //   "I am not good at all today"  → "That sounds like a good moment. What
  //     made it special?" — it looked for happy words with no idea what "not"
  //     does to them;
  //   "my neighbour was rude to me" → "Your neighbour sounds important to you."
  //     — any relative at all got the same warm line;
  //   "nothing" / "I don't know"    → "What has today been like for you?" and
  //     "What is on your mind right now?", alternating for ever, because those
  //     were the last-resort pool and nothing ever let a chat end.
  //
  // Now it reads the sentence with the same ordered, negation-aware patterns
  // the check-in uses; names what was said in the senior's own words where it
  // can ("I am sorry your son didn't call you"); asks one question at most;
  // never uses a line twice in one conversation; never asks about the day
  // once it has been talked about; and lets a quiet conversation rest — an
  // offer to stop after two short or "no" answers in a row, a goodbye after a
  // third (the caller counts them; see send()).
  const offline = { used: new Set(), seq: -1 }

  // Every line is available again in a new conversation.
  function offlineUsed() {
    if (offline.seq !== conversationSeq) {
      offline.used = new Set()
      offline.seq = conversationSeq
    }
    return offline.used
  }

  const pats = () => window.TechableI18n?.patterns?.() || {}
  const langCode = () => window.TechableI18n?.code?.() || 'en'

  // The mood words only — what the check-in itself reads a mood from.
  function primaryMood(text) {
    for (const m of (pats().mood || [])) if (m.re.test(text)) return m.key
    return null
  }

  // The mood a sentence carries, falling back to the softer "what happened"
  // lists ("she was rude", "my daughter visited").
  function moodOf(text) {
    const p = pats()
    const m = primaryMood(text)
    if (m) return m
    if (p.infer?.low?.test(text)) return 'low'
    if (p.infer?.good?.test(text)) return 'good'
    return null
  }

  // A bad thing that happened, with a person in it, which the mood words
  // alone miss: "my son didn't call me", "my sister forgot my birthday".
  const NEGATIVE_EVENT = /\b(did(n'?t| not)|does(n'?t| not)|has(n'?t| not)|have(n'?t| not)|won'?t|will not|never|no longer|forgot|ignored|left me|shouted|yelled|argued|fell out|passed away|died)\b/i

  // A word for how they feel, to say back to them ("you are feeling awful").
  const FEELING_EN = /\b(awful|terrible|horrible|dreadful|rotten|lousy|miserable|frustrated|annoyed|irritated|grumpy|cross|angry|upset|sad|lonely|worried|anxious|scared|frightened|nervous|stressed|fed up|unhappy|depressed|unwell|poorly)\b/i

  // English pronouns turned round so a clause can be said back: "didn't call
  // me" → "didn't call you". Whole words only; the two-word forms first so
  // "I am" becomes "you are", not "you am".
  const FLIP = [
    [/\bi was\b/gi, 'you were'], [/\bi am\b/gi, 'you are'], [/\bi'm\b/gi, "you're"],
    [/\bi've\b/gi, "you've"], [/\bi'll\b/gi, "you'll"], [/\bi'd\b/gi, "you'd"],
    [/\bmyself\b/gi, 'yourself'], [/\bmine\b/gi, 'yours'], [/\bmy\b/gi, 'your'],
    [/\bme\b/gi, 'you'], [/\bi\b/gi, 'you']
  ]

  function flipPronouns(s) {
    return FLIP.reduce((out, [re, to]) => out.replace(re, to), s)
  }

  // The clause a sentence opens with, before it wanders off.
  const firstClause = s => String(s).split(/[.!?;,]|\s(?:but|because|so|although|though)\s/i)[0]

  // "my neighbour was rude to me" → { who: 'neighbour', echo: 'your neighbour
  // was rude to you' }. The echo only where the person begins the clause: in
  // "I spoke to my friend Ann" the friend is not doing anything, and "your
  // friend Ann on the phone" is not something you can be sorry about. Other
  // languages name the person and leave the sentence alone.
  function personOf(text) {
    const p = pats()
    const said = String(text || '')
    if (!p.kin) return null
    if (langCode() !== 'en') {
      const m = said.match(p.kin)
      return m ? { who: m[1] || m[0], echo: null } : null
    }
    const subject = new RegExp('(?:^|[.!?;,]\\s*|\\b(?:and|but|because|so|well|oh|no|yes)\\s*,?\\s*)my\\s+' + p.kin.source + '([^.!?;,]*)', 'i')
    const m = said.match(subject)
    if (m) {
      const who = m[1].toLowerCase()
      const rest = firstClause(m[2]).trim()
      const words = rest.split(/\s+/).filter(Boolean)
      const echo = words.length && words.length <= 10 ? `your ${who} ${flipPronouns(rest)}` : null
      return { who, echo }
    }
    const any = said.match(new RegExp('\\bmy\\s+' + p.kin.source, 'i'))
    return any ? { who: any[1].toLowerCase(), echo: null } : null
  }

  // "I watched the television this morning" → "you watched the television
  // this morning". Something they did — not "I am…", "I feel…" or "I don't
  // know", which are feelings or answers and are read as those instead.
  function iEchoOf(text) {
    if (langCode() !== 'en') return null
    const m = String(text || '').trim().match(/^(?:(?:well|oh|yes|no|ok|okay|so)\s*,?\s+)?i\s+(?!am\b|'m\b|feel|felt\b|don'?t\b|do not\b|didn'?t\b|can'?t\b|cannot\b|haven'?t\b|have not\b|was\b|think\b|guess\b|suppose\b|know\b)(.+)$/i)
    if (!m) return null
    const rest = firstClause(m[1]).trim()
    const words = rest.split(/\s+/).filter(Boolean)
    if (words.length < 2 || words.length > 12) return null
    return 'you ' + flipPronouns(rest)
  }

  // What kind of answer this is. `disengaged` is the one that matters: "no",
  // "nothing", "I don't know", or a word or two that is not a yes — the
  // replies that, three in a row, mean they would rather not talk just now.
  function readAnswer(text) {
    const p = pats()
    const said = String(text || '').trim()
    const cjk = /[㐀-鿿豈-﫿]/.test(said)
    const size = cjk
      ? said.replace(/[\s，。！？、,.!?]/g, '').length
      : said.split(/\s+/).filter(Boolean).length
    const no = Boolean(p.no?.test(said))
    const yes = Boolean(p.yes?.test(said)) && !no
    const unsure = Boolean(p.unsure?.test(said))
    const mood = primaryMood(said)
    const strong = ['low', 'tired', 'good'].includes(mood)
    return {
      bye: Boolean(p.bye?.test(said)),
      yes, no, unsure,
      disengaged: !yes && !strong && (no || unsure || (cjk ? size <= 3 : size <= 2))
    }
  }

  // Has the senior already said how today is — in today's check-in, or in
  // this conversation? Then nobody asks about their day again.
  function dayDiscussedNow() {
    if (window.TechableCheckIn?.todayDone?.()) return true
    return currentMessages.some(m => m.role === 'user' && primaryMood(m.text))
  }

  // Something they told us before, said back as a subject to talk about —
  // "your gardening", "growing up in Ipoh". English memories only; anything
  // else is quoted as it was saved.
  function memoryTopic(text) {
    const t = String(text || '').trim().replace(/[.!]+$/, '')
    if (!t) return null
    if (langCode() !== 'en') return t
    let m
    if ((m = t.match(/^enjoys\s+(.+)$/i)))            return 'your ' + m[1]
    if ((m = t.match(/^grew up in\s+(.+)$/i)))        return 'growing up in ' + m[1]
    if ((m = t.match(/^has an?\s+(\w+)$/i)))          return 'your ' + m[1].toLowerCase()
    if ((m = t.match(/^(\w+) is called\s+(\w+)$/i)))  return m[2]
    if ((m = t.match(/^used to be (an?)\s+(.+)$/i)))  return jobRole(m[2]) ? `your days as ${m[1].toLowerCase()} ${m[2]}` : null
    return null
  }

  // A memory not yet brought up in this conversation, oldest-rotated first.
  function nextMemory(r, used) {
    const mems = (r?.memories || []).filter(m => m?.text && !garbledJob(m.text))
    for (let i = 0; i < mems.length; i++) {
      const mem = mems[(topicRotation + i) % mems.length]
      const key = 'mem:' + (mem.id || mem.text)
      if (!used.has(key)) return { mem, key }
    }
    return null
  }

  // Whether the line localReply() just chose ends the conversation.
  let localCloses = false

  function localReply(userText, signals = {}) {
    localCloses = false
    const r = getSelected()
    const name = speakableName(r) || ''
    // askAI() calls this without an argument, so fall back to the most recent
    // thing the person said rather than replying to nothing.
    const text = String(userText || [...currentMessages].reverse().find(m => m.role === 'user')?.text || '')
    const used = offlineUsed()
    const en = langCode() === 'en'
    const p = pats()
    const say = (key, vars) => chrome(key, { name, ...vars })
    // The first of these keys not yet used in this conversation, claimed.
    const pick = keys => {
      const key = keys.find(k => k && !used.has(k))
      if (key) used.add(key)
      return key || null
    }
    const close = key => { localCloses = true; return say(key) }

    if (signals.wrapUp && !signals.checkin) return close('chat.bye')

    const mood = signals.mood || moodOf(text)
    const read = readAnswer(text)
    const person = personOf(text)
    let k

    // A story being told for the life story book: stay with it.
    if (signals.storyChapter) {
      return (k = pick(['story.more.1', 'story.more.2', 'story.more.3'])) ? say(k) : say('story.go')
    }

    if (!signals.checkin) {
      // Not wanting to talk is an answer. Twice running, offer to stop.
      if ((signals.shortStreak || 0) >= 2) return (k = pick(['reply.offerStop'])) ? say(k) : close('chat.bye')
      if (read.disengaged && !['low', 'tired', 'good'].includes(mood)) {
        const next = nextMemory(r, used)
        const topic = next && memoryTopic(next.mem.text)
        if (topic && (k = pick(['reply.no.topic']))) { used.add(next.key); return say(k, { topic }) }
        if ((k = pick(['reply.no.plain']))) return say(k)
      }
    }

    // The body first: a pain is answered as a pain, once, with one nudge.
    if (p.concerns?.discomfort?.test(text) && (k = pick(['reply.pain']))) return say(k)
    if (p.concerns?.loneliness?.test(text) && (k = pick(['reply.lonely.1', 'reply.lonely.2']))) return say(k)

    const badEvent = Boolean(person && en && NEGATIVE_EVENT.test(text))
    if (mood === 'low' || (badEvent && mood !== 'good')) {
      if (person?.echo && (k = pick(['reply.low.echo']))) return say(k, { echo: person.echo })
      if (person && (k = pick(['reply.low.who']))) return say(k, { who: person.who })
      const feeling = en && (text.match(FEELING_EN) || [])[1]
      if (feeling && (k = pick(['reply.low.feeling']))) return say(k, { feeling: feeling.toLowerCase() })
      if ((k = pick(['reply.low.1', 'reply.low.2', 'reply.low.3']))) return say(k)
    }
    if (mood === 'tired' && (k = pick(['reply.tired.1', 'reply.tired.2']))) return say(k)
    if (mood === 'good') {
      if (person?.echo && (k = pick(['reply.good.echo']))) return say(k, { echo: person.echo })
      if (person && (k = pick(['reply.good.who']))) return say(k, { who: person.who })
      if ((k = pick(['reply.good.1', 'reply.good.2']))) return say(k)
    }
    if (person && (k = pick(['reply.who']))) return say(k, { who: person.who })
    if (/\b(remember|used to|years ago|when i was|back then|as a (child|girl|boy|kid))\b/i.test(text) ||
        /(以前|记得|記得|小时候|小時候|細個|当年|當年)/.test(text)) {
      if ((k = pick(['reply.remember']))) return say(k)
    }
    const echo = iEchoOf(text)
    if (echo && (k = pick(['reply.i.1', 'reply.i.2', 'reply.i.3']))) return say(k, { echo })

    // The check-in has its own closing lines; it only wants a reply that is
    // about what was said.
    if (signals.checkin) return null

    // Something they told us before, while there is something left to raise.
    const next = nextMemory(r, used)
    if (next) { used.add(next.key); return say('reply.memory', { mem: next.mem.text }) }

    const open = ['reply.open.1', 'reply.open.2', 'reply.open.3', 'reply.open.4']
    if (!signals.dayDiscussed && !dayDiscussedNow()) open.unshift('reply.open.day')
    if ((k = pick(open))) return say(k)

    // Every line has been said once. Rather than go round again, let it rest.
    return close('reply.rest')
  }

  // Preferred path: POST the full conversation to our serverless proxy, which
  // holds the API key. Falls back to a canned local reply. Sends conversation
  // history so the AI has memory of the session — previously only the latest
  // message was sent.
  // Why the last AI attempt fell back to the local reply. Every failure used to
  // be swallowed silently, so a broken API key or a bad model name looked
  // exactly like normal operation — the app just quietly answered "I hear you,
  // tell me more about that" forever with the badge still reading "Gemini" (as
  // it then was).
  let lastAIError = null

  // Warned once per page load. The canned fallback is deliberately written to
  // sound like the companion, which means a broken key reads as "the AI is not
  // very clever" rather than "the AI never ran" — the exact confusion that
  // wasted a demo. Say it out loud, on screen, once.
  let aiWarnShown = false

  // "OPENAI_API is not set on the server" means something to whoever runs
  // the deployment and nothing to the senior it was shown to, right under the
  // conversation. They are told, once and in plain words, that the answers may
  // be simpler for a while; the reason stays in the console and, for staff,
  // on screen.
  function aiFailed(reason) {
    lastAIError = reason
    console.warn('[Techable] AI unavailable → local reply. Reason:', reason)
    setBadge()
    if (!aiWarnShown) {
      aiWarnShown = true
      showToast(isResident() ? chrome('ai.offline') : '⚠ AI offline — using basic replies. ' + reason)
    }
    const status = $('status-line')
    if (status) status.textContent = isResident() ? chrome('ai.offline.short') : 'AI offline — basic replies'
    return reason
  }

  // The senior's own deadline for the main reply. api/chat.js gives itself 25
  // seconds, and the platform cuts in before that — but neither of them bounds
  // a request that stalls on a flaky home connection and never reaches the
  // server at all, and the browser will sit on one of those for minutes.
  // That is not just a long wait. send() holds `sending` true until this
  // settles, so the Send button stays greyed out, Enter does nothing, and
  // every spoken answer is swallowed by the one-turn guard: the companion goes
  // quiet and there is no way back in for the rest of the visit. Nine seconds
  // is longer than a good reply takes and short enough to sit through; past it
  // the offline replies take over, and the senior is told that is what they
  // are reading.
  const CHAT_DEADLINE_MS = 9000

  // Whether the last reply askAI() handed back ends the conversation — only
  // ever true for an offline line, which knows when it has run out of things
  // to say (see localReply()). A model reply ends it when it was asked to.
  let lastReplyCloses = false

  // `signals` — counted here, because a model cannot count its own turns
  // reliably: the run of short or "no" answers, whether this is the moment to
  // wrap up, and whether today has already been talked about. api/chat.js
  // turns them into instructions, and accepts only the right types.
  async function askAI(mode, signals = {}) {
    const cfg = window.TECHABLE_CONFIG || {}
    lastReplyCloses = false

    // The check-in has its own fallback that acknowledges the mood and concern
    // the senior just reported. Returning the generic canned chat line here
    // would override it with something blander, so hand back null instead and
    // let checkin.js word the closing reply.
    const noAI = () => {
      if (mode === 'checkin') return null
      const text = localReply(undefined, signals)
      lastReplyCloses = localCloses
      return text
    }

    if (cfg.aiMode === 'local') {
      aiFailed('aiMode is set to "local" in config')
      return noAI()
    }

    // 1) Server proxy (production). Never exposes the key.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), CHAT_DEADLINE_MS)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          resident: residentContext(),
          messages: currentMessages,
          mode: mode || 'chat',
          topicRun,
          topicLabel: currentTopicLabel(),
          nextTopics: suggestNextTopics(),
          shortStreak: signals.shortStreak || 0,
          wrapUp: signals.wrapUp === true,
          dayDiscussed: signals.dayDiscussed === true,
          // Which life story chapter is being told, if one is; a key only.
          storyChapter: STORY_CHAPTERS.includes(signals.storyChapter) ? signals.storyChapter : undefined
        })
      })

      const json = await res.json().catch(() => ({}))

      if (res.ok && json && json.text) {
        lastAIError = null
        setBadge()
        return json.text
      }

      if (json && json.aiEnabled === false) {
        aiFailed('OPENAI_API is not set on the server')
        return noAI()
      } else if (!res.ok) {
        // Surface what the proxy actually said — a 502 here almost always means
        // the upstream model rejected the request (bad key, wrong model name,
        // quota) and that detail is the difference between a 5-minute fix and
        // an afternoon of guessing.
        aiFailed(`/api/chat returned ${res.status}${json?.error ? ` — ${json.error}` : ''}${json?.reason ? ` (${json.reason})` : ''}`)
      } else {
        aiFailed('/api/chat returned no text')
      }
    } catch (err) {
      aiFailed(err?.name === 'AbortError'
        ? `/api/chat did not answer within ${Math.round(CHAT_DEADLINE_MS / 1000)}s`
        : `could not reach /api/chat (${err?.message || 'network error'})`)
    } finally {
      clearTimeout(timer)
    }

    // 2) Offline / no AI configured.
    return noAI()
  }

  // ── Understanding what was said ───────────────────────────────
  // Second opinion for the check-in's reader, asked only when its pattern
  // lists came back with nothing — see api/understand.js for why. The common
  // case never gets here, so this costs nothing on nearly every turn.
  //
  // Three things keep it from becoming a new way for the app to be slow or
  // broken:
  //
  //   `understandOff` latches on the answers that will never change — no key
  //   configured, or the endpoint is not deployed at all. One request finds
  //   that out; the rest of the visit skips it.
  //
  //   The deadline is here as well as on the server, because a fetch that
  //   never resolves never reaches the server's timeout. A senior is watching
  //   a silent screen while this runs, and past a couple of seconds the old
  //   "I did not quite catch that" is genuinely the better answer.
  //
  //   Every failure returns null, which puts the caller back on exactly the
  //   path it took before this existed.
  let understandOff = false
  const UNDERSTAND_DEADLINE_MS = 2500

  async function understand(text) {
    const say = String(text || '').trim()
    if (!say || understandOff) return null

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), UNDERSTAND_DEADLINE_MS)

    try {
      const res = await fetch('/api/understand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ text: say, lang: window.TechableI18n?.code?.() || 'en' })
      })

      // Not deployed, or deployed somewhere that will not take a POST. None of
      // these change within a visit, and each one costs the senior a wait in
      // silence before falling back to the line we were falling back to
      // anyway. 501 is here because it is what a plain static file server
      // answers — which is exactly what this is running against in local
      // development, and how this case was found.
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        understandOff = true
        return null
      }

      const json = await res.json().catch(() => null)
      if (json?.aiEnabled === false) { understandOff = true; return null }
      if (!res.ok || !json || typeof json !== 'object') return null

      // The server already whitelists these. Checked again because this is the
      // value that indexes into MOODS on the other side, and a null there is
      // handled while a stray string is not.
      const MOOD_KEYS = ['good', 'okay', 'low', 'tired']
      return {
        mood: MOOD_KEYS.includes(json.mood) ? json.mood : null,
        tone: json.tone === 'positive' || json.tone === 'negative' ? json.tone : null,
        gaveReason: json.gaveReason === true,
        concerns: Array.isArray(json.concerns) ? json.concerns.slice(0, 4) : [],
        confidence: json.confidence === 'high' ? 'high' : 'low'
      }
    } catch (err) {
      // Includes the abort. Deliberately quiet: this is a best-effort second
      // look, and the caller has a working answer without it.
      console.debug?.('[Techable] understand unavailable:', err?.message || err)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Voice output (text-to-speech) ─────────────────────────────
  // Two engines behind one speak() call, best first:
  //
  //   1. /api/tts — Google Cloud neural voices. This is what makes the
  //      companion sound like a person. It is also the only path that speaks
  //      Cantonese at all on most devices: Windows and Android ship no yue-HK
  //      voice, so the local engine either refuses or hands the sentence to an
  //      English voice, which produces noise rather than speech.
  //
  //   2. window.speechSynthesis — the OS voice. Always there, needs no key,
  //      works offline. Robotic on Windows, decent on iOS/macOS, and good on
  //      Edge where the "Natural" online voices are installed — hence the
  //      ranking in pickLocalVoice() rather than taking whatever comes first.
  //
  // The fallback is silent and one-way: the first failed cloud request turns
  // the network path off for the session, so a project without the Cloud TTS
  // API enabled costs one request, not a stutter before every sentence.
  const Voice = {
    key: 'techable_voice_pref',
    cloud: null,        // null = untried, true = working, false = use local
    audio: null,        // element currently playing cloud audio
    fetching: new Set(),// in-flight /api/tts requests, so stop() can abandon them
    turn: 0,            // bumped by stop(); playback from an older turn is dropped
    cache: new Map(),   // text → object URL. The check-in repeats its prompts.
    rates: new Map(),   // text → playbackRate, for engines with no rate control
    inflight: new Map(),// text → in-flight promise, so a prefetch is never fetched twice
    strikes: 0,         // consecutive cloud failures; three in a row gives up
    warmed: false,      // whether /api/tts has been woken this session
    audioDone: null,    // resolver for the sentence playing now, so stop() releases it
    coolOffUntil: 0,    // rate-limited until this time; not the same as broken
    startedAt: 0,       // when the line now being spoken was asked for
    spoken: null,       // what became of it: which voice, how long, and why
    onSpoke: null,      // told about that, so it can be put on screen

    enabled() { return localStorage.getItem(this.key) !== 'off' },
    supported() { return 'speechSynthesis' in window || 'Audio' in window },

    // Whether the neural voice is worth asking for at all right now. Two
    // separate reasons not to, and keeping them apart is the point: `cloud ===
    // false` is permanent for this visit (no key, or three failures in a row),
    // while a cool-off is a quota that will refill. Treating the second as the
    // first is how one busy minute cost the good voice for the rest of the day.
    cloudReady() {
      return this.cloud !== false && Date.now() >= this.coolOffUntil
    },

    // The quota is spent and the server has said for how long. Asking again
    // inside that window cannot succeed — it can only put another failed round
    // trip in front of the next thing the companion says. Deliberately not a
    // strike: the voice is not broken, it is rationed, and it should come back
    // by itself.
    coolOff(seconds) {
      const ms = Math.min(3600, Math.max(5, Number(seconds) || 60)) * 1000
      this.coolOffUntil = Date.now() + ms
      console.warn(`[Techable] neural voice rate-limited — the device voice will speak for the next ${Math.round(ms / 1000)}s`)
    },

    // ── Which voice actually spoke ──────────────────────────────
    // "It takes a while to speak the message, and then afterwards it is
    // instant" was not one thing getting better. It was two different voices,
    // and the only way to tell them apart was by ear.
    //
    // Every fallback below is deliberately silent — that is what a fallback is
    // for — which also means nobody watching can tell a spent quota from a slow
    // network from a browser refusing to play audio. All three sound like the
    // companion changing person partway through a visit.
    //
    // So each line now records who spoke it, how long the senior waited for the
    // first word, and what pushed it off the neural voice. It is reported to a
    // listener rather than logged, because the answer belongs beside the reply
    // it is about and not in a console nobody has open.
    announce(engine, extra) {
      const info = { engine, at: Date.now(), ...(extra || {}) }
      this.spoken = info
      try { this.onSpoke?.(info) } catch (_) {}
      return info
    },

    // Why the neural voice is not being asked for at all this time. Three
    // reasons that are identical from the sofa and completely different
    // underneath: a deployment with no key, a voice that failed often enough to
    // stop trying, and a quota that lifts by itself. Only the last one is worth
    // waiting for, and only the first is worth changing anything about.
    whyLocal(cfg) {
      if (!(cfg || {}).ttsEnabled) return 'no neural voice configured'
      if (this.cloud === false) return 'neural voice gave up for this visit'
      const left = this.coolOffUntil - Date.now()
      if (left > 0) return `neural quota spent, ${Math.ceil(left / 1000)}s left`
      return null
    },

    // Emoji, asterisks and URLs are written for the eye. Read aloud they
    // become "sparkles", "asterisk" or a spelled-out address in the middle of
    // a sentence — a large part of why the voice sounded like a machine
    // reading a document rather than someone talking.
    clean(text) {
      let s = String(text || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[*_`#>|~]/g, '')
      try { s = s.replace(/[\p{Extended_Pictographic}️‍]/gu, '') } catch (_) {}
      return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
    },

    // Rank the installed voices instead of taking the first match. The gap
    // between "Microsoft Zira" and "Microsoft Sonia Online (Natural)" is the
    // whole complaint, and both are present on the same Windows machine.
    //
    // Accent outranks everything else, and that is not a matter of taste. This
    // used to score on name and quality alone, so on an iPhone or a Mac — where
    // Karen (en-AU), Tessa (en-ZA), Moira (en-IE) and Samantha (en-US) are all
    // plain local voices that tie on every other term — the winner was decided
    // by whichever order the OS happened to list them in. That is how a
    // companion set to American English kept answering in an Australian accent.
    // voiceCandidates() already returns exact-locale matches first; the sort
    // below has to preserve that rather than shuffle it away.
    pickLocalVoice() {
      const all = window.speechSynthesis?.getVoices?.() || []
      if (!all.length) return null

      const i18n = window.TechableI18n
      // Only voices that actually speak the resident's language are eligible.
      // Everything else is worse than not speaking.
      const pool = i18n?.voiceCandidates
        ? i18n.voiceCandidates(all)
        : all.filter(v => /^en([-_]|$)/i.test(v.lang || ''))
      if (!pool.length) return null

      // The tag the app asked for, e.g. en-US. A voice carrying it is the right
      // accent by definition; one that only shares the language is a fallback,
      // and a top-quality fallback is still the wrong person speaking.
      const want = String(i18n?.speechLang?.() || 'en-US').toLowerCase()
      const tagOf = v => String(v.lang || '').toLowerCase().replace(/_/g, '-')

      const score = v => {
        const name = String(v.name || '')
        let s = 0
        // Worth more than any single quality term, so the right accent wins
        // every tie and beats a better-sounding voice of the same generation —
        // but not a whole class better. A robotic American voice losing to a
        // natural British one is the earlier complaint, and still the right
        // call; losing to an Australian voice of its own generation was not.
        if (tagOf(v) === want) s += 80
        if (/natural|neural|premium|enhanced|siri/i.test(name)) s += 60
        if (/online/i.test(name)) s += 25
        if (/google|wavenet/i.test(name)) s += 20
        if (v.localService === false) s += 10       // network voices are the newer ones
        if (/desktop|espeak|compact|pico/i.test(name)) s -= 40
        if (/zira|david|mark|hazel|george/i.test(name)) s -= 25   // the SAPI5 relics
        // Warmth, by voice character rather than by name. The old list spelled
        // out particular voices — and half of them (Karen, Tessa, Sonia, Libby)
        // belong to accents the app had not asked for, so it was quietly
        // bidding against the locale it had just chosen.
        if (/female/i.test(name)) s += 8
        if (v.default) s += 2
        return s
      }

      // Stable within a score band, so the exact-tag order voiceCandidates()
      // established is what survives a tie.
      return pool
        .map((v, i) => ({ v, i, s: score(v) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)[0]?.v || null
    },

    // The local engine reads a long block in one flat line, and Chrome cuts
    // utterances off after roughly fifteen seconds. Speaking sentence by
    // sentence fixes both: real pauses at full stops, and no truncation.
    // The cloud path is NOT chunked — a neural voice phrases across sentences
    // by itself, and splitting it would throw that away.
    sentences(text) {
      const out = []
      let buf = ''
      const WORDY = /[a-zA-Z0-9À-ɏ㐀-鿿]/
      // A full stop after one of these is not the end of a sentence. The bare
      // single letter covers initials — "J. K. Chan" is one name, not three
      // sentences.
      const ABBR = /(^|\s)(mr|mrs|ms|miss|dr|prof|sr|jr|st|rev|hon|etc|[a-z])$/i

      const flush = () => {
        const t = buf.trim()
        buf = ''
        if (!t) return
        // Trailing punctuation on its own ("?!") belongs to what came before,
        // not to a chunk of its own that the voice would pause around.
        if (out.length && !WORDY.test(t)) { out[out.length - 1] += t; return }
        out.push(t)
      }

      for (const ch of text) {
        buf += ch
        // CJK stops are unambiguous and CJK sentences are short. Any minimum
        // length here — an obvious-looking guard against splitting "Dr." —
        // leaves a whole Cantonese reply as one unbroken block instead.
        if (/[。！？；!?…]/.test(ch)) { flush(); continue }
        if (ch === '.') {
          const before = buf.slice(0, -1)
          if (/\d$/.test(before) || ABBR.test(before)) continue   // 3.5, Dr., J.
          flush(); continue
        }
        // A sentence long enough to be read as one breath gets a break at the
        // next comma regardless.
        if (buf.length >= 200 && /[,;、，\s]/.test(ch)) flush()
      }
      flush()
      return out.length ? out : [text]
    },

    // ── Before the page has been touched ────────────────────────
    // No browser will play audio until the user has interacted with the page,
    // and the companion's first line is the one most likely to arrive before
    // that has happened — it is spoken the moment the chat opens. A refused
    // line used to be simply gone, so a senior could be met by silence at the
    // exact moment the app was supposed to be talking to them.
    //
    // greet() had its own answer to this and the check-in did not, which is why
    // "How are you feeling today?" was the line that went missing. It lives
    // here now, so every caller gets it.
    //
    // Only the latest held line is kept: if the conversation has moved on, what
    // matters is the last thing said, not the first.
    gestured: false,
    pending: null,

    unlock() {
      if (this.gestured) return
      this.gestured = true
      this.warm()
      const held = this.pending
      this.pending = null
      // Out of the event handler, so a tap on the send button is not competing
      // with its own click handler for the audio device.
      if (held) setTimeout(() => this.speak(held.text, held.onDone), 0)
    },

    // onDone fires when the sentence has finished playing — the voice check-in
    // uses it to reopen the microphone, so the senior can just answer back
    // instead of pressing anything. It is also called when speech is off or
    // unsupported, so a hands-free flow still advances.
    speak(text, onDone) {
      const done = typeof onDone === 'function' ? onDone : null
      const say = this.clean(text)
      if (!this.supported() || !this.enabled() || !say) { if (done) setTimeout(done, 0); return }

      this.stop()

      // Held, not spoken and not dropped. Deliberately before any request is
      // made: synthesising audio the browser is going to refuse costs the wait
      // twice over, once now and again after the first touch.
      if (!this.gestured) {
        this.pending = { text: say, onDone: done }
        this.announce('held', { text: say, why: 'waiting for the screen to be touched' })
        return
      }

      const turn = this.turn
      const finish = () => { if (turn === this.turn && done) done() }
      // The wait a senior actually experiences starts here — at the touch, for
      // a line that was held — and ends when they hear the first word.
      this.startedAt = Date.now()

      const cfg = window.TECHABLE_CONFIG || {}
      if (this.cloudReady() && cfg.ttsEnabled) {
        this.speakCloud(say, turn, finish, why => this.speakLocal(say, turn, finish, why))
      } else {
        this.speakLocal(say, turn, finish, this.whyLocal(cfg))
      }
    },

    // ── When the first word is late ─────────────────────────────
    // A working neural engine takes about as long to make a line as the line
    // takes to speak, so a short opener is a second or two. Beyond that it is
    // not the engine being slow, it is the engine being in trouble — a spent
    // quota, a hung connection, a function that never woke — and the senior is
    // sitting in front of a reply that has appeared on screen and is not being
    // read to them.
    //
    // Waiting it out cost far more than the wait itself: fetchOrRetry asks
    // twice, so a request that hung until the server's own timeout was two of
    // those, one after the other, before the operating system's voice said a
    // single word. Reported as "it takes a while to speak the message", and
    // then as the opposite once three of them had retired the neural voice and
    // every later reply came back instantly in a worse one.
    //
    // So the opening piece gets a deadline, scaled the way the engine's own
    // latency scales. Under it, the wait buys a much better voice and is worth
    // paying. Over it, nothing is coming that is worth this silence, and the OS
    // voice takes the whole reply.
    //
    // Only the opener. Every piece behind it is made while the one in front is
    // still being spoken, so it has the length of a sentence in hand already.
    //
    // The per-character figure is deliberately generous, and the asymmetry is
    // the reason. Too generous costs a few extra seconds on a connection that
    // has hung — rare, and the request that has reached the server is bounded
    // by timeoutFor() there anyway. Too tight abandons audio that was about to
    // arrive, on every long reply, for ever: the senior gets the robotic voice
    // on a perfectly good day AND the abandoned request still spends a unit of
    // a small daily quota. So when in doubt, wait.
    //
    // Nine seconds was in doubt and got it wrong. Speech runs about 11
    // characters a second at the rate this app asks for, and this engine takes
    // roughly as long to make speech as the speech lasts — so ~90ms a
    // character, which was more than the old budget allowed past 100
    // characters. Openers are not capped at 110: lead() hands back the whole
    // reply when it is one sentence however long, and otherwise fills the
    // opener until it passes LEAD_HEAD, which a single long first sentence
    // overshoots on its own.
    //
    // That ~90ms is an estimate from the README's own description of the
    // engine, not something measured — the quota was spent when this was
    // written and no successful call could be timed. Which is the other reason
    // to sit above it rather than below.
    FIRST_WORD_MS: 2500,        // a round trip and a function waking up
    FIRST_WORD_PER_CHAR: 90,    // and the synthesis itself, which tracks length
    // Deliberately the SAME ceiling /api/tts uses, not a lower one.
    //
    // Both budgets grow at 90ms a character and differ only in their base
    // (2500 here, 5000 there), so the client is the tighter of the two right up
    // until they both hit this ceiling — from about 195 characters on, they are
    // equal and either may fire first. LEAD_CHUNK is 200, so that is the
    // ordinary case for every piece after the opener rather than an edge of the
    // range, and it is worth being explicit that it is harmless: noteFailure()
    // exempts on `tooSlow`, and BOTH endings set it — the client's own deadline
    // directly, and the server's 504 through `json.timedOut || status === 504`.
    // Whichever lands first, a slow reply is never counted as a broken engine.
    //
    // Lowering this to restore a strict ordering was tried and reverted: the
    // budget has to stay above what the engine actually needs for the longest
    // opener lead() will hand it (200 characters x 90ms = 18000), or the app
    // starts abandoning audio that was about to arrive — which costs the good
    // voice on a perfectly good day AND still spends the quota. voice.test.mjs
    // asserts that headroom directly, and caught the attempt.
    FIRST_WORD_MAX: 20000,

    // ── Measuring the engine instead of guessing at it ──────────
    // Everything above was reasoned from the README's description of the
    // engine, because the quota was spent when it was written and no successful
    // call could be timed. It has been a guess ever since, and a deliberately
    // generous one — which is the right way to be wrong, but still wrong: a
    // 110-character reply that hangs leaves the senior in silence for twelve
    // seconds before the device voice says a word.
    //
    // Every successful neural reply now times itself, so after a few of them
    // the engine's real rate is known and the guess is not needed.
    //
    // Only ever downwards. The budget's job is to be generous enough never to
    // abandon audio that was about to arrive, so a measurement is allowed to
    // shorten the wait and never to lengthen it past the figure that has been
    // in use all along. The floor is there for the same reason: a run of quick
    // replies must not talk it down to nothing and then cut off the first long
    // one on a slower minute.
    MIN_SAMPLES: 3,             // one fast reply is not a measurement
    HEADROOM: 2,                // twice the slowest we have seen is still quick
    FLOOR_PER_CHAR: 25,         // never tighter than this, however fast today is
    samples: [],                // ms per character, newest last

    // `ms` is the whole wait the senior experienced, which is what the budget
    // covers too — so the fixed part is taken back out before the rest is
    // charged to the characters. A reply that beat the base costs zero per
    // character rather than a negative rate.
    note(ms, chars) {
      if (!(chars > 0) || !Number.isFinite(ms)) return
      this.samples.push(Math.max(0, ms - this.FIRST_WORD_MS) / chars)
      if (this.samples.length > 20) this.samples.shift()
    },

    // The slow end of what has actually been seen, not the average: the budget
    // is a promise about the worst case, and an average one would break it on
    // every reply above the middle.
    perChar() {
      if (this.samples.length < this.MIN_SAMPLES) return this.FIRST_WORD_PER_CHAR
      const sorted = [...this.samples].sort((a, b) => a - b)
      const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
      return Math.min(this.FIRST_WORD_PER_CHAR, Math.max(this.FLOOR_PER_CHAR, p90 * this.HEADROOM))
    },

    firstWordBudget(text) {
      const n = String(text || '').length
      return Math.min(this.FIRST_WORD_MAX, this.FIRST_WORD_MS + n * this.perChar())
    },

    // Resolves with whatever `p` gives, or with a marked Error at the deadline.
    // The request itself is left running rather than abandoned: it is already
    // paid for, and it lands in the cache where a repeat of the line can use it.
    deadline(p, ms) {
      return new Promise(resolve => {
        let settled = false
        const finish = v => { if (!settled) { settled = true; resolve(v) } }
        const timer = setTimeout(() => {
          const late = new Error('tts-too-slow')
          late.tooSlow = true
          finish(late)
        }, ms)
        const land = v => { clearTimeout(timer); finish(v) }
        Promise.resolve(p).then(land, land)
      })
    },

    // What a failed request says about the neural voice, which is not the same
    // question as what it says about this sentence.
    //   - rate-limited: the server told us how long. Stop asking until then,
    //     and do not count it — a rationed voice is not a broken one.
    //   - never arrived: the request may still be in the air, so it says
    //     nothing either way yet. speakCloud waits for it off to the side.
    //   - anything else: a strike, three of which give up for the visit.
    noteFailure(err) {
      if (!err || err.name === 'AbortError' || err.message === 'tts-disabled') return
      // A duration is the server saying the trouble is upstream and temporary.
      // Stop asking until it lifts, and do not count it — rationed is not
      // broken. Deliberately keyed on the duration and not on retryable: a
      // timed-out utterance is not worth retrying either, and taking that as a
      // reason to stand down for a minute would hand a whole minute of the
      // conversation to the device's voice over one slow request.
      if (err.retryAfter) { this.coolOff(err.retryAfter); return }
      if (err.tooSlow) return
      this.strike()
    },

    // ── Time to the first word ──────────────────────────────────
    // A neural engine takes roughly as long to make a piece of speech as the
    // speech lasts. So the wait before the first word is set by the length of
    // the FIRST request and nothing else — a whole paragraph in one request
    // meant the senior watched the text land and then sat in silence for the
    // length of the paragraph before hearing any of it.
    //
    // The reply is cut into a short opener and larger pieces behind it. The
    // opener is small enough to arrive quickly, and every later piece is made
    // while the one in front of it is still being spoken, so the wait is paid
    // once at the start instead of before every sentence.
    //
    // Short replies stay whole. A neural voice phrases across sentences, and
    // cutting a two-line answer costs more in rhythm than the fraction of a
    // second it saves.
    // These three numbers are the whole of the wait before the first word.
    // speakCloud() starts the opener and the piece behind it in the same tick,
    // so nothing except the OPENER's own length is between the senior and
    // hearing something — every later piece is being made while the one in
    // front of it is still playing.
    //
    // Both of the first two were set too generously, and the complaint that
    // came back was the plain one: several seconds of silence between the
    // reply appearing on screen and the companion starting to read it.
    //
    //   LEAD_MIN was 110. A reply of 110 characters went as ONE request, so
    //   the senior waited for the whole thing to be synthesised before hearing
    //   any of it — and 110 characters is a perfectly ordinary two-sentence
    //   reply, not a long one. "That sounds like a hard day. Is there anything
    //   I can do?" is 56, and was waited for whole.
    //
    //   45 is where it sits now, and the number is a trade against quota
    //   rather than against rhythm: splitting a short reply costs a second
    //   request out of a small daily allowance, and running that allowance
    //   down is what retires the neural voice for the rest of the visit. Below
    //   45 is one short sentence — "Good morning, Annie." — where there is
    //   nothing to split and nothing to gain.
    //
    //   LEAD_HEAD was 40. It is a floor, not a cap: lead() adds whole
    //   sentences until it is passed, so 40 routinely produced a 60–90
    //   character opener. 26 usually stops at the first sentence, which is
    //   what it was always meant to be.
    //
    // Neither can go much lower. The opener has to be long enough to still be
    // playing when the piece behind it arrives, or the seam becomes an audible
    // stall in the middle of a sentence — worse than the wait it saves. And
    // lead() never cuts inside a sentence, so a short first sentence is the
    // floor whatever these say.
    LEAD_MIN: 45,       // under this, one request is already quick enough
    LEAD_HEAD: 26,      // the opener still has to carry the pause after it
    LEAD_CHUNK: 200,    // every piece behind the opener

    lead(text) {
      const s = String(text || '')
      if (s.length <= this.LEAD_MIN) return [s]

      // Nowhere safe to cut — one sentence, however long — is left whole
      // rather than sliced mid-thought.
      const parts = this.sentences(s)
      if (parts.length < 2) return [s]

      const out = []
      let buf = ''
      const limit = () => (out.length ? this.LEAD_CHUNK : this.LEAD_HEAD)

      for (const p of parts) {
        buf = buf ? buf + ' ' + p : p
        if (buf.length >= limit()) { out.push(buf); buf = '' }
      }
      // Whatever is left over. Three trailing words are not worth a request of
      // their own — and worse, a request of their own is a seam the listener
      // hears, right at the end of the reply.
      if (buf) {
        if (out.length && buf.length < this.LEAD_HEAD) out[out.length - 1] += ' ' + buf
        else out.push(buf)
      }

      return out.length ? out : [s]
    },

    // Retry-After is allowed to be either a number of seconds or an HTTP date,
    // and a proxy in front of the function may well send the date form. Read
    // as a number that becomes NaN, which then reads as "no hint at all" — so
    // the request is retried immediately and counted against the neural voice.
    retryAfterHeader(r) {
      const raw = r?.headers?.get?.('Retry-After')
      if (!raw) return 0
      const secs = Number(raw)
      if (Number.isFinite(secs)) return secs > 0 ? secs : 0
      const at = Date.parse(raw)
      return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : 0
    },

    // One request per distinct line, shared by everyone who asks for it: the
    // check-in primes its next prompt while the senior is still answering the
    // last, and speaking it then costs nothing.
    fetchAudio(text, { abortable = true } = {}) {
      const lang = window.TechableI18n?.code?.() || 'en'
      const key = lang + '|' + text

      // `cached` matters to the caller: a hit asked the engine for nothing, so
      // it is not evidence that the engine has started working again.
      if (this.cache.has(key)) {
        return Promise.resolve({ url: this.cache.get(key), rate: this.rates.get(key) || 1, cached: true })
      }
      if (this.inflight.has(key)) return this.inflight.get(key)

      const ctrl = new AbortController()
      if (abortable) this.fetching.add(ctrl)

      const p = fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ text, lang })
      })
        .then(async r => {
          const json = await r.json().catch(() => null)

          // Two different failures, and conflating them was worth avoiding.
          // ttsEnabled:false means no key is configured — permanent, so stop
          // paying the round trip. Anything else (a safety block on one
          // sentence, a timeout, a retired voice) is this utterance only; the
          // next one should still get the good voice.
          if (json?.ttsEnabled === false) { this.cloud = false; throw new Error('tts-disabled') }
          if (!r.ok || !json?.audio) {
            const err = new Error('tts-failed')
            // How long to stay away, when the server knows. A spent quota comes
            // back with the number of seconds attached, and carrying it here is
            // what lets the caller stop asking instead of putting a refusal in
            // front of every sentence until it has given up entirely.
            // 429 always means "not now, later", whatever came back in the
            // body. An edge rate limiter or a platform error page answers with
            // no JSON and no hint, and reading only the body left those retried
            // immediately and counted against the neural voice — the exact pair
            // of mistakes this endpoint's own 429 was reshaped to stop. A minute
            // is the guess when nobody says.
            const after = Number(json?.retryAfter) || this.retryAfterHeader(r)
              || (r.status === 429 ? 60 : 0)

            // Two separate things, and collapsing them costs either a wait or a
            // voice. retryAfter is how long the trouble lasts; retryable is only
            // whether asking again right now could possibly work. A timed-out
            // utterance is the pair that shows why: not worth an immediate
            // second attempt (the wait was just paid in full) but no reason at
            // all to stop using the neural voice for the next minute.
            if (after > 0) err.retryAfter = after
            if (json?.retryable === false || after > 0) err.retryable = false
            // The server's own deadline. Marked the same way this client marks
            // the deadline it keeps itself, so noteFailure() exempts both in one
            // place: a request the engine was slow about says the engine is
            // slow, not that it is broken. Without this the exemption was
            // defeated by its own timing — the client gives up first, the 504
            // lands while the device voice is already speaking, and it was
            // counted. Three slow replies then retired the neural voice for the
            // whole visit. The status is read as well as the flag, so an older
            // deployment of /api/tts behaves the same way.
            if (json?.timedOut || r.status === 504) { err.tooSlow = true; err.atServer = true }
            throw err
          }

          const bytes = Uint8Array.from(atob(json.audio), c => c.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: json.mime || 'audio/mpeg' }))
          // OpenAI speech has no speaking-rate control, so the slowing an elderly
          // listener needs happens at playback. preservesPitch is the browser
          // default, so this does not turn the voice into a cartoon.
          const rate = json.rateApplied === false ? (json.rate || 0.92) : 1
          this.remember(key, url, rate)
          return { url, rate }
        })
        .finally(() => {
          this.inflight.delete(key)
          this.fetching.delete(ctrl)
        })

      this.inflight.set(key, p)
      return p
    },

    // One retry, because the alternative to retrying is the OS voice — a
    // different person finishing the conversation. A cold function or a single
    // 502 is worth a second attempt before it comes to that.
    async fetchOrRetry(text) {
      try {
        return await this.fetchAudio(text)
      } catch (err) {
        if (err?.message === 'tts-disabled' || err?.name === 'AbortError') throw err
        // A spent quota — or anything else the server has said is not worth
        // asking for again — will refuse identically a millisecond later. The
        // retry buys nothing and costs a second wait, which is heard as the
        // companion taking even longer to start speaking.
        if (err?.retryable === false) throw err
        // A request that ran out of time is the same case, and it was getting
        // through. /api/tts marks its OWN timeout retryable:false, but it never
        // gets to: the platform kills the invocation first and answers with a
        // bodiless error page, so there is no JSON to carry the flag and only
        // `tooSlow` — set from the bare 504 status — survives. The retry then
        // spent a second full platform budget, and the senior sat through both:
        // roughly twenty seconds of silence in front of a reply already on
        // screen. That is the exact failure the note above describes as fixed;
        // it was only ever fixed for the timeout the app itself reported.
        if (err?.tooSlow) throw err
        return await this.fetchAudio(text)
      }
    },

    // How far ahead of the piece being spoken to run. One is deliberate: the
    // next piece is always already being made, so there is no gap at a seam,
    // but no more of the reply is in the air at once than before — a new
    // OpenAI account's speech allowance is small, and a burst of five requests would
    // meet a rate limit halfway through a sentence.
    AHEAD: 1,

    async speakCloud(text, turn, done, fallback) {
      const chunks = this.lead(text)

      // Requests are started ahead of playback and awaited in order, which is
      // what plays them in order without making each one wait for the piece
      // before it to finish speaking.
      const pending = []
      const start = i => {
        if (i < chunks.length && !pending[i]) pending[i] = this.fetchOrRetry(chunks[i]).catch(err => err)
      }
      for (let i = 0; i <= this.AHEAD; i++) start(i)

      for (let i = 0; i < chunks.length; i++) {
        start(i)
        // Every piece is waited on in silence, not just the opener — for the
        // ones behind it the silence lands mid-reply, after the senior has
        // already been spoken to and while the microphone is still shut. Its
        // clock starts here, when the piece in front has finished playing, so
        // a piece that has been synthesising all along has already used most
        // of its budget up and passes straight through.
        const got = await this.deadline(pending[i], this.firstWordBudget(chunks[i]))
        if (turn !== this.turn) return       // stopped while we were waiting

        if (got instanceof Error) {
          // What this failure says about the engine is worth recording wherever
          // it happened. Only doing it for the opener meant a reply whose first
          // piece came from the cache — which is every reply, once prime() has
          // put the opening line there — failed silently on its second piece
          // and taught the client nothing, over and over.
          if (got.tooSlow) {
            // Still in the air. Whether that was the engine failing or merely
            // being slow is not known yet, and it is exactly what decides
            // whether it counts — so let it land in its own time rather than
            // guessing now. Not against a reply the senior has since stopped.
            pending[i].then(
              late => { if (late instanceof Error && turn === this.turn) this.noteFailure(late) },
              () => {})
          } else {
            this.noteFailure(got)
          }

          // Nothing has been said yet: the OS voice can still deliver the
          // line, which is better than silence even though it is not the
          // companion's voice.
          if (i === 0) return fallback(this.whyFailed(got))
          // Half of it is already spoken. Switching speaker mid-reply is worse
          // than stopping — the whole reply is on screen either way — but the
          // caller still has to be released below, or in a hands-free check-in
          // the microphone never reopens and the app looks dead.
          break
        }

        // A cache hit asked the engine for nothing, so it proves nothing about
        // whether the engine is working. Clearing the counters on one is how a
        // primed opener hid a spent quota completely: every reply played its
        // first piece from memory, wiped the record, then failed on the second.
        if (!got.cached) {
          this.cloud = true
          this.strikes = 0
          this.coolOffUntil = 0
        }

        // Queue the next piece before this one starts playing, so it is made
        // during the seconds the senior spends listening rather than after.
        start(i + this.AHEAD + 1)

        // The first piece starting to play is the moment the senior stops
        // waiting, so that is what the wait is measured to — not the moment the
        // audio arrived, and not the end of the reply.
        if (i === 0) {
          const ms = Date.now() - this.startedAt
          // A cache hit asked the engine for nothing, so it is not a timing of
          // the engine. Recording it would talk the budget down to the speed of
          // memory and then cut off the first reply that had to be made.
          if (!got.cached) this.note(ms, chunks[0].length)
          this.announce('neural', { text, ms, cached: Boolean(got.cached) })
        }

        const played = await this.play(got, turn)
        if (turn !== this.turn) return
        if (!played) {
          // No strike here. The audio arrived — what failed was playing it,
          // usually because the browser refused autoplay, and that says nothing
          // about whether the good voice is working. Counting it was a way to
          // lose the neural voice for the rest of the visit over a browser
          // policy, which the senior hears as the companion changing person.
          if (i === 0) return fallback('the browser would not play the audio')
          break
        }
      }

      done()
    },

    play(got, turn) {
      return new Promise(resolve => {
        // Checked before the element is told to play rather than after it. A
        // stale turn means the senior has already stopped this reply, and
        // starting it anyway leaves a sentence playing that nothing is left to
        // pause — the stop that would have paused it has been and gone.
        if (turn !== this.turn) return resolve(false)
        const a = new Audio(got.url)
        a.playbackRate = got.rate || 1
        this.audio = a

        let fired = false
        const once = ok => {
          if (fired) return
          fired = true
          this.audioDone = null
          resolve(ok)
        }
        // stop() pauses the element, which fires neither ended nor error.
        // Without this the caller would wait for a sentence that is never
        // going to finish, and the microphone would never reopen.
        this.audioDone = () => once(false)

        a.onended = () => once(true)
        a.onerror = () => once(false)
        // Autoplay can be refused before the page has been touched. That is a
        // reason to use the OS voice, not to give up on speaking.
        a.play().catch(() => once(false))
      })
    },

    // What a request that has just come back says, in the words someone
    // watching would use. whyLocal answers the same question about the state
    // before a request was made; this one answers it about a refusal in hand.
    whyFailed(err) {
      const waited = Math.max(0, Date.now() - this.startedAt)
      // Worth keeping apart on screen. One says the request reached /api/tts
      // and the engine did not answer inside its own budget; the other says
      // nothing came back to us in time and the request may still be in the
      // air. They point at different things to go and fix.
      if (err?.atServer) return 'neural voice timed out at the server'
      if (err?.tooSlow) return `neural voice too slow, gave up after ${(waited / 1000).toFixed(1)}s`
      if (err?.retryAfter) return `neural quota spent, ${Math.round(err.retryAfter)}s left`
      if (err?.message === 'tts-disabled') return 'no neural voice configured'
      if (err?.name === 'AbortError') return 'neural voice request was canceled'
      return 'neural voice request failed'
    },

    // One failed request is a blip: a safety block on a single sentence, a
    // cold function, a dropped connection. Treating it as proof the feature
    // was gone is what put the rest of the visit in the OS voice — a different
    // person, mid-conversation, permanently. Three in a row is a pattern.
    strike() {
      if (++this.strikes >= 3) this.cloud = false
    },

    // Wake the function before anyone is waiting on it. Its first call after
    // an idle spell takes seconds, and the first call is the greeting.
    //
    // Waking it once is not enough. A serverless function is put back to sleep
    // after a few idle minutes, and a visit is mostly idle minutes — the senior
    // reads a reply, thinks, answers. So the cold start lands on whichever
    // sentence they happen to be waiting for, again and again. The probe is a
    // GET: it reads two environment variables and synthesises nothing, so
    // keeping the function awake for as long as the app is open costs a request
    // that nobody is waiting on instead of seconds that somebody is.
    KEEP_WARM_MS: 240000,
    warmTimer: null,

    ping() {
      if (this.cloud === false || !this.enabled()) return
      // Only skip once the config has actually come back saying there is no
      // TTS. Undefined means it has not landed yet, and the first probe is the
      // one worth paying for — the greeting is right behind it.
      if ((window.TECHABLE_CONFIG || {}).ttsEnabled === false) return
      try { fetch('/api/tts', { method: 'GET' }).catch(() => {}) } catch (_) {}
    },

    warm() {
      if (this.warmed || this.cloud === false || !this.enabled()) return
      this.warmed = true
      this.ping()
      if (this.warmTimer || typeof document === 'undefined') return

      // A backgrounded tab is nobody waiting, and its timers are throttled
      // anyway. Coming back to it is the one moment the function is certainly
      // cold, so that is worth a probe of its own.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.ping() })
      this.warmTimer = setInterval(() => { if (!document.hidden) this.ping() }, this.KEEP_WARM_MS)
    },

    // Synthesise a line that is about to be needed. The check-in knows its
    // next prompt while the senior is still answering the current one, so the
    // wait for it can be spent instead of endured.
    prime(text) {
      const say = this.clean(text)
      if (!say || !this.cloudReady() || !this.enabled()) return
      if (!(window.TECHABLE_CONFIG || {}).ttsEnabled) return

      // The opener and nothing else. Every piece behind it is made while the
      // one in front of it is still being spoken, so priming those buys no time
      // at all — and it is not free. Each is a request against an allowance
      // worth about five replies a day, fired in a parallel burst that AHEAD
      // exists specifically to avoid, on a line that may never be said: a
      // greeting for a chat tab nobody opens, a question the conversation turns
      // away from. Priming the whole of a long line could spend a fifth of the
      // day's quota before the senior had heard a word.
      const [opener] = this.lead(say)
      if (!opener) return

      this.fetchAudio(opener, { abortable: false }).catch(err => {
        // A primed line is nobody's wait yet, so a plain failure here is not
        // held against the neural voice — that is why this used to swallow
        // everything. A refusal that says how long to stay away is different:
        // it is about the next line as much as this one, and learning it here
        // is the difference between the opening line being spoken at once and
        // it paying to find out. The opening line is the one primed first.
        if (err?.retryable === false || err?.retryAfter) this.coolOff(err.retryAfter)
      })
    },

    // Small and bounded: the check-in says the same handful of prompts every
    // day, so caching them removes both the latency and the cost of repeats.
    remember(key, url, rate) {
      this.cache.set(key, url)
      this.rates.set(key, rate || 1)
      while (this.cache.size > 40) {
        const oldest = this.cache.keys().next().value
        const stale = this.cache.get(oldest)
        // Never revoke what is playing right now — that silences the sentence
        // mid-word.
        if (stale && stale !== this.audio?.src) {
          try { URL.revokeObjectURL(stale) } catch (_) {}
        }
        this.cache.delete(oldest)
        this.rates.delete(oldest)
      }
    },

    speakLocal(text, turn, done, why) {
      if (!('speechSynthesis' in window)) {
        this.announce('none', { text, why: why || 'this browser cannot speak' })
        if (done) setTimeout(done, 0)
        return
      }
      const voice = this.pickLocalVoice()
      const code = window.TechableI18n?.code?.() || 'en'

      // No voice for this language on this device. Speaking it in an English
      // voice would be worse than silence — the reply is on screen either way,
      // and the caller still has to be released so the mic reopens.
      //
      // Silence here is a decision, not a failure, and it is the one case where
      // a listener has nothing at all to go on. Saying so is the difference
      // between "the app is broken" and "this machine has no Cantonese voice".
      if (!voice && code !== 'en') {
        this.announce('none', { text, why: `no ${code} voice installed on this device` })
        if (done) setTimeout(done, 0)
        return
      }

      // A natural voice keeps its rhythm when slowed a little; a robotic one
      // just drags, so the old blanket 0.85 made the bad voices sound worse.
      const natural = voice && /natural|neural|premium|enhanced|online|siri|google/i.test(voice.name || '')
      const parts = this.sentences(text)
      let i = 0

      const next = () => {
        if (turn !== this.turn) return
        if (i >= parts.length) { if (done) done(); return }
        const u = new SpeechSynthesisUtterance(parts[i++])
        u.rate = natural ? 0.94 : 0.85
        u.pitch = 1
        u.lang = window.TechableI18n?.speechLang?.() || 'en-US'
        if (voice) u.voice = voice

        let fired = false
        const once = () => {
          if (fired) return
          fired = true
          clearTimeout(guard)
          // A beat between sentences, the way a person breathes.
          setTimeout(next, 140)
        }
        u.onend = once
        u.onerror = once
        // Safety net: some browsers drop onend, which would leave the mic
        // closed and the check-in stuck waiting.
        const guard = setTimeout(once, Math.min(20000, 2500 + parts[i - 1].length * 90))

        try { window.speechSynthesis.speak(u) } catch (_) { once() }
      }

      // Not for a reply the senior has already stopped: the report would
      // overwrite the tell belonging to whatever is being spoken now.
      if (turn === this.turn) this.announce('device', {
        text,
        voice: voice?.name || 'browser default',
        ms: Date.now() - this.startedAt,
        why
      })

      try { window.speechSynthesis.cancel() } catch (_) {}
      next()
    },

    stop() {
      this.turn++
      // A line held for the first tap is still a line waiting to be spoken, and
      // stop() means the senior does not want to hear it any more.
      this.pending = null
      this.fetching.forEach(c => { try { c.abort() } catch (_) {} })
      this.fetching.clear()
      // Releases whoever is waiting on the current sentence to finish; without
      // it a stopped reply leaves the microphone shut. Prefetches are left
      // alone deliberately — they are for a line that has not been said yet.
      try { this.audioDone?.() } catch (_) {}
      if (this.audio) { try { this.audio.pause() } catch (_) {} this.audio = null }
      if ('speechSynthesis' in window) try { window.speechSynthesis.cancel() } catch (_) {}
    },
    // "Read replies aloud: On". This was a bare 🔊 that turned into 🔇, and a
    // senior trying the app had no way to tell what it was for. It is a
    // labelled switch now: the word, the knob and aria-checked all carry the
    // state, and its accessible name is the visible label itself.
    syncButton() {
      const btn = $('voice-btn')
      if (!btn) return
      if (!this.supported()) { btn.hidden = true; return }
      const on = this.enabled()
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-checked', on ? 'true' : 'false')
      const state = $('voice-state')
      if (state) state.textContent = chrome(on ? 'aloud.on' : 'aloud.off')
      const ico = $('voice-ico')
      if (ico) ico.textContent = on ? '🔊' : '🔇'
    }
  }

  function toggleVoice() {
    if (!Voice.supported()) return showToast('Voice output not supported in this browser')
    const next = Voice.enabled() ? 'off' : 'on'
    localStorage.setItem(Voice.key, next)
    if (next === 'off') Voice.stop()
    // Turning it on mid-visit has to wake the speech function too. warm() bails
    // when speech is off, so a senior who started with it off had never woken
    // it — and the cold start then landed on the first line they turned it on
    // to hear.
    else Voice.warm()
    Voice.syncButton()
    showToast(chrome(next === 'on' ? 'aloud.toast.on' : 'aloud.toast.off'))
  }

  // ── How the senior is talking ─────────────────────────────────
  // There is no mode to switch any more. The big "Tap to talk" button and the
  // text box are both always on screen, because a "Type instead / Talk
  // instead" link was one more thing to find and it duplicated the microphone
  // (audits/P3-senior-feedback.md, item 4).
  //
  // What is still worth knowing is how they spoke LAST, because it decides
  // whether the microphone reopens on its own after the companion answers.
  // Someone who has just talked expects to go on talking; someone who has just
  // typed does not want a microphone springing open under their fingers.
  //
  // Remembered, so a senior who talks keeps a hands-free conversation on the
  // next visit. A first visit starts as 'type' — nothing opens the microphone
  // until they have pressed the button once, because otherwise the very first
  // thing a new senior meets is the browser's microphone permission prompt.
  function speechInputSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function loadChatMode() {
    let saved = null
    try { saved = localStorage.getItem(CHAT_MODE_KEY) } catch (_) {}
    chatMode = saved === 'voice' && speechInputSupported() ? 'voice' : 'type'
    syncChatMode()
  }

  function setChatMode(mode) {
    chatMode = mode === 'voice' && speechInputSupported() ? 'voice' : 'type'
    try { localStorage.setItem(CHAT_MODE_KEY, chatMode) } catch (_) {}
  }

  // Nothing on the page calls this any more; kept for a cached old page.
  function toggleChatMode() {
    setChatMode(chatMode === 'voice' ? 'type' : 'voice')
  }

  // Where the browser cannot hear at all (Firefox, iOS outside Safari), the
  // one microphone is marked unavailable rather than left to do nothing.
  function syncChatMode() {
    const talk = $('talk-btn')
    if (talk && !speechInputSupported()) {
      talk.disabled = true
      talk.setAttribute('aria-disabled', 'true')
    }
  }

  // Set by every path that hands send() words the microphone heard, and read
  // (then cleared) by send() itself.
  let sendFromMic = false

  // In voice mode the microphone reopens on its own once the companion has
  // finished its sentence. A check-in is excluded: it drives its own listen
  // loop through say(), and doubling up would open the mic twice.
  function speakThenListen(text) {
    if (activeTab !== 'conversation') return
    const handsFree = chatMode === 'voice'
      && speechInputSupported()
      && activeTab === 'conversation'
      && !conversationEnded
      && !window.TechableCheckIn?.isActive?.()

    Voice.speak(text, handsFree ? () => { if (chatMode === 'voice') micListen() } : undefined)
  }

  // Greyed out while a reply is on its way, so the guard below is something
  // the person can SEE rather than a tap that silently does nothing. The
  // microphone is left alone on purpose — interrupting the companion by
  // starting to talk is how a conversation works, and micCommit() runs into
  // the same guard anyway.
  function setSendEnabled(on) {
    const btn = $('send-btn')
    if (!btn) return
    btn.disabled = !on
    btn.setAttribute('aria-disabled', on ? 'false' : 'true')
  }

  // ── One turn at a time ────────────────────────────────────────
  // Three separate things call send(): the Send button, Enter in the text box,
  // and micCommit() when the microphone falls quiet. Nothing stopped two of
  // them landing on the same sentence, and the reply takes seconds to come
  // back, so the window is wide open. Reported as the chat posting the same
  // line twice and answering it twice — which is what the screenshot showed:
  // two identical "I'm not feeling well" bubbles, two different replies to
  // them, and a senior reading an answer to a question they asked once.
  //
  // Two guards, because there are two ways in:
  //
  //   `sending` covers overlap — a second call while the first is still
  //   waiting on the AI. It has to be cleared in `finally`, or one failed
  //   turn would wedge the chat shut for the rest of the visit.
  //
  //   `lastSent` covers succession — the same words arriving again just after
  //   the first turn finished. Chrome's recogniser re-emits its last final
  //   result when `continuous` restarts, and a senior who does not hear the
  //   companion start will simply say it again; the first is a duplicate to
  //   swallow, and 2.5s is short enough that the second is not.
  let sending = false
  let lastSent = { text: '', at: 0 }
  const DUP_WINDOW_MS = 2500

  // Both guards refuse in silence, which is fine for a button the person can
  // see is greyed out and wrong for the microphone: micCommit() had already
  // read "Sending: <what was heard>" out to the screen reader before it called
  // send(). Somebody who answered again while the companion was still thinking
  // was told their words had gone, and they had been thrown away. Asking the
  // question separately is what lets the caption be true.
  function sendRefusal(text, spoken = false) {
    if (!getSelected() || !text) return 'nothing'
    if (sending) return 'busy'
    const context = window.TechableCheckIn?.answerContext?.() || ''
    const newTypedAnswer = !spoken && context && context !== lastSent.context
    if (!newTypedAnswer && text === lastSent.text && Date.now() - lastSent.at < DUP_WINDOW_MS) return 'duplicate'
    return ''
  }

  // What the microphone heard while the previous reply was still coming back.
  // Talking over the companion is how a conversation works rather than a
  // mistake, and in voice mode there is nowhere for those words to wait: the
  // text box and the Send button are both off screen, and reopening the mic
  // empties the box. During a check-in the sentence dropped that way is as
  // likely as not to be the disclosure, so it is held and sent the moment the
  // turn in flight lands.
  let pendingSpoken = ''

  function flushPendingSpoken() {
    if (!pendingSpoken) return
    const text = pendingSpoken
    pendingSpoken = ''
    micShow(text)
    sendFromMic = true
    send()
  }

  async function send() {
    const input = $('chat-input')
    const text = input?.value.trim()
    const spoken = sendFromMic
    sendFromMic = false

    const refusal = sendRefusal(text, spoken)
    if (refusal === 'duplicate') {
      // Still clear the box: the words are already in the transcript, and
      // leaving them sitting there reads as the message having failed.
      input.value = ''
      try { window.grow?.(input) } catch (_) {}
    }
    if (refusal) return refusal

    // A typed answer is an explicit recovery from a failed voice attempt.
    if (micError) { micError = ''; micUI(false) }

    // How they said it decides whether the microphone reopens after the
    // reply — see loadChatMode().
    setChatMode(spoken ? 'voice' : 'type')

    // The last chat was finished and saved. Speaking again starts the next
    // one rather than adding to a conversation that has already been put away.
    if (conversationEnded) newSession({ greet: false })

    sending = true
    lastSent = { text, at: Date.now(), context: window.TechableCheckIn?.answerContext?.() || '' }
    setSendEnabled(false)

    input.value = ''
    try { window.grow?.(input) } catch (_) {}
    currentMessages.push({ role: 'user', text, at: nowIso() })
    trackTopic(text)
    renderChat(false)

    const status = $('status-line')

    // Tell the user plainly when they are talking to the offline fallback
    // rather than the AI, instead of leaving the status line blank and the
    // replies mysteriously shallow.
    const settleStatus = () => {
      if (status) {
        status.textContent = !lastAIError ? ''
          : isResident() ? chrome('ai.offline.short') : `Offline replies — ${lastAIError}`
        status.style.color = lastAIError ? 'var(--rust)' : ''
      }
      updateSessionStats()
    }

    // Marks how far the transcript had got before we tried to answer, so the
    // error path can tell "nothing was said" from "something was already
    // said". Without it, a check-in turn that failed *after* replying got a
    // second, canned reply stacked on top — the person was answered twice.
    const turnStart = currentMessages.length
    // Whether this turn was an ordinary one, which is what a story said in
    // passing is looked for in — not a check-in answer, and not a story
    // already being kept by story mode.
    let ordinary = false

    try {
      if (status) status.textContent = 'Thinking…'

      // A running voice check-in owns the conversation: it decides whether
      // this answer is a mood, a yes/no to a guess, or something it should
      // hand straight to the AI, and it speaks its own replies. Routing here
      // keeps ONE input box for everything.
      if (window.TechableCheckIn?.isVoiceActive?.()) {
        // The check-in speaks and re-opens the mic itself, via its own say().
        pendingOffer = null
        await window.TechableCheckIn.handleUserText(text)
      } else if (storyMode && await storyTurn(text)) {
        // Kept in the life story and answered by storyTurn().
      } else if (!(pendingOffer && await answerOffer(text))) {
        ordinary = true
        // An ordinary turn. How it is going is counted here — see askAI().
        const read = readAnswer(text)
        // Chrome transcribed "that's all" correctly after the game, but
        // ordinary chat's narrower goodbye pattern sent it back to the model.
        // Match a complete stop phrase so "I finished painting" stays a story.
        const stopText = text.trim().replace(/[.!?。！？]+$/u, '').trim()
        const doneMatch = pats().done?.exec(stopText)
        const explicitDone = Boolean(doneMatch && doneMatch[0].trim() === stopText)
        // "No" to "shall we leave it there for today?" means keep going.
        if (offeredToStop && read.no && !read.bye) shortStreak = 0
        else shortStreak = read.disengaged ? shortStreak + 1 : 0
        const wrapUp = explicitDone || read.bye || shortStreak >= 3 || (offeredToStop && read.yes)
        offeredToStop = !wrapUp && shortStreak >= 2

        const reply = explicitDone ? chrome('chat.bye', { name: speakableName(getSelected()) || '' })
          : await askAI(undefined, { shortStreak, wrapUp, dayDiscussed: dayDiscussedNow() })
        const closes = wrapUp || lastReplyCloses
        currentMessages.push({ role: 'ai', text: reply, at: nowIso() })
        renderChat(false)
        // That reply was the one told to change the subject, so the new one
        // gets a fresh run of its own.
        topicRotated()
        if (closes) {
          // A goodbye is the end of the conversation, not a pause in it: said
          // without reopening the microphone, then saved and put away.
          Voice.speak(reply)
          await concludeConversation()
        } else {
          speakThenListen(reply)
        }
      }
    } catch (err) {
      console.warn('[Techable] reply failed:', err?.message || err)
      if (currentMessages.length === turnStart) {
        const reply = localReply(text)
        currentMessages.push({ role: 'ai', text: reply, at: nowIso() })
        renderChat(false)
        speakThenListen(reply)
      }
    } finally {
      sending = false
      setSendEnabled(true)
      settleStatus()
      flushPendingSpoken()
    }

    // Learn durable facts after replying, so a slow write never delays the
    // response the person is waiting for. This must run for check-in turns
    // too — that is where a senior is most likely to mention a name, a
    // relative or an ailment worth remembering.
    learnFrom(text)
    if (ordinary) maybeCaptureStory(text)
  }

  // A fresh conversation. Whatever was said in the one before it is saved
  // first — this used to throw it away unless someone had pressed Save, and
  // there is no Save button any more.
  function newSession(opts = {}) {
    if (hasUnsavedTalk()) persistSession(null, { quiet: true })
    Voice.stop()
    currentMessages = []
    savedCount = 0
    savedAt = null
    conversationEnded = false
    conversationSeq++
    shortStreak = 0
    offeredToStop = false
    pendingOffer = null
    storyMode = null
    sessionStartedAt = new Date()
    resetTopics()
    renderChat(true)
    updateSessionStats()
    if (opts.greet !== false) maybeGreet()
  }

  // ── Finishing a chat, and saving one without being asked ──────
  // "New" and "Save" meant nothing to a senior trying the app (audits/
  // P3-senior-feedback.md, item 4). A conversation now simply ends: the senior
  // taps "Finish for now", and finishing it is what saves it — the companion
  // says goodbye, the chat goes into Past chats, and the next thing they say
  // starts a new one.
  //
  // Chats also save themselves, because a button nobody presses is the same as
  // no button: when the page is put away or closed, after a long pause, and
  // before another conversation replaces this one. persistSession() takes only
  // what is new each time, so those can overlap freely.
  let conversationEnded = false
  let conversationSeq = 0
  const IDLE_SAVE_MS = 10 * 60 * 1000
  let idleTimer = null

  function unsavedTurns() {
    return currentMessages.slice(savedCount)
  }

  function hasUnsavedTalk() {
    return unsavedTurns().some(m => m.role === 'user')
  }

  async function finishChat() {
    if (!getSelected()) return
    micStop()
    Voice.stop()
    storyMode = null

    // A check-in being finished early is a check-in stopped: stop() saves the
    // part that was answered, as its own record, before anything below runs.
    const ci = window.TechableCheckIn
    if (ci?.isActive?.()) ci.stop()

    // Nothing was said, so there is nothing to keep and nobody to say goodbye
    // to. The button is not even on screen in that state.
    if (!currentMessages.some(m => m.role === 'user')) return

    const bye = chrome('chat.bye', { name: speakableName(getSelected()) || '' })
    currentMessages.push({ role: 'ai', text: bye, at: nowIso() })
    Voice.speak(bye)
    await concludeConversation()
  }

  // The end of a conversation, however it ended — Finish for now, a goodbye,
  // or a run of answers that said they would rather not talk just now. Saved
  // with its last line, and the next thing they say starts a new one. If
  // everything they said was already saved — the page was put away and opened
  // again — the goodbye on its own is not worth a record, or a toast.
  async function concludeConversation() {
    conversationEnded = true
    shortStreak = 0
    offeredToStop = false
    pendingOffer = null
    storyMode = null
    micStop()
    renderChat(false)
    if (hasUnsavedTalk()) await persistSession(null)
    updateSessionStats()
  }

  // ── How the conversation is going ─────────────────────────────
  // The run of short or "no" answers (two: offer to stop; three: goodbye),
  // whether the last reply offered to stop, and the mood game the greeting
  // offered and is waiting to hear back about. All three belong to one
  // conversation and start again with the next.
  let shortStreak = 0
  let offeredToStop = false
  let pendingOffer = null

  // The answer to "would you like to play today's mood game?". Returns true
  // when it has dealt with the turn, false to let the ordinary chat answer it.
  //
  //   yes / "let's play"      → the game, from its first question
  //   no / "maybe later"      → a friendly line, and today is not offered again
  //   a mood ("I'm so tired") → the game, from that answer — asking "how are you
  //                             feeling?" after they have just said would be the
  //                             loop this whole change is about
  //   anything else           → just a conversation
  async function answerOffer(text) {
    const offer = pendingOffer
    pendingOffer = null
    if (offer === 'familynote') return answerInboxOffer(text)
    if (offer !== 'moodgame') return false
    const ci = window.TechableCheckIn
    if (!ci?.startVoice || ci.isActive?.()) return false
    const p = pats()
    if (p.consent?.test(text) || p.game?.test(text)) {
      ci.startVoice({ keepTranscript: true })
      return true
    }
    if (p.decline?.test(text) || p.no?.test(text)) {
      ci.markDoneToday?.()
      const reply = chrome('offer.declined')
      currentMessages.push({ role: 'ai', text: reply, at: nowIso() })
      renderChat(false)
      speakThenListen(reply)
      return true
    }
    if (primaryMood(text)) {
      await ci.startVoice({ keepTranscript: true, answer: text })
      return true
    }
    return false
  }

  // Quietly. A toast while the phone is going back in a pocket is pointless,
  // and the senior did not ask for this one.
  function autosave(reason) {
    if (!hasUnsavedTalk()) return null
    const ci = window.TechableCheckIn
    if (ci?.isActive?.()) {
      // The check-in writes its own record when it ends. Leaving the page is
      // the one ending it would never see, so it is stopped here, which saves
      // what was answered. Being put away for a minute is not an ending.
      if (reason === 'pagehide') ci.stop()
      return null
    }
    return persistSession(null, { quiet: true })
  }

  function armIdleSave() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => autosave('idle'), IDLE_SAVE_MS)
    // A browser hands back a number; Node's test runner a handle that would
    // otherwise keep the process alive for ten minutes.
    idleTimer?.unref?.()
  }

  function syncFinishButton() {
    const btn = $('finish-btn')
    if (btn) btn.hidden = conversationEnded || !currentMessages.some(m => m.role === 'user')
  }

  // Registered as the file loads rather than in init(), so the test suites —
  // which never run init() — exercise the same listeners the page does.
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave('hidden')
    // Coming back to the app is when something new from the family is most
    // likely to be waiting; one equality query to find out.
    else if (inbox.loaded && usingFirestore && isResident()) { loadInbox(); loadLinks(); refreshCentreState() }
  })
  window.addEventListener?.('pagehide', () => autosave('pagehide'))

  function startNewChat() {
    newSession()
  }

  // ── The opening line ──────────────────────────────────────────
  // A conversation now opens the way a person would open one: by the clock and
  // by first name, out loud, as a real turn in the transcript.
  //
  // The greeting is a message rather than markup on purpose. Being a message
  // is what makes it spoken, saved with the session, and announced by the
  // aria-live log — none of which the old static bubble was.
  // `offer`: the day's mood game is offered as part of the greeting.
  function greetingText(resident, opts = {}) {
    const r = resident || getSelected()
    if (!r) return ''

    const i18n = window.TechableI18n
    const name = speakableName(r)
    // Same boundaries as residentContext().now, so the companion and the
    // prompt never disagree about whether it is still the afternoon.
    const hour = new Date().getHours()
    const key = hour < 12 ? 'greet.morning' : hour < 17 ? 'greet.afternoon' : 'greet.evening'

    const hello = i18n?.t
      ? i18n.t(key, { name })
      : (name ? `Hello, ${name}.` : 'Hello.')
    // A family message waiting is news, and comes before anything else. The
    // first greeting after the welcome uses what they said they enjoy.
    const welcome = typeof opts.welcome === 'string'
      ? chrome('greet.welcome.interest', { interest: opts.welcome })
      : opts.welcome ? chrome('greet.welcome') : ''
    const opener = opts.inbox || welcome || (i18n?.t ? i18n.t(opts.offer ? 'greet.offer' : 'greet.opener') : '')
    if (!opener) return hello

    // Chinese does not put a space after 。 — the full stop already carries the
    // width, and the gap reads as a typo in a bubble the senior can see.
    return hello + (/[。！？]$/.test(hello) ? '' : ' ') + opener
  }

  // Only ever the opener: it stands down the moment the check-in claims the
  // conversation, because the check-in greets by name itself.
  function maybeGreet() {
    if (!getSelected()) return
    if (window.TechableCheckIn?.isActive?.()) return
    setTimeout(() => {
      if (currentMessages.length || onb.open) return
      if (window.TechableCheckIn?.isActive?.()) return
      if (!getSelected()) return
      greet({ offerGame: shouldOfferGame() })
    }, 450)
  }

  // The day's mood game is offered at most once a day, and only until it has
  // been played or turned down.
  const OFFERED_KEY = 'techable_moodgame_offered_'

  function shouldOfferGame() {
    const r = getSelected()
    const ci = window.TechableCheckIn
    if (!r || !ci?.startVoice || ci.todayDone?.()) return false
    try { return localStorage.getItem(OFFERED_KEY + r.id) !== new Date().toDateString() } catch (_) { return true }
  }

  function greet(opts = {}) {
    // The game is not offered in the same breath as a family message, or at a
    // first meeting; it is still a tile under the greeting.
    const news = opts.welcome ? '' : inboxAnnouncement()
    const offer = !news && !opts.welcome && Boolean(opts.offerGame)
    const text = greetingText(null, { offer, inbox: news, welcome: opts.welcome })
    if (!text) return

    currentMessages.push({ role: 'ai', text, at: nowIso() })
    if (news) {
      pendingOffer = 'familynote'
    } else if (offer) {
      pendingOffer = 'moodgame'
      try { localStorage.setItem(OFFERED_KEY + getSelected().id, new Date().toDateString()) } catch (_) {}
    }
    renderChat(false)
    updateSessionStats()

    // Autoplay is refused until the page has been touched. Voice.speak() holds
    // the line until then and speaks it on the first tap, so this can simply
    // ask for it to be spoken — the check-in's opener goes through the same
    // door, which is what it was missing.
    speakThenListen(text)
  }

  function noteGesture() {
    Voice.unlock()
  }

  // ── Conversation starters ─────────────────────────────────────
  // "What would you like to talk about today?" over an empty window was the
  // whole of a new senior's first chat, and they said the blank screen was
  // intimidating (audits/P3-senior-feedback.md, item 3). A few large tiles now
  // sit under the greeting until they say something: today's mood game while
  // it is still to play, two things the companion remembers about them, and
  // warm open questions while there is little to remember.
  //
  // Tapping one makes the companion ask about it, as its own turn, spoken. It
  // is never a message put in the senior's mouth: the transcript, the saved
  // chat and the AI all see the companion asking and the senior answering.
  //
  // Built once per conversation, so the tiles do not reshuffle under a finger
  // as replies render; the rotation moves on with each new conversation.
  const STARTER_TURN_KEY = 'techable_starter_turn_'
  const STARTERS_MAX = 4
  const MEMORY_ICONS = { family: '👪', hobby: '🌱', place: '📍', event: '🎉' }
  // Labels are topics; `key` is the offline reply that asks the same thing,
  // so a question chosen from a tile is not asked a second time later on.
  const OPEN_STARTERS = [
    { id: 'smile', icon: '😊', ask: 'reply.open.3', key: 'reply.open.3' },
    { id: 'meal',  icon: '🍲', ask: 'reply.open.4', key: 'reply.open.4' },
    { id: 'ahead', icon: '📅', ask: 'reply.open.2', key: 'reply.open.2' },
    { id: 'young', icon: '🧒', ask: 'starter.ask.young' },
    { id: 'place', icon: '🏞️', ask: 'starter.ask.place' }
  ]
  let starters = { seq: -1, lang: '', turn: 0, tapped: false, list: [] }

  const capitalise = s => s ? s[0].toUpperCase() + s.slice(1) : s
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

  // A memory as a subject and a question. The app's own learned memories are
  // saved in English shapes — "Enjoys gardening", "Grew up in Ipoh" — which
  // read as a record, not a subject, so in English those are turned round
  // ("Gardening" → "You enjoy gardening. What do you love most about it?").
  // Anything else, and every memory in another language, is quoted as saved.
  function memoryStarter(mem) {
    const text = String(mem.text || '').trim().replace(/[.!]+$/, '')
    const base = { kind: 'memory', icon: MEMORY_ICONS[mem.tag] || '💭', key: 'mem:' + (mem.id || mem.text) }
    let m
    if (langCode() === 'en') {
      if ((m = text.match(/^enjoys\s+(.{2,60})$/i)))
        return { ...base, label: capitalise(m[1]), ask: chrome('starter.enjoys', { what: m[1] }) }
      if ((m = text.match(/^grew up in\s+(.{2,40})$/i)))
        return { ...base, label: 'Growing up in ' + m[1], ask: chrome('starter.grewup', { place: m[1] }) }
      if ((m = text.match(/^(\w+) is called\s+(\w+)$/i)))
        return { ...base, label: `Your ${m[1].toLowerCase()} ${m[2]}`, ask: chrome('starter.named', { who: m[1].toLowerCase(), person: m[2] }) }
      if ((m = text.match(/^has an?\s+(\w+)$/i)))
        return { ...base, label: 'Your ' + m[1].toLowerCase(), ask: chrome('starter.kin', { who: m[1].toLowerCase() }) }
      if ((m = text.match(/^used to be (an?\s+.{2,40})$/i)))
        return { ...base, label: 'When you were ' + m[1], ask: chrome('starter.job', { job: m[1] }) }
    }
    return { ...base, label: clip(capitalise(text), 44), ask: chrome('starter.memory', { mem: text }) }
  }

  function buildStarters(r, turn) {
    const list = []
    // What the family sent comes first: it is the one thing here that is news.
    const waiting = unheardNotes()
    if (waiting.length) {
      list.push({ kind: 'family', icon: '💌', label: waiting.length > 1
        ? chrome('starter.family.many', { n: waiting.length })
        : chrome('starter.family', { person: givenName(waiting[0].fromName) || noteWho(waiting[0]) }) })
    }
    const ci = window.TechableCheckIn
    if (ci?.startVoice && !ci.todayDone?.()) list.push({ kind: 'game', icon: '☀️', label: chrome('starter.game') })

    // How someone felt is not a subject to open a conversation with.
    const mems = (r.memories || []).filter(m => m && String(m.text || '').trim() && m.tag !== 'feeling' && !garbledJob(m.text))
    const picks = mems.length === 1 ? [mems[0]]
      : mems.length > 1 ? [mems[(turn * 2) % mems.length], mems[(turn * 2 + 1) % mems.length]] : []
    picks.forEach(m => list.push(memoryStarter(m)))

    // One chapter of their life story, so the book has a way to begin.
    const chapter = suggestChapter(r, turn)
    if (chapter) list.push({ kind: 'chapter', icon: '📖', label: chrome('story.topic.' + chapter), chapter })

    for (let i = 0; list.length < STARTERS_MAX && i < OPEN_STARTERS.length; i++) {
      const o = OPEN_STARTERS[(turn + i) % OPEN_STARTERS.length]
      list.push({ kind: 'open', icon: o.icon, label: chrome('starter.open.' + o.id), ask: chrome(o.ask), key: o.key || '' })
    }
    return list.slice(0, STARTERS_MAX)
  }

  // This conversation's tiles. A new conversation moves the rotation on; a
  // change of language rewrites the same tiles in the new one.
  function currentStarters() {
    const r = getSelected()
    if (!r) return starters
    if (starters.seq !== conversationSeq) {
      let turn = 0
      try { turn = Number(localStorage.getItem(STARTER_TURN_KEY + r.id)) || 0 } catch (_) {}
      try { localStorage.setItem(STARTER_TURN_KEY + r.id, String(turn + 1)) } catch (_) {}
      starters = { seq: conversationSeq, lang: langCode(), turn, tapped: false, list: buildStarters(r, turn) }
    } else if (starters.lang !== langCode() || starters.stale) {
      // Same turn, so the memories do not reshuffle under a finger.
      starters.lang = langCode()
      starters.stale = false
      starters.list = buildStarters(r, starters.turn)
    }
    return starters
  }

  // Only under the greeting of a conversation nobody has spoken in yet, and
  // never over the check-in, which has its own answers on screen.
  function startersWanted() {
    if (!getSelected() || conversationEnded || storyMode || onb.open) return false
    if (!currentMessages.length || currentMessages.some(m => m.role === 'user')) return false
    if (window.TechableCheckIn?.isActive?.()) return false
    return !currentStarters().tapped
  }

  function renderStarters() {
    const box = $('starters')
    const grid = $('starters-grid')
    if (!box || !grid) return
    const list = startersWanted() ? currentStarters().list : []
    box.hidden = !list.length
    grid.innerHTML = list.map((s, i) => `
      <button type="button" class="starter" data-starter="${i}">
        <span class="starter-ico" aria-hidden="true">${s.icon}</span>
        <span class="starter-lbl">${esc(s.label)}</span>
      </button>`).join('')
    grid.querySelectorAll('.starter').forEach(btn => {
      btn.addEventListener('click', () => tapStarter(Number(btn.dataset.starter)))
    })
  }

  function tapStarter(i) {
    if (!startersWanted()) return
    const s = currentStarters().list[i]
    if (!s) return
    // Choosing something else is an answer to the greeting's offer of the
    // game too — a "yes" to the question asked next must not start it.
    pendingOffer = null

    if (s.kind === 'game') {
      const ci = window.TechableCheckIn
      if (!ci?.startVoice || ci.isActive?.()) return
      starters.tapped = true
      ci.startVoice({ keepTranscript: true })
      return
    }

    if (s.kind === 'chapter') {
      starters.tapped = true
      startStory(s.chapter)
      return
    }

    if (s.kind === 'family') {
      const first = unheardNotes()[0]
      if (!first) return
      starters.tapped = true
      presentNote(first)
      return
    }

    starters.tapped = true
    if (s.key) offlineUsed().add(s.key)
    currentMessages.push({ role: 'ai', text: s.ask, at: nowIso() })
    renderChat(false)
    updateSessionStats()
    speakThenListen(s.ask)
  }

  // The first thing the companion will say is knowable before anyone asks for
  // it, and a neural voice takes about as long to make a line as the line takes
  // to speak — on top of a cold serverless function. Synthesising it during the
  // seconds a senior spends finding the Chat tab is the difference between a
  // greeting that lands with them and one they wait out in silence.
  async function primeOpeningLine() {
    // The config is a network round trip that init() does not wait for, so
    // "it has not arrived yet" read here as "there is no neural voice" — and
    // this returned having done nothing at all, on the one line the whole
    // mechanism exists for. ping() already draws that distinction; this did not.
    try { await window._cfg } catch (_) {}
    const r = getSelected()
    if (!r) return
    // The greeting is what opens the chat now, offering the day's mood game
    // rather than starting it — see maybeStartVoiceCheckIn().
    const line = greetingText(r, { offer: shouldOfferGame(), inbox: inboxAnnouncement() })
    if (line) Voice.prime(line)
  }

  function getSessions(id) {
    try {
      return JSON.parse(localStorage.getItem(SESSION_PREFIX + id) || '[]')
    } catch (_) {
      return []
    }
  }

  // saveSession() is bound to a button, so it must stay argument-free — a click
  // handler would otherwise pass a MouseEvent in as the check-in record. The
  // Guess My Day module calls persistSession(checkIn) directly via the bridge.
  async function saveSession() {
    return persistSession(null)
  }

  // How much of the conversation on screen is already in a saved session.
  // Chats save themselves now (see finishChat() above), so one conversation
  // can be saved more than once, and each save takes only what was said since
  // the last one. Two copies of the same words in Past chats, or two session
  // rows on a family's dashboard for one exchange, would be worse than the
  // Save button this replaced.
  let savedCount = 0
  let savedAt = null

  // `opts.quiet`: a save nobody asked for (autosave) shows no toast.
  async function persistSession(checkIn, opts = {}) {
    const r = getSelected()
    const fresh = currentMessages.slice(savedCount)
    if (!r || !fresh.length) {
      if (!opts.quiet) showToast('No messages to save')
      return null
    }

    const startedAt = savedAt || sessionStartedAt
    const durationSecs = startedAt
      ? Math.max(1, Math.round((Date.now() - startedAt.getTime()) / 1000))
      : Math.max(60, fresh.length * 30)

    // Marked saved before anything is awaited: a second trigger landing during
    // the Firestore write (the page hidden a moment after Finish) must not
    // save the same turns again. Put back below if they reached nowhere.
    const seq = conversationSeq
    const previous = { savedCount, savedAt }
    savedCount = currentMessages.length
    savedAt = new Date()

    // Simple topic extraction from user messages
    const userTexts = fresh.filter(m => m.role === 'user').map(m => m.text)
    const topicsDiscussed = checkIn?.topic
      ? Array.from(new Set([checkIn.topic, ...extractTopics(userTexts)])).slice(0, 5)
      : extractTopics(userTexts)

    // A check-in carries a self-reported mood, which is the only signal we have
    // any business turning into a number. Ordinary chats stay unscored.
    const wellnessScore = checkIn ? moodToScore(checkIn.mood) : null

    const sessionObj = {
      id: cryptoId(),
      residentId: r.id,
      savedAt: nowIso(),
      durationSecs,
      messageCount: fresh.length,
      wellnessScore,
      topicsDiscussed,
      kind: checkIn ? 'checkin' : 'chat',
      checkIn: checkIn || null,
      messages: fresh
    }

    // Always save locally.
    //
    // Guarded: a browser that is out of storage throws QuotaExceededError here,
    // and this used to take the whole of persistSession() down with it — into
    // checkin.js's save(), which logs a warning and moves on. The senior would
    // have finished a check-in, been thanked for it, and had it silently
    // dropped. Fifty stored transcripts makes that reachable in months, not
    // years, so the oldest are shed and the write retried before giving up.
    let localSaved = writeCapped(SESSION_PREFIX + r.id, getSessions(r.id), sessionObj, 50)

    if (checkIn) {
      const entry = { ...checkIn, id: sessionObj.id, residentId: r.id, savedAt: sessionObj.savedAt }
      localSaved = writeCapped(CHECKIN_PREFIX + r.id, getCheckIns(r.id), entry, 60) && localSaved
    }

    // Also write to Firestore so family/manager dashboards can see activity.
    //
    // Whether this worked is the whole question for a check-in: the dashboards
    // read Firestore, so a failure here is the difference between a family
    // seeing that their mother reported a fall and nobody seeing it at all. It
    // used to be swallowed into a console warning while the toast below said
    // "Session saved ✓" regardless.
    let synced = false
    if (usingFirestore && firestoreReady && !selfLoadFailed) {
      try {
        await fs.addDoc(fs.collection(db, 'sessions'), {
          residentId: r.id,
          // Denormalised so security rules can authorise a read without a
          // get() on the resident doc for every row of a dashboard query.
          ownerUid: authUser?.uid || '',
          centreId: r.centreId || r.communityId || '',
          savedAt: fs.serverTimestamp(),
          durationSecs,
          messageCount: fresh.length,
          wellnessScore,
          topicsDiscussed,
          kind: sessionObj.kind,
          checkIn: checkIn || null
        })
        synced = true
      } catch (err) {
        console.warn('Firestore session save failed:', err)
      }
    }

    // Nothing was kept anywhere: these turns are not saved, so the next save —
    // automatic or not — should try them again. Only if the same conversation
    // is still on screen; a new one has its own count.
    if (!localSaved && !synced && seq === conversationSeq) {
      savedCount = previous.savedCount
      savedAt = previous.savedAt
    }

    renderDashboard()
    renderHistory()

    // Say what actually happened. Three different outcomes were all reported as
    // success, and the one that matters most — an urgent disclosure that never
    // reached the dashboards anyone reads — was the quietest of them. A quiet
    // save (nobody asked for it) stays quiet unless an escalation failed to
    // reach the care team, which is never something to keep to ourselves.
    const speak = !opts.quiet || (checkIn?.escalation && !synced)
    if (!speak) {
      // nothing to say
    } else if (!localSaved && !synced) {
      showToast('Could not save this conversation — please try again')
    } else if (usingFirestore && !synced) {
      showToast(checkIn?.escalation
        ? 'SAVED ON THIS DEVICE ONLY — this was not sent to the care team. Please contact them directly.'
        : 'Saved on this device only — could not sync')
    } else {
      // "Session" meant nothing to the senior reading it; this is their chat.
      showToast(usingFirestore ? 'Chat saved ✓' : 'Chat saved on this device ✓')
    }

    // usingFirestore tells checkin.js whether synced:false is a failure (the
    // record should have reached the dashboards) or just localStorage mode.
    return { ...sessionObj, synced, localSaved, usingFirestore }
  }

  // Newest-first list capped to `max`, written back under `key`. Returns false
  // rather than throwing when the browser will not take it.
  //
  // Shedding entries and retrying matters more than it looks: the thing being
  // written is usually the record of a conversation that has just happened, and
  // the alternative to dropping the oldest transcript is dropping today's.
  function writeCapped(key, list, entry, max) {
    list.unshift(entry)
    let keep = Math.min(list.length, max)

    while (keep > 0) {
      try {
        localStorage.setItem(key, JSON.stringify(list.slice(0, keep)))
        return true
      } catch (err) {
        // Out of room. Halve what we are asking for and try again; a single
        // entry that still will not fit is genuinely unstorable.
        if (keep === 1) {
          console.warn('Local session save failed even at one entry:', err)
          return false
        }
        keep = Math.floor(keep / 2)
      }
    }
    return false
  }

  // Self-reported mood → the 1-10 scale the family/provider dashboards already
  // render. Deliberately coarse: this reflects what the senior said today, and
  // is not a clinical measure of anything.
  function moodToScore(mood) {
    return { good: 9, okay: 7, tired: 5, low: 3 }[mood] ?? null
  }

  function getCheckIns(id) {
    try {
      return JSON.parse(localStorage.getItem(CHECKIN_PREFIX + id) || '[]')
    } catch (_) {
      return []
    }
  }

  function extractTopics(userTexts) {
    const keywords = {
      family: ['family','son','daughter','grandchild','wife','husband','children','grandkids','visit'],
      memories: ['remember','used to','years ago','back then','when i was','old days'],
      health: ['pain','tired','feel','health','doctor','medicine','sleep','ache'],
      food: ['food','eat','ate','cook','recipe','lunch','dinner','breakfast','supper','hungry',
             'dessert','cake','sweet','snack','meal','rice','noodle','soup','tea','coffee','drink'],
      hobbies: ['garden','read','music','play','sing','chess','craft','walk','swim'],
      weather: ['weather','rain','hot','cold','sunny','outside'],
      news: ['news','heard','read','world','today'],
    }

    const found = new Set()
    const combined = userTexts.join(' ').toLowerCase()
    for (const [topic, words] of Object.entries(keywords)) {
      if (words.some(w => combined.includes(w))) found.add(topic)
    }
    return Array.from(found).slice(0, 5)
  }

  // ── Topic depth ───────────────────────────────────────────────
  // The companion was burrowing: dessert → what kind → what flavour → where
  // did you get it, on and on, because the prompt rewards specificity and
  // forbids repeating a question. Three exchanges on one subject is interest;
  // the fourth is an interrogation.
  //
  // A reply with no recognisable topic ("mango and red bean") is a
  // continuation, not a new subject — otherwise the counter would reset on
  // every short answer and never trip.
  function trackTopic(userText) {
    const topics = extractTopics([userText])
    const key = topics.join('|')

    if (key && key !== topicKey) {
      topicKey = key
      topicSeed = userText
      topicRun = 1
    } else {
      if (!topicRun) topicSeed = userText
      topicRun++
    }
  }

  // What to call the subject in the change-the-subject instruction. A keyword
  // match is the clean case; where there is none — "I had dessert this
  // afternoon" matches nothing in extractTopics — the senior's own opening
  // words are a far better label than nothing at all, which would leave the
  // model guessing which of several threads it is supposed to leave.
  function currentTopicLabel() {
    const keyed = topicKey.split('|')[0]
    if (keyed) return keyed
    const seed = String(topicSeed || '').trim().replace(/\s+/g, ' ')
    return seed.length > 60 ? seed.slice(0, 57) + '…' : seed
  }

  // Called after a reply that was sent under the change-the-subject order, so
  // the next subject gets its own full three exchanges instead of being cut
  // off immediately.
  function topicRotated() {
    if (topicRun >= TOPIC_FLOOR) {
      topicRun = 0
      topicKey = ''
      topicSeed = ''
      topicRotation++
    }
  }

  function resetTopics() {
    topicRun = 0
    topicKey = ''
    topicSeed = ''
  }

  // Concrete places to go next, so a forced subject change never lands on
  // "is there anything else?". Real things this person told us come first;
  // the day-structure openers are the backstop and rotate so the same one is
  // not offered every time.
  function suggestNextTopics() {
    const r = getSelected()
    const out = []

    const mems = (r?.memories || []).filter(m => m?.text)
    if (mems.length) {
      const start = topicRotation % mems.length
      for (let i = 0; i < Math.min(2, mems.length); i++) {
        out.push(`something they told you before — ${mems[(start + i) % mems.length].text}`)
      }
    }
    if (r?.family)     out.push(`their family — ${String(r.family).slice(0, 120)}`)
    if (r?.background) out.push(`their life before — ${String(r.background).slice(0, 120)}`)

    const generic = [
      'anything special they did earlier this morning',
      'whether they have spoken with any family or friends recently',
      'a meal they love, or what they have eaten today',
      'music, a program, or a book they have enjoyed lately',
      'a place they have lived, or somewhere they would like to go again'
    ]
    for (let i = 0; i < generic.length; i++) {
      out.push(generic[(topicRotation + i) % generic.length])
    }

    return out.slice(0, 5)
  }

  function renderHistory() {
    const r = getSelected()
    const wrap = $('hist-wrap')
    if (!wrap || !r) return

    const sessions = getSessions(r.id)

    if (!sessions.length) {
      wrap.innerHTML = '<div class="mem-empty">No saved sessions yet.</div>'
      return
    }

    wrap.innerHTML = sessions.map(s => {
      const messages = s.messages || []
      const preview = messages.slice(0, 2).map(m => `${m.role}: ${m.text}`).join(' / ')
      const duration = formatDuration(s.durationSecs || Math.max(60, messages.length * 30))
      const c = s.checkIn
      const badge = c
        ? `<div class="hist-checkin">☀️ Check-in · ${esc(c.moodLabel || '—')}${
            c.escalation ? ' · <strong style="color:var(--rust)">escalated</strong>' : ''
          }</div>`
        : ''
      return `
        <div class="hist-card">
          <div class="hist-date">${esc(new Date(s.savedAt).toLocaleString())}</div>
          ${badge}
          <div class="hist-preview">${esc(c?.summary || preview)}</div>
          <div class="hist-meta">${messages.length} messages · ${duration}</div>
        </div>`
    }).join('')
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0)
    const mins = Math.floor(total / 60)
    const secs = total % 60
    if (mins >= 60) {
      const hrs = Math.floor(mins / 60)
      const rem = mins % 60
      return rem ? `${hrs}h ${rem}m` : `${hrs}h`
    }
    if (mins > 0) return `${mins}m`
    return `${secs}s`
  }

  // Called after every change to the transcript. It used to fill the
  // "Msgs 1 | 0s" bar; that bar is gone (it meant nothing to a senior), and
  // what is left to keep in step is the Finish button and the idle save.
  function updateSessionStats() {
    syncFinishButton()
    armIdleSave()
  }

  function sumSessionDuration(list) {
    return list.reduce((sum, s) => sum + (Number(s.durationSecs) || Math.max(60, (s.messages || []).length * 30)), 0)
  }

  function renderDashboard() {
    const r = getSelected()
    const sessions = isManager() ? getAllSessions() : selectedSessions()
    const selectedMemoryCount = r?.memories?.length || 0
    const totalMemoryCount = isManager()
      ? residents.reduce((sum, item) => sum + (item.memories?.length || 0), 0)
      : selectedMemoryCount

    if ($('dash-eyebrow')) $('dash-eyebrow').textContent = isManager() ? 'Community Manager Dashboard' : 'Resident Dashboard'
    if ($('dash-title')) $('dash-title').textContent = isManager()
      ? `Managing ${residents.length} elderly profile${residents.length === 1 ? '' : 's'}`
      : `Welcome, ${r?.preferredName || r?.name || userDisplayName()}`
    if ($('dash-sub')) $('dash-sub').textContent = isManager()
      ? 'Review facility usage, select an elderly profile, and manage memories or chat sessions.'
      : 'View your profile, memories, conversations, and saved chat history from one private workspace.'

    if ($('dash-residents')) $('dash-residents').textContent = isManager() ? residents.length : 1
    if ($('dash-residents-label')) $('dash-residents-label').textContent = isManager() ? 'Elderly Profiles' : 'Profile'
    if ($('dash-residents-note')) $('dash-residents-note').textContent = isManager() ? 'Facility records' : 'Private to your account'
    if ($('dash-memories')) $('dash-memories').textContent = totalMemoryCount
    if ($('dash-sessions')) $('dash-sessions').textContent = sessions.length
    if ($('dash-active-time')) $('dash-active-time').textContent = formatDuration(sumSessionDuration(sessions))

    const actions = $('dash-actions')
    if (actions) {
      const selectedName = r?.preferredName || r?.name || 'No profile selected'
      actions.innerHTML = isManager()
        ? `
          <button class="dash-item" onclick="openAddModal()"><span class="dash-item-icon">➕</span><span class="dash-item-main"><span class="dash-item-title">Add elderly profile</span><span class="dash-item-sub">Create a new facility record</span></span></button>
          <button class="dash-item" onclick="switchTab('profile')"><span class="dash-item-icon">📋</span><span class="dash-item-main"><span class="dash-item-title">Edit selected profile</span><span class="dash-item-sub">${esc(selectedName)}</span></span></button>
          <button class="dash-item" onclick="switchTab('conversation')"><span class="dash-item-icon">💬</span><span class="dash-item-main"><span class="dash-item-title">Open companion chat</span><span class="dash-item-sub">Talk as the selected elderly profile</span></span></button>
        `
        : `
          <button class="dash-item" onclick="startCheckIn()"><span class="dash-item-icon">☀️</span><span class="dash-item-main"><span class="dash-item-title">Today's check-in</span><span class="dash-item-sub">Play Guess My Day — about 2 minutes</span></span></button>
          <button class="dash-item" onclick="switchTab('conversation')"><span class="dash-item-icon">💬</span><span class="dash-item-main"><span class="dash-item-title">Start chatting</span><span class="dash-item-sub">Open your AI companion</span></span></button>
          <button class="dash-item" onclick="switchTab('memories')"><span class="dash-item-icon">🧠</span><span class="dash-item-main"><span class="dash-item-title">Review memories</span><span class="dash-item-sub">${selectedMemoryCount} saved item${selectedMemoryCount === 1 ? '' : 's'}</span></span></button>
          <button class="dash-item" onclick="switchTab('history')"><span class="dash-item-icon">📁</span><span class="dash-item-main"><span class="dash-item-title">View history</span><span class="dash-item-sub">${sessions.length} saved chat${sessions.length === 1 ? '' : 's'}</span></span></button>
        `
    }

    const facilityList = $('dash-facility-list')
    if (facilityList) {
      const recent = residents.slice(0, 5)
      facilityList.innerHTML = recent.length
        ? recent.map(item => `
          <button class="dash-item" data-select-res="${esc(item.id)}">
            <span class="dash-item-icon">${avatarHTML(item)}</span>
            <span class="dash-item-main">
              <span class="dash-item-title">${esc(item.preferredName || item.name || 'Unnamed')}</span>
              <span class="dash-item-sub">${esc([item.room, item.status, item.memories?.length ? `${item.memories.length} memories` : 'No memories'].filter(Boolean).join(' · '))}</span>
            </span>
          </button>`).join('')
        : '<div class="mem-empty">No elderly profiles yet.</div>'
      // Read back from data-select-res rather than an
      // onclick="selectRes('<id>')": the HTML parser decodes esc()'s &#039;
      // to a quote before a handler attribute is parsed as JavaScript. A
      // property, so re-rendering the dashboard replaces it instead of stacking.
      facilityList.onclick = e => {
        const btn = e.target?.closest?.('[data-select-res]')
        if (!btn) return
        selectRes(btn.dataset.selectRes)
        switchTab('profile')
      }
    }

    if ($('dash-facility-count')) $('dash-facility-count').textContent = isManager() ? `${residents.length} total` : ''

    window.TechableCheckIn?.refresh?.()
  }

  // ── Voice input (speech-to-text) ──────────────────────────────
  // Two things an elderly user should never have to do: watch an empty box
  // while they talk, and then hunt for a Send button.
  //
  //   • interimResults streams the words into the box AS they are spoken.
  //   • continuous keeps the recogniser alive through the natural pauses in
  //     an older person's speech — the default stops at the first one, which
  //     is what made half-finished sentences disappear.
  //   • a short silence after a completed phrase sends the message by itself.
  //
  // The silence timer is what actually triggers the send, not `onend`:
  // onend fires on any stop (including the browser giving up mid-thought),
  // so sending from there posts half-sentences.
  const MIC_SILENCE_MS = 1500
  let micFinal = ''
  let micTimer = null
  // True once the browser has actually started capturing audio for the
  // current session — the thing "Listening… speak now" should wait for.
  let micAudioStarted = false
  // Set for exactly one retry when start() is called before the previous
  // session's onend has fired (see micStart() below).
  let micRestartPending = false
  let micFailed = false
  let micError = ''

  function micShow(text) {
    const input = $('chat-input')
    if (!input) return
    input.value = text
    try { window.grow?.(input) } catch (_) {}
  }

  function micClearTimer() {
    if (micTimer) { clearTimeout(micTimer); micTimer = null }
  }

  // Keeps the button, the visible caption and the screen-reader state in sync.
  // The mic state must never be signalled by colour alone.
  //
  // `starting` marks the gap between tapping the mic and the browser actually
  // capturing audio — real on a cold recogniser, and the reason "it doesn't
  // register when you talk" was reported: the old code said "Listening" the
  // instant the tap happened, up to a second before Chrome opened the mic, so
  // the senior's first words landed before anything was capturing them.
  function micUI(on, statusText, starting) {
    if (!on && !statusText && micError) statusText = micError
    // The one microphone button. It carries the state in words as well as
    // colour, because it is the only way to talk on the screen.
    const talk = $('talk-btn')
    if (talk) {
      talk.classList.toggle('active', on)
      talk.classList.toggle('starting', Boolean(starting))
      talk.setAttribute('aria-pressed', on ? 'true' : 'false')
      talk.setAttribute('aria-label', on ? (starting ? chrome('talk.ready.aria') : chrome('talk.listening.aria')) : chrome('talk.idle'))
      const lbl = $('talk-lbl')
      if (lbl) lbl.textContent = on ? (starting ? chrome('talk.ready') : chrome('talk.listening')) : chrome('talk.idle')
    }
    const bar = $('mic-status')
    const txt = $('mic-status-text')
    if (txt && statusText) txt.textContent = statusText
    if (bar) bar.classList.toggle('on', Boolean(on || statusText))
    if (bar && !on && !statusText) bar.classList.remove('on')
  }

  function micStop() {
    micClearTimer()
    recognizing = false
    // A tap off cancels a queued retry; otherwise the closing session's
    // onend would switch the mic straight back on.
    micRestartPending = false
    micUI(false)
    try { recognition?.stop() } catch (_) {}
  }

  // Called once the senior has stopped talking for MIC_SILENCE_MS.
  function micCommit() {
    micClearTimer()
    const text = (micFinal || $('chat-input')?.value || '').trim()
    micFinal = ''
    if (!text) { micStop(); return }
    micStop()
    micShow(text)
    // Announced, not just sent: a blind or low-vision user gets confirmation
    // of what was actually heard before it disappears from the box. What is
    // announced has to be what happened, though — send() refuses a turn while
    // the previous reply is still in the air, so "Sending: …" was being read
    // out over sentences that were then dropped without a sound.
    const refusal = sendRefusal(text, true)
    if (refusal === 'busy') {
      pendingSpoken = text
      micUI(false, 'Still answering — I will send that next: ' + text)
    } else if (refusal === 'duplicate') {
      // The recogniser re-emitting its last final result. Already in the
      // transcript and already being answered, so do not claim it twice.
      micUI(false, 'Already sent: ' + text)
      sendFromMic = true
      send()
    } else if (!refusal) {
      micUI(false, 'Sending: ' + text)
      sendFromMic = true
      send()
    }
    setTimeout(() => { if (!recognizing) micUI(false) }, 2500)
  }

  // Built once, and as early as init() can manage — construction alone asks
  // the browser for nothing (only start() below requests the microphone), so
  // there is nothing unsafe about doing it before the senior has tapped
  // anything. Doing it early means the first tap does not also pay for
  // building the recogniser, which was part of the delay in "it takes a
  // while to even register as hearing you".
  function ensureRecognition() {
    if (recognition) return recognition
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return null

    recognition = new SR()
    recognition.interimResults = true
    recognition.continuous = true
    recognition.maxAlternatives = 1

    // A real recogniser carries `onaudiostart` before it is ever assigned; a
    // recogniser that has never heard of the event will not. Read before the
    // assignment below overwrites it, so this reflects the browser rather
    // than our own code.
    const supportsAudioStart = 'onaudiostart' in recognition

    recognition.onstart = () => {
      if (!recognizing || micFailed) return
      // onaudiostart is the real signal that Chrome has opened the
      // microphone; where it is not supported at all, onstart is the closest
      // thing available and is used in its place.
      if (!supportsAudioStart) {
        micAudioStarted = true
        micUI(true, 'Listening… speak now')
      }
    }

    recognition.onaudiostart = () => {
      if (!recognizing || micFailed) return
      micAudioStarted = true
      micUI(true, 'Listening… speak now')
    }

    recognition.onresult = e => {
      // Chrome can deliver a final result after stop(). That belongs to the
      // old stream; stopping Voice here would cancel the new reply and its
      // callback that reopens the microphone.
      if (micFailed || !recognizing) return
      // Never speak over the person: if they start talking while the
      // companion is still reading its reply aloud, stop the playback.
      Voice.stop()

      // Belt and braces: a transcript is proof audio was heard even on the
      // rare device that fires neither event above, so the status line is
      // never left stuck on "Getting ready…" while words are visibly arriving.
      if (!micAudioStarted) { micAudioStarted = true; micUI(true, 'Listening… speak now') }

      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0]?.transcript || ''
        if (e.results[i].isFinal) micFinal = (micFinal + ' ' + chunk).trim()
        else interim += chunk
      }

      micShow((micFinal + ' ' + interim).trim())

      // Restart the clock on every syllable; it only expires in real silence.
      micClearTimer()
      if (micFinal) micTimer = setTimeout(micCommit, MIC_SILENCE_MS)
    }

    recognition.onend = () => {
      recognizing = false
      if (micFailed) { micUI(false); return }
      // A tap can land while the previous session is still winding down —
      // micStop() marks it not-recognizing immediately, before onend fires,
      // so start() below can throw InvalidStateError into a session that is
      // about to genuinely end. Rather than leave the mic silently shut,
      // finish the restart here, once, now that it really has ended.
      if (micRestartPending) {
        micRestartPending = false
        recognizing = true
        micStart()
        return
      }
      // Chrome ends the stream on its own after a long pause. If a finished
      // phrase is sitting there, send it rather than losing it.
      if (micFinal.trim()) micCommit()
      else micUI(false)
    }

    recognition.onerror = ev => {
      micClearTimer()
      // Keep any visible words for manual review, but do not commit them
      // from onend after a failed recording or accept a late result.
      micFailed = true
      micFinal = ''
      recognizing = false
      micRestartPending = false
      const msg = {
        'not-allowed':         'Microphone blocked. Allow it in your browser settings, then tap the microphone again.',
        'service-not-allowed': 'Microphone blocked. Allow it in your browser settings, then tap the microphone again.',
        'no-speech':           'I did not hear anything. Tap the microphone and try again.',
        'audio-capture':       'No microphone found. Check it is plugged in.',
        'network':             chrome('toast.speechNetwork')
      }[ev?.error]
      micError = msg || ''
      micUI(false, msg || null)
      if (msg) showToast(msg)
    }

    return recognition
  }

  // Shared by the first tap and by the one-shot InvalidStateError retry from
  // onend above, so both go through the same "Getting ready…" state instead
  // of the retry silently skipping straight to a stuck mic.
  function micStart() {
    micFailed = false
    micError = ''
    micAudioStarted = false
    micUI(true, 'Getting ready…', true)
    try {
      recognition.start()
    } catch (err) {
      if (err?.name === 'InvalidStateError' && !micRestartPending) {
        // The previous session has not finished stopping yet. Wait for its
        // onend and try exactly once more rather than leaving the tap with
        // no effect at all.
        micRestartPending = true
        return
      }
      // Anything else is a real failure, and swallowing it is how the mic
      // used to go silently shut — the senior kept talking to a button that
      // had already given up.
      micRestartPending = false
      recognizing = false
      micUI(false, 'Could not start the microphone. Tap the microphone and try again.')
    }
  }

  function toggleMic() {
    if (!ensureRecognition()) return showToast('Speech recognition not supported')

    if (recognizing) { micCommit(); return }

    // Re-applied on every start: the recogniser is created once, but the
    // selected resident (and therefore the language) can change under it.
    recognition.lang = window.TechableI18n?.speechLang?.() || 'en-US'

    micFinal = ''
    micShow('')
    recognizing = true
    micRestartPending = false
    micStart()
  }

  // Used by the voice check-in to reopen the mic after the companion has
  // finished speaking, so the senior can simply answer back.
  function micListen() {
    if (activeTab !== 'conversation') return
    if (recognizing) return
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) return
    toggleMic()
  }

  function openAddModal() {
    if (!isManager()) return showToast('Only community managers can add elderly profiles')
    if ($('new-name')) $('new-name').value = ''
    if ($('new-age')) $('new-age').value = ''
    if ($('new-room')) $('new-room').value = ''
    renderCommunityOptions('', '')
    openModal('add-modal')
    setTimeout(() => $('new-name')?.focus(), 50)
  }

  async function resetSamples() {
    if (!isManager()) return
    if (!confirm('Reset local samples?')) return
    residents = defaultResidents()
    persistLocalResidents()
    selectedId = residents[0]?.id || null
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId)
    renderList()
    renderProfile()
    renderDashboard()
  }

  async function clearAll() {
    if (!isManager()) return showToast('Only community managers can clear facility data')
    if (!confirm('Clear all elderly data for this manager? Seniors who joined with their own account are taken off your members list, not deleted.')) return

    if (usingFirestore) {
      for (const r of residents) await (seniorOwned(r) ? releaseResidentRecord(r.id) : deleteResidentRecord(r.id))
    }

    residents = []
    selectedId = null
    localStorage.removeItem(SELECTED_KEY)
    localStorage.removeItem(STORE_KEY)
    renderList()
    renderProfile()
    renderDashboard()
  }

  function setActiveButtons(name, btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.side-nav-btn').forEach(b => b.classList.remove('active'))
    document.querySelectorAll('.bn-item').forEach(b => b.classList.remove('active'))

    const ids = [`tab-${name}`, `nav-${name}`, `bn-${name}`]
    ids.forEach(id => $(id)?.classList.add('active'))

    // The drawer's buttons carry no ids — they are duplicates of the sidebar's
    // — so nothing here ever highlighted them. That did not matter while the
    // drawer was a phone-only shortcut; it is the senior's only menu now.
    document.querySelectorAll(`.mob-res-drawer [data-tab="${name}"]`)
      .forEach(b => b.classList.add('active'))
    if (btn) btn.classList.add('active')

    // The senior's bar. A page reached from a tile on About Me keeps About Me
    // lit, so the bar always says where they are.
    const navTab = SENIOR_NAV_HOME[name] || name
    document.querySelectorAll('.senior-nav .sn-item').forEach(b => {
      const here = b.dataset?.tab === navTab
      b.classList.toggle('active', here)
      if (here) b.setAttribute('aria-current', 'page')
      else b.removeAttribute('aria-current')
    })
  }

  // Pages that have no place of their own on the senior's bar.
  const SENIOR_NAV_HOME = { forms: 'profile', memories: 'profile', history: 'profile', dashboard: 'conversation' }

  function pauseChatAudio() {
      activeTab = 'paused'
      // Keep the conversation/game, but release every chat audio path. Late
      // speech callbacks must not reopen a microphone in the blog or forms.
      pendingSpoken = null
      micFinal = ''
      micAudioStarted = false
      micFailed = true
      micStop()
      Voice.stop()
      window.TechableCheckIn?.pauseVoice?.()
      document.dispatchEvent(new CustomEvent('techable:pause-chat-audio'))
  }

  function switchTab(name, btn) {
    if (name !== 'conversation') pauseChatAudio()
    activeTab = name
    setActiveButtons(name, btn)

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
    $('panel-' + name)?.classList.add('active')

    if (name === 'dashboard') renderDashboard()
    if (name === 'history') renderHistory()
    if (name === 'conversation') { renderChips(); maybeStartVoiceCheckIn() }
    if (name === 'memories') renderMems()
    if (name === 'story') renderStory()
    if (name === 'family') {
      renderFamily()
      if (inbox.loaded && usingFirestore && isResident()) { loadInbox(); loadLinks() }
    }
    if (name === 'forms') renderForms()

    renderProfile()
  }

  // Opening the chat starts the day's check-in as the conversation itself —
  // the companion greets them and asks how they are feeling, instead of an
  // empty box with a Send button. It never interrupts a conversation already
  // in progress, and never runs twice in a day.
  //
  // Managers get it too. The old isResident() gate meant a centre manager
  // sitting with a senior only ever saw the old click-through panel, and the
  // merged version was effectively invisible to them.
  function maybeStartVoiceCheckIn() {
    if (!getSelected()) return
    if (currentMessages.length) return
    const ci = window.TechableCheckIn
    if (ci?.isActive?.()) return

    // Once the day's check-in is behind them, opening the chat is just opening
    // the chat — and it should still be greeted, not silent. That was the gap:
    // the only thing that ever spoke first was the check-in, so on the second
    // visit of the day the companion said nothing at all.
    //
    // Asked once, and only once. The marker is written when the check-in opens,
    // not when it ends, so leaving the tab and coming back gets the ordinary
    // greeting rather than "How are you feeling today?" a second time. It is
    // read inside the timer rather than before it, because a check-in can start
    // during those 350ms.
    //
    // It is offered now, not started: a new senior trying the app was dropped
    // into "How are you feeling today?" before anything else, and then asked
    // about their day again and again (audits/P3-senior-feedback.md, items 1
    // and 2). The greeting asks whether they would like to play; saying yes, or
    // simply answering with how they feel, starts it — see answerOffer().
    setTimeout(() => {
      const c = window.TechableCheckIn
      // The first-visit welcome is on screen: the greeting comes after it.
      if (activeTab !== 'conversation' || currentMessages.length || onb.open) return
      if (c?.isActive?.()) return
      if (!getSelected()) return
      greet({ offerGame: shouldOfferGame() })
    }, 350)
  }

  function mobileSwitchTab(name) {
    switchTab(name)
    closeDrawer()
  }

  function toggleDrawer() {
    const overlay = $('mob-overlay')
    const drawer = $('mob-drawer')
    const isOpen = drawer?.classList.contains('open')
    overlay?.classList.toggle('open', !isOpen)
    drawer?.classList.toggle('open', !isOpen)
  }

  function closeDrawer() {
    $('mob-overlay')?.classList.remove('open')
    $('mob-drawer')?.classList.remove('open')
  }

  function dirty() {
    dirtyState = true
  }

  async function init() {
    try {
      await waitForAuth()
      await initFirestore()
    } catch (err) {
      console.warn('Auth/DB unavailable:', err)
    }

    setBadge()
    await reloadResidents()
    await applyCompanionPreferences()
    document.body.classList.add('companion-ready')
    window._companionLayoutReady=true
    const authOverlay=$('auth-loading');if(authOverlay)authOverlay.style.display='none'
    clearTimeout(window._seniorStartupTimer)
    const starting=$('companion-starting');if(starting)starting.style.display='none'
    setBadge()

    // Voice output button state (voice list can populate asynchronously).
    Voice.syncButton()
    loadChatMode()

    // Built now rather than on the first tap of the mic — see ensureRecognition()
    // for why this is safe before any gesture: it does not touch the microphone.
    if (speechInputSupported()) ensureRecognition()

    // Before anything can be spoken, so the greeting — the line most likely to
    // be held for the first touch, and the one the original report started
    // with — is reported like every other.
    readVoiceTellParam()
    Voice.onSpoke = noteSpokenBy

    // Wake the speech function now rather than on the first tap. The probe is a
    // GET that synthesises nothing, so it needs no gesture and nobody is
    // waiting on it — whereas waiting until the tap put the cold start on the
    // very request the senior was listening for. Then make the opening line
    // itself, so it is ready before the Chat tab is even opened.
    Voice.warm()
    // Nobody is waiting on this and nothing downstream depends on it, so a
    // failure inside it must not become an unhandled rejection on the page.
    primeOpeningLine().catch(() => {})

    // The browser will not play audio until the page has been touched. Noting
    // the first touch lets a line that arrived before it still be spoken.
    ;['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
      window.addEventListener(ev, noteGesture, { once: true, capture: true, passive: true }))

    if (Voice.supported() && typeof speechSynthesis !== 'undefined') {
      speechSynthesis.onvoiceschanged = () => Voice.syncButton()
    }

    // The text field itself is only ~26px tall, but the padded bar around it
    // looks like one big input. Tapping the padding now focuses the field, so
    // an imprecise tap lands somewhere useful instead of nowhere.
    document.querySelector('.input-wrap')?.addEventListener('click', ev => {
      if (ev.target.closest('button, textarea, input, a')) return
      $('chat-input')?.focus()
    })

    // A mic button that silently does nothing is worse than no button. Where
    // the browser has no speech recognition (Firefox, and iOS outside Safari),
    // mark it disabled so it is announced as unavailable and skipped by
    // keyboard navigation, and say why on the status line.
    if (!speechInputSupported()) {
      ;['mic-btn', 'guess-mic', 'talk-btn'].forEach(id => {
        const b = $(id)
        if (!b) return
        b.disabled = true
        b.setAttribute('aria-disabled', 'true')
        b.setAttribute('aria-label', 'Speaking is not supported in this browser — please type instead')
        b.title = 'Speech input is not supported in this browser. Please type your message.'
      })
      const status = $('status-line')
      if (status) status.textContent = 'Speaking is not supported in this browser — please type your message.'
    }

    sessionStartedAt = new Date()

    document.querySelectorAll('.overlay').forEach(overlay => {
      overlay.addEventListener('click', e => {
        if (e.target === overlay) overlay.classList.remove('open')
      })
    })

    window.addEventListener('beforeunload', e => {
      if (dirtyState) {
        e.preventDefault()
        e.returnValue = ''
      }
    })

    // Residents and role are settled — checkin.js can safely render now.
    document.dispatchEvent(new CustomEvent('techable:ready'))
  }

  Object.assign(window, {
    openAddModal,
    createRes,
    closeModal,
    filterRes,
    selectRes,
    renderList,
    switchTab,
    mobileSwitchTab,
    saveProfile,
    deleteResident,
    dirty,
    addMem,
    deleteMem,
    send,
    newSession,
    saveSession,
    finishChat,
    startNewChat,
    printStory,
    centreCardAction,
    renderHistory,
    renderChips,
    toggleMic,
    toggleVoice,
    toggleChatMode,
    resetSamples,
    clearAll,
    toggleDrawer,
    randomizeAvatar,
    previewAvatarSeed,
    onCommunitySelect,
    setResidentLanguage,
    fillWellnessFromLatest,
    saveWellnessForm,
    saveBenefitDraft,
    copyBenefitSummary,
    saveMyDetails,
    copyMyDetails
  })

  // ── Bridge for checkin.js (Guess My Day) ──────────────────────
  // app.js is an IIFE, so the check-in module gets an explicit, minimal
  // surface rather than reaching into internals. Everything the game needs to
  // read state, add turns to the live transcript, and persist a result.
  window.TechableApp = {
    getSelected,
    residentContext,
    askAI,
    // Asked only when the check-in's own pattern lists could not read a
    // sentence. Returns null on every failure, so the caller keeps the
    // behaviour it had before this existed.
    understand,
    // The offline reader, for the check-in's own fallback: it names what was
    // said instead of a line that would follow anything. null when it has
    // nothing specific to say.
    localReply: (text, signals) => localReply(text, { ...signals, checkin: true }),
    persistSession,
    getCheckIns,
    moodToScore,
    showToast,
    esc,
    speak: (text, onDone) => { if (activeTab === 'conversation') Voice.speak(text, onDone) },
    stopSpeaking: () => Voice.stop(),
    pauseChatAudio,
    // Which voice spoke the last line, and what it cost. Also reachable from
    // the console as TechableApp.voiceTell(true) for anyone who did not think
    // to put ?voicetell=1 in the address bar before the quota ran out.
    voiceTell: on => setVoiceTell(on !== false),
    lastSpokenBy: () => Voice.spoken,
    // Whether the page has been touched yet. Until it has, no audio can play —
    // so the check-in uses this to decide whether its opening question has
    // actually reached the person it is meant for.
    hasGestured: () => Voice.gestured,
    // Synthesise a line the check-in already knows it is about to say, while
    // the senior is still answering the previous one.
    primeSpeech: text => Voice.prime(text),
    // Test surface, same convention as checkin.js's _read. What gets spoken
    // aloud is the one output nobody can eyeball in a diff, so the text
    // preparation and the voice ranking are checked directly.
    _voice: {
      clean: t => Voice.clean(t),
      sentences: t => Voice.sentences(t),
      pickLocalVoice: () => Voice.pickLocalVoice(),
      lead: t => Voice.lead(t),
      givenName,
      greetingText,
      // The give-up policy, which decides whether the senior keeps hearing the
      // companion's voice or finishes the visit with the operating system's.
      strike: () => Voice.strike(),
      cloudOn: () => Voice.cloud !== false,
      resetCloud: () => { Voice.cloud = null; Voice.strikes = 0; Voice.coolOffUntil = 0 },
      // How long the senior can be left in silence before the device voice
      // takes over, and what a failure is taken to mean. Between them these
      // decide whether a spent quota is heard as a pause or as a wait.
      firstWordBudget: t => Voice.firstWordBudget(t),
      setFirstWord: (base, perChar) => {
        Voice.FIRST_WORD_MS = base
        if (perChar !== undefined) Voice.FIRST_WORD_PER_CHAR = perChar
      },
      // What the engine has actually been timed at, as against what it was
      // guessed at. The point of the whole mechanism is that these differ.
      // The transcript exactly as persistSession() will hand it to localStorage
      // and Firestore. The tell is deliberately not part of it, and that is
      // worth asserting rather than trusting: hanging it on the message was the
      // obvious way to write this feature and would have doubled the size of
      // every saved AI turn.
      transcript: () => JSON.parse(JSON.stringify(currentMessages)),
      // init() does this for the page. The suite does not run init(), so
      // without a way to wire the same listener by hand the test below asserted
      // against a report that was never delivered — and passed with the fault it
      // was written to catch put back in.
      wireTell: () => { Voice.onSpoke = noteSpokenBy },
      note: (ms, chars) => Voice.note(ms, chars),
      perChar: () => Voice.perChar(),
      samples: () => Voice.samples.length,
      resetSamples: () => { Voice.samples = [] },
      noteFailure: err => Voice.noteFailure(err),
      cloudReady: () => Voice.cloudReady(),
      // Who spoke, and why it was not the good voice. The whole point is that
      // this is not answerable by ear, so it is worth asserting directly.
      spoken: () => Voice.spoken,
      whyLocal: cfg => Voice.whyLocal(cfg),
      whyFailed: err => Voice.whyFailed(err),
      tellText: info => voiceTellText(info),
      coolOffFor: () => Math.max(0, Voice.coolOffUntil - Date.now()),
      fetchOrRetry: t => Voice.fetchOrRetry(t),
      clearCache: () => { Voice.cache.clear(); Voice.rates.clear(); Voice.inflight.clear() },
      // The autoplay gate. What is held here is the companion's opening line,
      // and losing it is the difference between a senior being spoken to and
      // being met with silence — so it is worth a test of its own.
      speak: (t, done) => Voice.speak(t, done),
      stop: () => Voice.stop(),
      unlock: () => Voice.unlock(),
      held: () => Voice.pending?.text ?? null,
      resetGesture: () => { Voice.gestured = false; Voice.pending = null }
    },
    // Test surface for the speech-input timing this feature is about. init()
    // is not run by the suite (it needs auth and Firestore), so `ensure`
    // stands in for the early build init() does, and `instance` hands back
    // the recogniser itself so a test can fire its events the way a real
    // browser would.
    _mic: {
      ensure: () => ensureRecognition(),
      isBuilt: () => Boolean(recognition),
      instance: () => recognition,
      audioStarted: () => micAudioStarted,
      restartPending: () => micRestartPending
    },
    // What a companion should call this person out loud: their first name, or
    // whatever staff put in `preferredName`. checkin.js speaks the senior's
    // name more than anything else in the app, so it reads it from here rather
    // than from the record.
    speakableName,
    listen: micListen,
    isListening: () => recognizing,
    voiceOutputOn: () => Voice.enabled() && Voice.supported(),
    // True when the chat is in talking mode and the browser can hear — the
    // check-in uses this to decide whether to reopen the mic after a prompt.
    handsFree: () => activeTab === 'conversation' && chatMode === 'voice' && speechInputSupported(),
    // Non-null when the last reply came from the offline fallback instead of
    // the model. The check-in surfaces this rather than letting a canned line
    // pass for an AI answer.
    aiError: () => lastAIError,
    switchTab,
    isManager,
    isResident,
    newSession,
    pushMessage(role, text) {
      currentMessages.push({ role, text, at: nowIso() })
      renderChat(false)
      updateSessionStats()
    },
    messageCount: () => currentMessages.length,
    // Test surface for the send path, same convention as _voice above. Two
    // taps on one sentence is the fault this exists to hold shut, and the only
    // honest way to check it is to make both calls against the real function
    // while a reply is still in the air.
    _chat: {
      seed(resident) {
        residents = [resident]
        selectedId = resident.id
        currentMessages = []
        savedCount = 0
        savedAt = null
        conversationEnded = false
        conversationSeq++
        shortStreak = 0
        offeredToStop = false
        pendingOffer = null
        storyMode = null
        storyEditing = storyWriting = null
        lastSent = { text: '', at: 0 }
      },
      send,
      // What micCommit() does with the words it heard, without a recogniser.
      sendSpoken: text => { micShow(text); sendFromMic = true; return send() },
      ended: () => conversationEnded,
      shortStreak: () => shortStreak,
      pendingOffer: () => pendingOffer,
      // The tiles on screen under the greeting, and a tap on one of them.
      starters: () => (startersWanted() ? currentStarters().list.map(s => ({ kind: s.kind, label: s.label, ask: s.ask || '' })) : []),
      tapStarter,
      autosave,
      transcript: () => JSON.parse(JSON.stringify(currentMessages)),
      sendDisabled: () => Boolean($('send-btn')?.disabled),
      // The latch is per-visit and one-way by design, which is exactly what
      // makes it worth a test — and what makes the test need a way to lift it.
      resetUnderstand: () => { understandOff = false }
    },
    // The life story book: the same functions My Story's buttons call.
    _story: {
      chapters: () => STORY_CHAPTERS.slice(),
      normalize: normalizeLifeStory,
      mode: () => (storyMode ? { chapter: storyMode.chapter, turns: storyMode.turns } : null),
      start: startStory,
      add: (chapter, text) => addStoryEntry(chapter, text),
      edit: editStoryEntry,
      saveBlog: saveBlogEntry,
      remove: removeStoryEntry,
      render: renderStory,
      print: printStory,
      capture: maybeCaptureStory,
      suggestions: () => storySuggestions(),
      keep: keepStorySuggestion,
      dismiss: dismissStorySuggestion,
      chapterOf: storyChapterOf
    },
    // The family inbox: the same functions the Family screen's buttons call.
    _inbox: {
      load: loadInbox,
      notes: () => trustedNotes().map(n => ({ ...n })),
      requests: () => senderRequests().map(x => ({ ...x })),
      // Who is connected to the senior, and who is asking to be (F32).
      links: () => links.list.map(l => ({ ...l })),
      loadLinks,
      // "Let my family find me": the directory as this visit leaves it, and
      // the switch.
      directory: () => ensureSeniorLinkDirectory(getSelected()),
      setFindable,
      render: renderFamily,
      act: inboxAction,
      // A page load's worth of state, for a suite that plays several visits.
      reset: () => {
        inbox = { loaded: false, failed: false, notes: [] }
        links = { loaded: false, failed: false, list: [] }
        heardHere.clear(); noteMedia.clear(); famOpen.clear()
        inboxDeclined = false
      }
    },
    // Firestore mode without Firebase. The suites never run init(), and the
    // SDK is a URL import Node cannot load, so a recorder stands in for the
    // module and a test can see the exact write the rules will judge — the
    // rules check fields by name, and a write they do not expect is denied.
    // null puts the page back in localStorage mode.
    _store: {
      useFirestore(o) {
        fs = o?.fs || null
        db = o?.db || null
        authUser = o ? (o.user || null) : null
        if (o?.role) role = o.role
        if (o && 'userDoc' in o) userDoc = o.userDoc
        usingFirestore = firestoreReady = Boolean(o)
      },
      useRole(r) { role = r },
      reloadCommunities: () => loadCommunities()
    },
    // The first-visit welcome: the same actions its buttons and fields send.
    _onboarding: {
      start: startVisit,
      shouldShow: shouldOnboard,
      state: () => ({ open: onb.open, mode: onb.mode, step: onb.step, name: onb.name,
        interests: [...(onb.interests || [])], family: [...(onb.family || [])] }),
      act: onbAct,
      goTo(step) {
        if (!onb.open) openOnboarding(step === 'centre' ? 'centre' : 'full')
        onb.step = step
        renderOnboarding()
      }
    },
    _centre: {
      load: loadCentreRequests,
      sync: syncCentreLink,
      action: centreCardAction
    },
    todaysCheckIn() {
      const r = getSelected()
      if (!r) return null
      const today = new Date().toDateString()
      return getCheckIns(r.id).find(c => new Date(c.savedAt).toDateString() === today) || null
    }
  }


  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
