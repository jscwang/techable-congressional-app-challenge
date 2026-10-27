// ============================================================
// checkin.js — "Guess My Day" daily mood check-in
//
// A short (1–2 minute) voice-first check-in that runs *inside* the existing
// companion chat rather than as a separate game screen. Every turn is pushed
// into the live transcript via the TechableApp bridge, so a check-in saves as
// an ordinary session that the family and provider dashboards already read —
// plus a structured `checkIn` record for the wellbeing history.
//
// Flow
//   1. Ask how they feel today        → 4 large buttons (or voice)
//   2. If that answer is "okay", ask which way it leans before guessing
//   3. Up to 3 gentle guesses         → Yes / Not quite / Try again
//   4. Free text ("what's on your mind") if we miss, or to add detail
//   5. One supportive reply + one follow-up question, then save
//
// MVP guess ranking is rule-based: predefined categories per mood, re-ordered
// by what the Memory Bank and profile already know about this person. No model
// is required for the guessing itself — the AI is used only for the closing
// supportive reply, and there is a canned fallback when it is unavailable.
//
// LANGUAGE
// Every sentence the senior hears comes from i18n.js, so the whole check-in
// runs in English, Mandarin or Cantonese. The saved record stays in English —
// see the note at the top of that file. Nothing here should contain a
// senior-facing string literal; if you are adding one, add a key instead.
//
// SAFETY — this feature must never behave like a clinician:
//   • It records only what the senior reports. It does not diagnose, score
//     symptoms, or infer depression/dementia/any condition.
//   • Urgent disclosures (falls, breathing trouble, abuse, not eating,
//     self-harm) abort the session immediately and raise an escalation.
// ============================================================

(function () {
  'use strict'

  const App = () => window.TechableApp
  const MAX_GUESSES = 3

  // Language shortcuts. I18n() is looked up lazily so the module still loads
  // if i18n.js is missing, and falls back to the key name rather than throwing
  // mid-conversation.
  const I18n = () => window.TechableI18n
  const TEn  = (key, vars) => I18n()?.en(key, vars) ?? key
  const T    = (key, vars) => (forceEn ? TEn(key, vars) : (I18n()?.t(key, vars) ?? key))

  // The saved record is read by staff, not by the senior, so the few lines
  // that go into it are rendered in English whatever the check-in was spoken
  // in. Wrapping the call is simpler than a parallel set of English-only
  // builders for guess wording that already exists.
  let forceEn = false

  function inEnglish(fn) {
    forceEn = true
    try { return fn() } finally { forceEn = false }
  }

  // ── Moods ─────────────────────────────────────────────────────
  // Storage keys stay as they are ('good' etc.) so existing check-in history and
  // the wellnessScore mapping keep working; only the wording shown changed.
  //
  // `tone` is what the mood implies about the day, and it decides which guesses
  // are even eligible. 'okay' has no tone on purpose: see askLean().
  const MOODS = [
    { key: 'good',  emoji: '😊', tone: 'positive' },
    { key: 'okay',  emoji: '🙂', tone: null       },
    { key: 'low',   emoji: '😔', tone: 'negative' },
    { key: 'tired', emoji: '😴', tone: 'negative' }
  ]

  // What the senior sees, in their language. What the record stores is always
  // English, so the family and provider dashboards read the same either way.
  const moodLabel   = key => T('mood.' + key)
  const moodLabelEn = key => TEn('mood.' + key)


  // ── Guess categories ──────────────────────────────────────────
  // `needs` lists profile/memory fields that make a guess personal. A guess
  // whose needs are unmet is still usable, but ranks below one we can ground
  // in something the senior actually told us.
  //
  // A guess is not a dead end. When one lands, `then` carries the conversation
  // on: a follow-up question about that same subject, and a warm human reply
  // to whichever answer they give. That is what turns the check-in from a form
  // into a short chat — the guess IS the conversation, not a data-collection
  // step that happens before one.
  //
  // TONE IS A HARD FILTER, NOT A PREFERENCE.
  //
  // A guess names a cause, and a cause implies a direction. "Is it because you
  // had a nice chat with someone?" only makes sense for a good day; "is it
  // because you did not sleep well?" only for a hard one. These used to share
  // the 'neutral' tone, so a senior who said "okay" was asked both in turn —
  // first told their day sounded lovely, then that it sounded rotten, in two
  // consecutive questions. Worse, a hobby the person had told us they LOVE was
  // offered as the explanation for feeling unwell.
  //
  // So: positive-cause guesses are eligible only for a positive day, and
  // negative-cause ones only for a hard day. When we do not know which it is,
  // the pool is the direction-free questions at the bottom, which assume
  // nothing about how the day went.
  //
  // Wording lives in i18n.js under `guess.<id>.*`; `options[].key` selects the
  // label and the reply, so a follow-up needs no strings here at all.
  const GUESSES = [
    // ── Positive-cause ──
    { id: 'family', topic: 'family', tone: ['positive'],
      needs: ['family'], concern: null,
      ask: ctx => T('guess.family.ask', { who: ctx.familyName || T('guess.family.who') }),
      then: {
        ask: () => T('guess.family.then'),
        options: [
          { key: 'yes', emoji: '📅', value: 'soon' },
          { key: 'no',  emoji: '🤔', value: 'unsure' }
        ]
      } },

    { id: 'hobby', topic: 'hobbies', tone: ['positive'],
      needs: ['hobby'], generic: true, concern: null,
      // Two shapes, because a hobby is either something they DO ("going on
      // walks near the river") or something they HAVE ("her rose garden"), and
      // one sentence cannot carry both. Producing "you spent some time on go on
      // walks near the river" is how this read before.
      ask: ctx => {
        const h = ctx.hobby
        if (!h?.phrase || !I18n()?.fitsScript(h.phrase)) return T('guess.hobby.ask')
        return T(h.kind === 'activity' ? 'guess.hobby.ask.activity' : 'guess.hobby.ask.thing',
          { hobby: h.phrase })
      },
      then: {
        ask: () => T('guess.hobby.then'),
        options: [
          { key: 'yes', emoji: '😊', value: 'yes' },
          { key: 'no',  emoji: '🙂', value: 'little' }
        ]
      } },

    { id: 'friends', topic: 'friends', tone: ['positive'],
      needs: [], concern: null,
      ask: () => T('guess.friends.ask'),
      then: {
        ask: () => T('guess.friends.then'),
        options: [
          { key: 'yes', emoji: '💬', value: 'yes' },
          { key: 'no',  emoji: '🤝', value: 'no' }
        ]
      } },

    { id: 'event', topic: 'events', tone: ['positive'],
      needs: ['event'], concern: null,
      ask: ctx => T('guess.event.ask', { event: ctx.event || T('guess.event.what') }),
      then: {
        ask: () => T('guess.event.then'),
        options: [
          { key: 'yes', emoji: '🎉', value: 'soon' },
          { key: 'no',  emoji: '⏳', value: 'later' }
        ]
      } },

    // ── Either direction, given a real reading ──
    // The weather is the one cause that genuinely explains a good day or a bad
    // one, so it sits in both pools — but only when we actually know what the
    // sky is doing. It is excluded from the direction-free pool: "is it because
    // of the weather?" still presumes the day had a cause worth explaining.
    { id: 'weather', topic: 'weather', tone: ['positive','negative'],
      needs: [], concern: null,
      ask: () => T('guess.weather.ask'),
      // With no live reading, the weather is the blandest guess available —
      // asking an exhausted person "is it because of the weather?" is exactly
      // the kind of empty question that makes the companion feel unlistening.
      // Demote it below the mood-specific guesses unless we know.
      boost: s => {
        const w = s.__weather
        if (!w) return -2
        if (s.__tone === 'positive') return w.pleasant ? 3 : -1
        if (s.__tone === 'negative') return (w.wet || !w.pleasant) ? 2 : -1
        return 0
      },
      then: {
        // Uses the real reading when we have one — "I had a look, it is light
        // rain, around 24°C" — and stays vague when we do not. It must never
        // claim to have checked something it has not.
        ask: S => S.weather
          ? T('guess.weather.then.known', { summary: weatherSummary(S.weather) })
          : T('guess.weather.then'),
        options: [
          { key: 'yes', emoji: '🌳', value: 'yes',
            replyKey: S => S.weather?.wet ? 'yes.reply.wet' : 'yes.reply' },
          { key: 'no', emoji: '🪟', value: 'no',
            // Never suggest going out to someone whose profile notes pain or
            // arthritis, or who has mentioned discomfort this session — and
            // never suggest it into the rain.
            replyKey: S => {
              if (S.concerns.includes('discomfort') || S.ctx?.has?.pain) return 'no.reply.pain'
              if (S.weather?.wet) return 'no.reply.wet'
              if (S.weather && !S.weather.pleasant) return 'no.reply.dull'
              return 'no.reply'
            } }
        ]
      } },

    // ── Negative-cause ──
    { id: 'sleep', topic: 'sleep', tone: ['negative'],
      needs: [], concern: 'sleep',
      ask: () => T('guess.sleep.ask'),
      then: {
        ask: () => T('guess.sleep.then'),
        options: [
          { key: 'yes', emoji: '😌', value: 'yes' },
          { key: 'no',  emoji: '😕', value: 'no' }
        ]
      } },

    { id: 'pain', topic: 'health', tone: ['negative'],
      needs: [], concern: 'discomfort',
      ask: ctx => (ctx.painSite && I18n()?.fitsScript(ctx.painSite))
        ? T('guess.pain.ask.site', { site: ctx.painSite })
        : T('guess.pain.ask'),
      then: {
        ask: () => T('guess.pain.then'),
        options: [
          { key: 'yes', emoji: '👍', value: 'yes' },
          { key: 'no',  emoji: '🤫', value: 'no' }
        ]
      } },

    // Never hand a lonely person off to staff. The whole point of the
    // companion is that it is the one who stays — see guess.lonely.yes.reply.
    { id: 'lonely', topic: 'loneliness', tone: ['negative'],
      needs: [], concern: 'loneliness',
      ask: () => T('guess.lonely.ask'),
      then: {
        ask: () => T('guess.lonely.then'),
        options: [
          { key: 'yes', emoji: '📞', value: 'yes' },
          { key: 'no',  emoji: '🙂', value: 'no' }
        ]
      } },

    { id: 'appetite', topic: 'food', tone: ['negative'],
      needs: [], concern: 'appetite',
      ask: () => T('guess.appetite.ask'),
      then: {
        ask: () => T('guess.appetite.then'),
        options: [
          { key: 'yes', emoji: '🍵', value: 'yes' },
          { key: 'no',  emoji: '😕', value: 'no' }
        ]
      } },

    { id: 'famworry', topic: 'family', tone: ['negative'],
      needs: ['family'], concern: 'family',
      ask: ctx => T('guess.famworry.ask', { who: ctx.familyName || T('guess.famworry.who') }),
      then: {
        ask: () => T('guess.famworry.then'),
        options: [
          { key: 'yes', emoji: '📞', value: 'recent' },
          { key: 'no',  emoji: '🕰', value: 'long' }
        ]
      } },

    // ── Direction-free ──
    // For a day that is genuinely neither good nor bad. None of these names a
    // cause, so none of them can get the mood backwards. They are plain
    // questions rather than guesses, and answerGuess() labels the buttons
    // accordingly (Yes / Not sure / No, not Yes / Not quite / Try again).
    { id: 'quiet', topic: 'day', tone: ['neutral'], kind: 'question',
      needs: [], concern: null,
      ask: () => T('guess.quiet.ask'),
      then: {
        ask: () => T('guess.quiet.then'),
        options: [
          { key: 'yes', emoji: '🌿', value: 'peaceful' },
          { key: 'no',  emoji: '🕰', value: 'dragged' }
        ]
      } },

    { id: 'routine', topic: 'day', tone: ['neutral'], kind: 'question',
      needs: [], concern: null,
      ask: () => T('guess.routine.ask'),
      then: {
        ask: () => T('guess.routine.then'),
        options: [
          { key: 'yes', emoji: '🙂', value: 'yes' },
          { key: 'no',  emoji: '🔄', value: 'no' }
        ]
      } },

    { id: 'outing', topic: 'day', tone: ['neutral'], kind: 'question',
      needs: [], concern: null,
      ask: () => T('guess.outing.ask'),
      then: {
        ask: () => T('guess.outing.then'),
        options: [
          { key: 'yes', emoji: '🚶', value: 'yes' },
          { key: 'no',  emoji: '🏠', value: 'no' }
        ]
      } }
  ]

  // ── Resolving a follow-up option ──────────────────────────────
  // Options carry a key, not a sentence, so both the button label and the warm
  // reply come from the language pack. `replyKey` exists for the handful that
  // change wording with the weather or with what has already been reported.
  function optionLabel(g, o) {
    return T(`guess.${g.id}.${o.key}`)
  }

  function optionReply(g, o, state) {
    const suffix = typeof o.replyKey === 'function' ? o.replyKey(state) : `${o.key}.reply`
    return T(`guess.${g.id}.${suffix}`)
  }

  // The English weather line from OpenWeather ("Light rain, around 24°C") is
  // fine to speak in English and jarring in the middle of a Cantonese
  // sentence, so other languages get one built from the flags instead.
  function weatherSummary(w) {
    if (!w) return ''
    if (I18n()?.code() === 'en') return lowerFirst(w.summary || '')
    const cond = T(w.wet ? 'weather.cond.wet' : w.pleasant ? 'weather.cond.fine' : 'weather.cond.dull')
    return Number.isFinite(w.temp) ? T('weather.summary', { cond, temp: w.temp }) : cond
  }

  // ── Safety ────────────────────────────────────────────────────
  // Deliberately broad. A false positive costs one gentle hand-off to a human;
  // a false negative costs far more. Word-boundary matched to avoid catching
  // substrings ("fell" inside "fellow", "ate" inside "grateful").
  //
  // Broad is not the same as careless, though, and the difference showed up the
  // first time anyone read the matches out loud. "I fell asleep in front of the
  // television" — about the most ordinary answer a check-in ever gets — raised
  // an EMERGENCY, ended the conversation and put a hand-off notice in front of
  // the senior. So did fell behind, fell in love, fell out with, fell about
  // laughing, and a radiator that needs bleeding.
  //
  // That is not the accepted cost of a broad net; it is the net catching the
  // wrong thing most days. A carer paged for "I fell asleep after lunch" every
  // afternoon stops reading the pages — which manufactures precisely the missed
  // disclosure the breadth was there to prevent. So `not` vetoes the idioms and
  // nothing else: every real report below still escalates exactly as it did.
  const URGENT = [
    // Requires a subject or a directional particle: the senior always speaks in
    // the first person here, so bare "fell" ("the weather fell cooler") is noise.
    //
    // What that missed is the sentence with a verb in the middle of it. "I
    // slipped and fell", "I tripped and fell last night" and "I lost my balance
    // and fell" all scanned completely clean — the companion answered them
    // conversationally and the day was filed with a mood of "okay" — because no
    // subject sat next to "fell" and no direction followed it. Slipping,
    // tripping and losing your balance are what comes before a fall, so they
    // stand in for the missing "I fell" — still with the person named, because
    // "the plate slipped and fell" is a dropped plate. "Had a fall" needed the
    // same room: "I had a bit of a fall" is how the ones people are playing
    // down get reported.
    { flag: 'fall',      level: 'emergency',
      re:  /\b(i|he|she|they|we)\s+(fell|have fallen|has fallen|had a fall)\b|\bhad a\b[^.!?]{0,12}?\bfall\b|\bfell (down|over|in|on)\b|\bi'?ve fallen\b|\bfallen (down|over)\b|\b(i|he|she|they|we)\b[^.!?]{0,16}?\b(slipped|tripped|stumbled|lost (?:my|his|her|their) balance)\b[^.!?]{0,40}?\bfell\b/i,
      // What follows "fell" is the whole difference, and each entry here had to
      // be checked in the other direction too — a veto that swallows a real
      // fall is worse than the false positive it was written to remove.
      //
      // Two did, on the first attempt. "fell flat" looked figurative until "I
      // fell flat on my face in the hallway", and it was protecting nothing:
      // "the joke fell flat" never matched `re` in the first place, which needs
      // a first-person subject or a directional particle. And bare "behind"
      // swallowed "I fell behind the sofa and could not get up" — a fall, and
      // the long-lie one that matters most — so only the figurative
      // prepositions are vetoed and "fell behind the/a/my" still escalates.
      //
      // Note what else is NOT vetoed: "fell out OF bed" and "fell into the
      // pond" are falls, so only "out with/over" and the figurative "into
      // place/step/line" are excluded.
      not: /\b(fell|fallen)\s+(asleep|behind\s+(?:with|on|in)\b|in love|in with|out with|out over|about|silent|short|for it|on deaf ears|into (?:place|step|line|conversation))\b/i },
    { flag: 'breathing', level: 'emergency', re: /\b(can'?t breathe|cannot breathe|trouble breathing|short of breath|chest pain)\b/i },
    // Contractions are spelled out as often as not in speech-to-text output,
    // so every negation here accepts both "don't" and "do not".
    { flag: 'self_harm', level: 'emergency', re: /\b(kill myself|end my life|hurt myself|harm myself|want to die|no reason to (live|go on)|better off (dead|without me)|do(n'?t| not) want to (live|be here|wake up)|do(n'?t| not) want to go on|tired of living)\b/i },
    { flag: 'abuse',     level: 'urgent',
      // Bare "abuse" was filing an abuse flag against the senior for other
      // people's lives: "my grandson has a problem with substance abuse" and
      // "that poor dog was abused" both escalated. The word only means this
      // when the senior is the one it is being done to.
      re:  /\b(hit me|hurting me|abus(?:e[sd]?|ing) me|(?:i'?m|i am|i was|i'?ve been|i have been)\s+(?:being\s+)?abused|threatened me|scared of (him|her|them)|took my money)\b/i,
      // "She hit me with the news that she is moving" is how people describe
      // being told something. Deliberately narrow: "he hit me with a stick" is
      // an assault and still escalates, so only the figurative objects are here.
      // "one" is deliberately absent: "he hit me with one" is as likely to be a
      // fist as a piece of news, and an ambiguous assault escalates.
      //
      // The second veto is for the machines. "The parking meter took my money"
      // raised an abuse flag on an elderly person's care record — a flag a care
      // provider has to work through — for a ticket machine. Named takers only,
      // so "my son took my money" is untouched.
      not: /\bhit me with (?:the|that|this|some|a bit of)?\s*(news|idea|question|thought|fact|bombshell|realisation|realization)\b|\b(?:machine|meter|bus|train|tram|shop|till|card reader|kiosk|pump|phone|computer)s?\s+(?:just\s+|has\s+|had\s+)?took my money\b/i },
    // ── Feeling like a burden ──
    // Perceived burdensomeness is one of the strongest risk indicators there is
    // in an older adult, and it was the one thing this list had no word for.
    // "I feel like a burden to everyone" scanned clean — while "better off
    // without me", which is the same thought said a different way, escalated.
    //
    // Urgent rather than emergency, and its own flag rather than folded into
    // self_harm, because the right response is different: this is passive, a
    // person should look at it today, and the wording a senior sees is the
    // gentler of the two. Raise the level here if your care protocol says so —
    // it is one word, and the hand-off is identical either way.
    { flag: 'burden',    level: 'urgent',
      // "In the way" had no person in it, so the furniture said it too: "the
      // table was in the way" and "my walking frame was in the way" each paged a
      // carer about perceived burdensomeness. Worse than noise — "the rug was in
      // the way and I nearly went over" reached a carer as a burden disclosure
      // when what it describes is a near-fall. The senior has to be the one in
      // the way, not the one who left something in it, so only the words people
      // put between "I" and "in the way" — am, feel, keep, just, always — carry
      // it. "I put the chair in the way" and "I am not in the way" both break
      // the chain and stay quiet.
      re: /\b(burden (?:to|on)\b|a burden\b|\bi(?:'?m|'?ve)?\b(?:\s+(?:just|always|only|forever|really|often|now|a bit|am|was|feel|felt|get|got|keep|been|being|be|have|had|do|getting|like))*\s+in (?:the|their|your|his|her|everyone'?s|everybody'?s)\s+way\b|no use to (?:anyone|anybody)|nobody would (?:miss|notice)|no one would (?:miss|notice)|taking up space|more trouble than i'?m worth)/i,
      // A burden LIFTED is relief — the opposite disclosure, and the same
      // words. The traffic and the bins used to be vetoed here too; now that
      // "in the way" needs a person in front of it they never match at all.
      not: /\bburden\s+(?:lifted|off\b|gone)|\blifted (?:a|the) burden/i },
    // A duration is the whole signal. "I have not eaten anything since
    // breakfast" is a normal thing to say at eleven in the morning — and it
    // says the person HAD breakfast — but it raised an urgent hand-off, which
    // is a hand-off most mornings for most people. Naming a meal as the
    // reference point means that meal happened; "in two days", "all day" and
    // "since yesterday" name no meal and still escalate.
    { flag: 'not_eating',level: 'urgent',
      re:  /\b(not eaten|haven'?t eaten|not eating|no food|nothing to eat|skipped meals)\b/i,
      not: /\b(?:since|after)\s+(?:my\s+)?(?:breakfast|lunch|lunchtime|dinner|dinnertime|tea|teatime|supper)\b(?!\s+(?:yesterday|last night|the day before))/i },
    { flag: 'bleeding',  level: 'emergency',
      re:  /\b(bleeding|blood everywhere|can'?t stop the blood)\b/i,
      // Radiators and brakes are bled; people bleed. Keyed on the verb form
      // rather than on the noun, so "I cut myself on the radiator and I am
      // bleeding" is still a disclosure.
      not: /\b(radiator|brake|pipe|valve|heating|system)s?\s+(?:needs?|wants?|to be|due (?:a|for))\s+bleed/i }
  ]

  // ── Where a veto applies ──────────────────────────────────────
  // Per pattern was not narrow enough. An idiom belongs to the clause it sits
  // in, and tested against the whole utterance it reached across the sentence
  // and cancelled a real disclosure carrying the same flag: "I fell asleep in
  // the chair, and later I fell over in the hallway" produced no escalation at
  // all, and neither did "I have not eaten since breakfast; honestly I have not
  // eaten in two days". Every pattern with a `not` could do it to itself.
  //
  // That shape is the normal one, not the odd one. The microphone is built to
  // stay open through the pauses in an older person's speech, so a senior
  // recounting their day arrives as one long string.
  //
  // So each match is judged on the clause around it — from the punctuation or
  // the "and" before it to the one after it. A break INSIDE a match is ignored,
  // so "I slipped and fell" is still read as one thing. "Since" and "after" are
  // deliberately not breaks: the not-eating veto has to see the meal on the far
  // side of them.
  const CLAUSE_BREAK = /[.!?;,\n。！？；，、]|\b(?:and|but|then)\b/gi

  function clauseAround(said, from, to) {
    let start = 0, end = said.length, b
    CLAUSE_BREAK.lastIndex = 0
    while ((b = CLAUSE_BREAK.exec(said))) {
      if (b.index + b[0].length <= from) start = b.index + b[0].length
      else if (b.index >= to) { end = b.index; break }
    }
    return said.slice(start, end)
  }

  // True only when every place the pattern matched is an idiom. One genuine
  // disclosure anywhere in the utterance is enough to escalate.
  function fullyVetoed(u, said) {
    const flags = u.re.flags.includes('g') ? u.re.flags : u.re.flags + 'g'
    const scan = new RegExp(u.re.source, flags)
    let m
    while ((m = scan.exec(said))) {
      if (!u.not.test(clauseAround(said, m.index, m.index + m[0].length))) return false
      // A pattern that can match nothing would spin here for ever, and the
      // thing that would stop it is the senior's browser giving up.
      if (!m[0]) scan.lastIndex++
    }
    return true
  }

  // Every language's disclosure patterns are scanned, not just the one the
  // check-in is running in. A Cantonese-speaking senior may well answer in
  // English, and speech-to-text regularly returns a mix; a fall must escalate
  // whichever language it was reported in.
  function scanUrgent(text) {
    const said = text || ''
    const all = URGENT.concat(I18n()?.allUrgent?.() || [])
    // `not` is optional — the language packs carry none.
    const hits = all.filter(u => u.re.test(said) && !(u.not && fullyVetoed(u, said)))
    if (!hits.length) return null
    return {
      flags: Array.from(new Set(hits.map(h => h.flag))),
      level: hits.some(h => h.level === 'emergency') ? 'emergency' : 'urgent'
    }
  }

  // ── Personalisation ───────────────────────────────────────────
  // Pull light hints out of the profile + Memory Bank so guesses reference
  // real people and real interests. Everything here is best-effort; a missing
  // hint just makes the guess more generic, never wrong.
  function buildContext() {
    const r = App()?.getSelected?.()
    if (!r) return {}

    const mems = Array.isArray(r.memories) ? r.memories : []
    const byTag = tag => mems.filter(m => (m.tag || '').toLowerCase() === tag)
    const text = [r.background, r.family, r.medical, ...mems.map(m => m.text)]
      .filter(Boolean).join(' ')

    return {
      // First name only. This is spoken aloud in every prompt of the check-in,
      // and "Good morning, Jessica Wang" is a receptionist reading a list.
      // app.js owns the derivation so the browser, the prompt and the greeting
      // all say the same thing.
      // No 'there' fallback. An empty name is ordinary — the name fields on
      // senior-login.html are optional — and substituting a filler word put it
      // into the middle of every sentence that addresses the senior: "Thank
      // you, there." in English, and "谢谢您，there。" in Chinese, which is an
      // English word dropped into a Chinese sentence. i18n's fill() removes the
      // address and the punctuation holding it instead, which reads correctly
      // in all three languages. See fill() in i18n.js.
      name: App()?.speakableName?.(r) || r.preferredName || r.name || '',
      familyName: firstName(r.family) || firstName(byTag('family')[0]?.text),
      hobby: hobbyPhrase(byTag('hobby')[0]?.text) || hobbyPhrase(r.background),
      event: shortPhrase(byTag('event')[0]?.text),
      painSite: matchFirst(text, /\b(knee|hip|back|shoulder|leg|hand|neck|foot|arm)\b/i),
      has: {
        family: Boolean(r.family || byTag('family').length),
        hobby:  Boolean(byTag('hobby').length || r.background),
        event:  Boolean(byTag('event').length),
        pain:   Boolean(matchFirst(text, /\b(pain|ache|arthritis|sore|knee|hip|back)\b/i))
      }
    }
  }

  // One person, so the word after it is usually their name: "Daughter Mary".
  const KIN = [
    'daughter','son','wife','husband','partner','spouse',
    'grandson','granddaughter','grandchild','child',
    'sister','brother','niece','nephew','cousin','aunt','auntie','uncle',
    'mother','father','mum','mom','dad','papa','mama','granny','grandma','grandpa','nan','nana',
    'friend','neighbour','neighbor','carer','caregiver','nurse','doctor'
  ]

  // More than one, or nobody in particular. What follows these is as likely to
  // be an occasion as a person — "Family Sunday roast", "Grandchildren
  // Saturday visits" — so they do not introduce a name.
  const GROUPS = [
    'daughters','sons','grandchildren','grandkids','children','kids','family','friends'
  ]

  // Never a person, wherever it turns up. Capitalised in ordinary writing and
  // nobody's name.
  //
  // The verb list matters: memories captured from conversation start with a
  // capitalised verb ("Has a son", "Used to be a teacher", "Enjoys gardening"),
  // and without it the guess became "Are you happy because Has may visit soon?"
  // — nonsense shown straight to the senior.
  //
  // The counting words are here because of a real report. "One daughter named
  // Jane. One son named Jude." made the companion ask an unwell senior "Is it
  // because you are missing One?" — the first capitalised word in the Family
  // field was the number, and nothing ruled it out.
  const NEVER_A_NAME = new RegExp('^(' + [
    'my','her','his','their','our','your','the','a','an','and','but','also','then','there',
    'one','two','three','four','five','six','seven','eight','nine','ten',
    'both','each','every','all','no','none','other','another','some','many','several',
    'she','he','they','we','it','you','who','that','this','these','those',
    // Prepositions. "Daughter in Sydney" must not introduce somebody called in.
    'in','on','at','of','from','with','to','by','near','for','about','around','over',
    'after','before','during','since','up','out','next','back',
    ...KIN, ...GROUPS,
    'has','have','had','is','was','are','were','likes','liked','loves','loved',
    'enjoys','enjoyed','used','grew','born','lived','lives','plays','played',
    'went','goes','gets','does','did','worked','works','misses','missed','wants','needs',
    'named','called','visits','visited','calls','comes','came','stays','stayed',
    'moved','married','retired','passed','died','helps','helped','lost','sees','saw',
    // How profile prose opens. A Family field is written in sentences, and the
    // capital at the front of one is far more often a description than a
    // person: "Widowed. Two children overseas." asked a senior whether they
    // were missing Widowed.
    'widowed','big','very','close','twin','twins','weekly','daily','monthly','yearly',
    'lovely','once','twice','sadly','happily','best','still','often','always','never',
    'recently','currently','mostly','usually','sometimes','occasionally','unfortunately',
    'formerly','previously','originally','raised','good','great','nice','kind','strong',
    'healthy','proud','elderly','young','older','younger','local','nearby','overseas'
  ].join('|') + ')$', 'i')

  // A person, or a date, depending entirely on the sentence around it. April,
  // May, June and August are ordinary given names for this generation, and Nan
  // is somebody's grandmother in one family and her name in another. So these
  // are refused only when nothing introduced them as a name: "Visits on
  // Sundays" names nobody, "One daughter named June" names June.
  const MAYBE_A_DATE = new RegExp('^(' + [
    'january','february','march','april','may','june','july',
    'august','september','october','november','december',
    'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
    // The occasions a family note is most likely to mention. Same rule: a
    // senior with a granddaughter called Eid still gets her name, because
    // "granddaughter Eid" goes through the introducer above and never reaches
    // this list.
    'christmas','easter','thanksgiving','halloween','birthday','anniversary',
    'diwali','deepavali','hanukkah','ramadan','eid','raya','hari','new','year'
  ].join('|') + ')$', 'i')

  // Plurals are checked against the singular rather than doubling the list, and
  // only for the dates — that is where the plural is the giveaway ("Sundays").
  // Doing it against every list is how "Wes" became "We" and stopped being a
  // name at all.
  const dateWord = w => MAYBE_A_DATE.test(w) || (/s$/i.test(w) && MAYBE_A_DATE.test(w.slice(0, -1)))

  const NAME_WORD = '[A-Z][a-z]{1,14}'
  // Written out in both cases rather than passing the 'i' flag, which would
  // also loosen NAME_WORD and let the pattern capture the lowercase word after
  // the relationship: "Daughter in Sydney" answered "you are missing in".
  const eitherCase = w => '[' + w[0].toUpperCase() + w[0] + ']' + w.slice(1)

  // A Family field written in Chinese. 叫 is how a name is introduced in both
  // packs — "個女叫 June" — and the kinship words are spelled out because a
  // manager working in Chinese has no reason to type an English one.
  const CJK_INTRO = '(?:叫|女兒|女儿|個女|个女|囡囡|兒子|儿子|個仔|个仔|孫女|孙女|孫仔|孙子|' +
                    '太太|老公|丈夫|妻子|姐姐|妹妹|哥哥|弟弟|朋友|鄰居|邻居)'

  // Who the family guesses name out loud. Best evidence first: a name that was
  // introduced as one ("named Jane", "son Jude") is a name; a bare capitalised
  // word only might be.
  const NAME_PATTERNS = [
    new RegExp('\\b(?:' + ['named', 'called'].map(eitherCase).join('|') + ')\\s+(' + NAME_WORD + ')\\b'),
    new RegExp('\\b(?:' + KIN.map(eitherCase).join('|') + ')\\s+(' + NAME_WORD + ')\\b'),
    new RegExp(CJK_INTRO + '\\s*(' + NAME_WORD + ')')
  ]

  const HAS_CJK = /[㐀-鿿豈-﫿]/

  function firstName(s) {
    if (!s) return null
    const text = String(s)

    // "One daughter named Jane" → Jane. "Daughter Mary visits on Sundays" → Mary.
    // A word introduced this way is taken as a name even if it is also a month.
    for (const re of NAME_PATTERNS) {
      const found = re.exec(text)?.[1]
      if (found && !NEVER_A_NAME.test(found)) return found
    }

    // Nothing introduced a name, so fall back to the first capitalised word
    // that could plausibly be one — and in an English sentence a date is not
    // one. In a Chinese one it is: Chinese writes its days and months in
    // Chinese, so a Latin word sitting in "個女叫 June" is a name and refusing
    // it named the son instead of the daughter.
    const dates = HAS_CJK.test(text) ? () => false : dateWord
    const m = text.match(new RegExp('\\b' + NAME_WORD + '\\b', 'g')) || []
    return m.find(w => !NEVER_A_NAME.test(w) && !dates(w)) || null
  }

  function shortPhrase(s) {
    if (!s) return null
    const clean = String(s).split(/[.;\n]/)[0].trim()
    if (!clean || clean.length > 48) return null
    return clean.charAt(0).toLowerCase() + clean.slice(1)
  }

  // A hobby has to be dropped into a sentence, so it needs to be a phrase, not
  // a sentence of its own. Background text like "Loves her rose garden" was
  // being used whole, producing "Is it because you spent some time on loves her
  // rose garden?". Strip the leading verb, turn third-person possessives
  // around, and give up entirely when what is left is still a past-tense fact
  // ("won a rose competition in 1985") rather than an activity.
  //
  // Returns { phrase, kind } because the two kinds need different sentences:
  //   activity — "going on walks near the river" → "you have been {phrase}"
  //   thing    — "your rose garden"              → "you spent some time on {phrase}"
  // Getting this wrong is what produced "you spent some time on go on walks
  // near the river".
  const HOBBY_LEAD = /^(loves?|loved|likes?|liked|enjoys?|enjoyed|adores?|is fond of|keen on)\s+/i
  const NOT_AN_ACTIVITY = /^(won|went|made|did|had|took|grew|was|were|used|worked|played in|lived)\b/i

  function hobbyPhrase(s) {
    let p = shortPhrase(s)
    if (!p) return null
    p = p.replace(HOBBY_LEAD, '')
    p = p.replace(/^to\s+/i, '')
    if (NOT_AN_ACTIVITY.test(p)) return null

    // Memories captured before the gerund fix are still stored as "Enjoys go on
    // walks near the river", and a manager can type anything into Background.
    // Normalising here means old records read correctly too.
    const fixed = I18n()?.toGerund?.(p) || p
    if (/^\w+ing\b/i.test(fixed)) return { phrase: fixed, kind: 'activity' }

    const thing = p.replace(/^(her|his|their|my|the)\s+/i, 'your ')
    return thing ? { phrase: thing, kind: 'thing' } : null
  }

  function matchFirst(text, re) {
    const m = String(text || '').match(re)
    return m ? m[0].toLowerCase() : null
  }

  // Rank the guess pool for a mood.
  //   • warm-up answers weigh heaviest — they are what the senior just told us;
  //   • then personalisation from the profile / Memory Bank;
  //   • generic guesses fill any remaining slots.
  // A negative boost (-99) means the senior has effectively ruled the guess
  // out, so it is dropped rather than wasting one of the three turns.
  // Later this is where the AI can re-rank using recent conversation history.
  // Which guesses actually fit which reported mood. "Did you sleep badly?" is
  // the obvious first thing to ask someone who says they are tired, and it was
  // previously ranked no higher than anything else.
  const MOOD_AFFINITY = {
    tired: { sleep: 3, pain: 1 },
    low:   { lonely: 2, sleep: 1, pain: 1, famworry: 1 },
    good:  { family: 1, hobby: 1, friends: 1, event: 1 },
    okay:  {}
  }

  // `tone` is passed in rather than derived from the mood, because an "okay"
  // day only gets one after the senior has said which way it leans.
  function rankGuesses(moodKey, tone, ctx, signals = {}, excluded = []) {
    const affinity = MOOD_AFFINITY[moodKey] || {}

    return GUESSES
      .filter(g => g.tone.includes(tone || 'neutral') && !excluded.includes(g.id))
      .map(g => {
        const met = g.needs.filter(n => ctx.has?.[n]).length
        const personal = g.needs.length ? (met === g.needs.length ? 2 : -1) : 0
        const fromAnswers = g.boost ? g.boost(signals) : 0
        const fits = affinity[g.id] || 0
        return { g, score: personal + fromAnswers + fits, personal }
      })
      // A hobby has an existing generic question when no profile is available.
      // Keep it below personalised guesses without inventing a hobby for them.
      .filter(x => (x.personal >= 0 || x.g.generic) && x.score > -50)
      .sort((a, b) => b.score - a.score)
      .map(x => x.g)
      .slice(0, MAX_GUESSES)
  }

  // ── Weather ───────────────────────────────────────────────────
  // Fetched from our own /api/weather so the OpenWeather key stays on the
  // server. Prefetched when a check-in starts, so by the time the weather
  // guess lands the real conditions are usually already in hand.
  //
  // `false` means "asked and unavailable" — distinct from null ("not asked
  // yet") so we never retry in a loop mid-conversation.
  let weatherNow = null
  let weatherAt = 0
  const WEATHER_TTL = 30 * 60 * 1000

  async function loadWeather() {
    // Expire so a tab left open overnight does not report yesterday's sky.
    if (weatherNow !== null && Date.now() - weatherAt < WEATHER_TTL) return weatherNow
    weatherAt = Date.now()
    try {
      const loc = App()?.residentContext?.()?.location || {}
      const qs = new URLSearchParams({ city: loc.city || '', country: loc.country || '' })
      const res = await fetch('/api/weather?' + qs.toString())
      const j = await res.json().catch(() => null)
      weatherNow = j?.available ? j : false
    } catch (_) {
      weatherNow = false
    }
    return weatherNow
  }

  function lowerFirst(s) {
    return s ? s.charAt(0).toLowerCase() + s.slice(1) : s
  }

  // ── Understanding spoken answers ──────────────────────────────
  // In voice mode there are no buttons to press, so what the senior says has
  // to be mapped onto the same answers the buttons used to give. The patterns
  // themselves live in i18n.js, one set per language; the rules for USING them
  // are here, and they are the same in every language.
  //
  // Both of the misreads below were reported from real sessions, and both were
  // ordering bugs, which is why the pattern lists are ordered and not merged:
  //
  //   "I'm not feeling good"  → was read as GOOD. The negation pattern did not
  //     allow a word between "not" and "good", so only "good" matched, and the
  //     companion answered a bad day with cheerful guesses.
  //   "right now I'm not feeling well" → was read as YES to the current guess,
  //     because bare "right" was in the yes list. The senior said they felt
  //     unwell and got "That is good to hear" back.
  const P = () => I18n()?.patterns?.() || {}

  function readMood(text) {
    for (const m of (P().mood || [])) if (m.re.test(text)) return m.key
    return null
  }

  // "Not quite" is checked before yes/no: "a bit" and "sort of" often sit in
  // the same sentence as a "yes", and the softer reading is the safer one.
  // "No" before "yes" for the same reason — a sentence holding both is far more
  // likely to be a qualified refusal than a qualified agreement.
  function readYesNo(text) {
    const p = P()
    if (p.close?.test(text)) return 'close'
    if (p.no?.test(text))    return 'no'
    if (p.yes?.test(text))   return 'yes'
    return null
  }

  // Which way an "okay" day is leaning. Returns null when they genuinely did
  // not say, which the caller treats as neutral rather than pressing again.
  function readLean(text) {
    for (const l of (P().lean || [])) if (l.re.test(text)) return l.key
    return null
  }

  // Did they already tell us WHY, unprompted? "I'm sad because my friend was
  // being mean" needs a reply about the friend — guessing at the reason after
  // they have just given it is the single most irritating thing the companion
  // can do. `because`, `since`, `my <someone>`, or simply saying a lot more
  // than the mood word all count as having explained themselves.
  function gaveReason(text) {
    const p = P()
    if (p.reason?.test(text)) return true

    // Chinese has no spaces, so the word-count heuristic below cannot work on
    // it. Length is the honest substitute: a bare mood answer is a few
    // characters, an explanation is not.
    if (!p.filler) {
      const bare = String(text).replace(/[\s，。！？、,.!?]/g, '')
      const stripped = (p.mood || []).reduce(
        (s, m) => s.replace(new RegExp(m.re.source, 'g'), ''), bare)
      return stripped.length >= 6
    }

    // Strip the mood words and the ordinary furniture of a polite answer, then
    // see whether real content is left over. Without the courtesy words in
    // that list, "I am fine thank you" read as a substantive statement and
    // skipped the guessing game entirely.
    const rest = (p.mood || []).reduce((s, m) => s.replace(new RegExp(m.re.source, 'gi'), ' '), text)
      .replace(p.filler, ' ')
      .replace(/[^a-z\s]/gi, ' ')
      .trim()
    return rest.split(/\s+/).filter(w => w.length > 2).length >= 2
  }

  // ── Session state ─────────────────────────────────────────────
  let S = null

  function blank() {
    return {
      active: false, voice: false, step: 'idle', ctx: {},
      // `tone` is the direction the day is going in. It comes from the mood for
      // every mood except "okay", which has to be asked — see askLean().
      mood: null, moodLabel: '', tone: null, lean: null, weather: null,
      signals: {}, followUpAnswer: '',
      queue: [], guessIndex: 0, askedGuesses: [], matched: null,
      concerns: [], freeText: '', reply: '',
      escalation: null, startedAt: null, lastPrompt: '',
      unparsed: 0, moodCorrected: false, said: [],
      outOfGuesses: false, declined: false,
      lang: I18n()?.code?.() || 'en'
    }
  }

  // ── UI ────────────────────────────────────────────────────────
  const el = id => document.getElementById(id)

  function panel() { return el('guess-panel') }

  // In voice mode, every line the companion says reopens the microphone once
  // it has finished playing — that is what makes the check-in hands-free.
  function say(text, opts = {}) {
    S.lastPrompt = text
    App().pushMessage('ai', text)
    if (opts.silent) return
    // Only reopen the microphone when the chat is actually in talking mode.
    // Someone who switched to typing does not want the mic springing open
    // after every reply.
    const handsFree = App().handsFree ? App().handsFree() : true
    const listenAfter = S.voice && handsFree && !opts.noListen && S.active
    App().speak(text, listenAfter ? () => { if (S?.active) App().listen?.() } : undefined)
  }

  function hear(text) {
    App().pushMessage('user', text)
  }

  function setPrompt(text) {
    if (S?.voice) return
    const node = el('guess-question')
    if (node) node.textContent = text
    keepPanelInView()
  }

  // Options are rendered as large buttons; `value` is what gets recorded and
  // echoed into the transcript so the saved session reads like a conversation.
  let optionsVersion = 0
  function setOptions(options) {
    if (S?.voice) return
    const wrap = el('guess-options')
    if (!wrap) return
    wrap.innerHTML = ''
    const version = ++optionsVersion
    const owner = S

    options.forEach(o => {
      const b = document.createElement('button')
      b.className = 'guess-opt' + (o.variant ? ' ' + o.variant : '')
      b.type = 'button'
      b.innerHTML = (o.emoji ? `<span class="guess-opt-emoji">${o.emoji}</span>` : '') +
        `<span>${App().esc(o.label)}</span>`
      b.addEventListener('click', () => {
        if (owner !== S || !S.active || version !== optionsVersion) return
        // A queued second click belongs to this question, not the next one.
        optionsVersion++
        return o.onPick()
      })
      wrap.appendChild(b)
    })
    keepPanelInView()
  }

  function showFreeText(show) {
    if (S?.voice) return
    const box = el('guess-free')
    if (box) box.style.display = show ? 'flex' : 'none'
    keepPanelInView()
    if (show) setTimeout(() => {
      el('guess-free-input')?.focus()
      keepPanelInView()
    }, 60)
  }

  function open() {
    if (S?.voice) return   // the chat transcript IS the surface in voice mode
    panel()?.classList.add('open')
    document.body.classList.add('checkin-running')
    keepPanelInView()
  }

  function close() {
    panel()?.classList.remove('open')
    document.body.classList.remove('checkin-running')
    if (!S?.voice) showFreeText(false)
  }

  function keepPanelInView() {
    const p = panel()
    if (!p) return
    requestAnimationFrame(() => {
      p.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }

  // ── Flow ──────────────────────────────────────────────────────
  // Voice mode: the check-in IS the chat. No panel, no buttons — the
  // companion opens with "How are you feeling today?", the senior answers out
  // loud, and everything below interprets that answer. The structured record
  // at the end is identical either way, so the family and provider dashboards
  // are unaffected by which mode was used.
  // `opts.keepTranscript`: the game was accepted from the greeting that
  // offered it, so it joins the conversation on screen instead of clearing it.
  // `opts.answer`: they answered the offer with how they feel ("I'm so tired
  // today"), which is the first answer of the game — asking "how are you
  // feeling?" after they have just said would be the loop a new senior
  // reported (audits/P3-senior-feedback.md, item 2).
  function startVoice(opts = {}) {
    const app = App()
    if (!app) return
    if (!app.getSelected()) return app.showToast(T('toast.selectFirst'))

    S = blank()
    S.active = true
    S.voice = true
    S.startedAt = new Date()
    S.ctx = buildContext()

    if (!opts.keepTranscript) app.newSession()
    app.switchTab('conversation')
    document.body.classList.remove('checkin-running')

    loadWeather().then(w => { if (S) S.weather = w || null })

    S.step = 'mood'
    if (opts.answer) {
      markAsked()
      return handleUserText(opts.answer)
    }
    say(opts.keepTranscript ? T('ask.mood.game') : T('open.voice', { name: S.ctx.name }))
    markAsked()
    // The one line that is always a possibility from here, whatever they say.
    try { App()?.primeSpeech?.(T('ask.mood.retry')) } catch (_) {}
  }

  function start() {
    const app = App()
    if (!app) return
    if (!app.getSelected()) return app.showToast(T('toast.selectFirst'))

    S = blank()
    S.active = true
    S.startedAt = new Date()
    S.ctx = buildContext()

    app.newSession()           // fresh transcript so the check-in saves clean
    app.switchTab('conversation')
    applyPanelLanguage()
    open()

    // Kick off the weather lookup now, in the background. By the time a
    // weather guess could land, the answer is normally already here — and if
    // it never arrives, the wording simply stays general.
    loadWeather().then(w => { if (S) S.weather = w || null })

    askMood(T('open.buttons', { name: S.ctx.name }))
    markAsked()
  }

  // Asked is asked. The day used to be marked only when a check-in was finished
  // or explicitly stopped, so a senior who heard "How are you feeling today?",
  // said nothing and wandered off — or simply reloaded the page — was asked it
  // again on the way back in, and again after that.
  //
  // "Asked", though, means the question reached them. It is on screen the
  // moment the line above runs, but a browser plays no audio until the page has
  // been touched, so on a device nobody has touched yet the spoken half is
  // still waiting. Marking the day then would spend it on a question that was
  // never put. So the marker waits for the same moment the question does.
  function markAsked() {
    const app = App()
    // An older cached app.js has no hasGestured; mark straight away rather than
    // wait for a signal that will never come.
    if (!app || app.hasGestured?.() !== false) { markDoneToday(); return }

    // Whose question it is, decided now. markDoneToday() otherwise resolves the
    // resident when the touch lands, and a manager who moves to another senior
    // in between would have marked the day for the wrong one — skipping a
    // person who was never asked, and re-asking the person who was.
    const asked = app.getSelected?.()?.id
    if (!asked) return

    const EVENTS = ['pointerdown', 'keydown', 'touchstart']
    const onTouch = () => {
      EVENTS.forEach(ev => window.removeEventListener(ev, onTouch, true))
      markDoneToday(asked)
    }
    EVENTS.forEach(ev =>
      window.addEventListener(ev, onTouch, { capture: true, passive: true }))
  }

  // `lead` is the greeting, spoken as part of this question rather than before
  // it. Two say() calls in a row cancel each other — speak() stops whatever is
  // already playing, which is right when a senior interrupts and wrong here —
  // so the greeting was pushed into the transcript and then silenced by the
  // question a millisecond later. Nobody ever heard the panel check-in say
  // hello.
  function askMood(lead) {
    S.step = 'mood'
    const q = T('ask.mood')
    setPrompt(q)
    say(lead ? `${lead} ${q}` : q)
    setOptions(MOODS.map(m => ({
      label: moodLabel(m.key), emoji: m.emoji,
      onPick: () => pickMood(m)
    })))
  }

  function pickMood(m) {
    S.mood = m.key
    S.moodLabel = moodLabelEn(m.key)
    S.tone = m.tone
    hear(moodLabel(m.key))

    // "Okay" is not a direction, so there is nothing yet to guess a cause for.
    if (!m.tone) return askLean()

    startGuessing()
  }

  // The one extra question, asked only for "okay".
  //
  // A mood word that means "neither" cannot be guessed at without picking a
  // side, and picking one at random is how the companion came to suggest a
  // nice chat and then a bad night's sleep as explanations for the same
  // answer. So it asks. If the senior does not pick a side either, that IS the
  // answer — the day is ordinary, and the direction-free questions are used.
  function askLean() {
    S.step = 'lean'
    const q = T('ask.lean')
    setPrompt(q)
    say(q)

    setOptions([
      { label: T('lean.positive'), emoji: '🙂', onPick: () => pickLean('positive') },
      { label: T('lean.neutral'),  emoji: '😐', onPick: () => pickLean('neutral') },
      { label: T('lean.negative'), emoji: '😔', onPick: () => pickLean('negative') }
    ])
  }

  function pickLean(lean, spoken) {
    if (spoken === undefined) hear(T('lean.' + lean))
    setLean(lean)
    startGuessing()
  }

  // Recorded as well as used: a manager reading the history should be able to
  // see that "Okay" meant an ordinary day rather than a quietly bad one.
  function setLean(lean) {
    S.lean = lean
    S.tone = lean === 'neutral' ? 'neutral' : lean
  }

  function startGuessing() {
    S.queue = rankGuesses(S.mood, S.tone, S.ctx,
      { ...S.signals, __weather: S.weather, __tone: S.tone }, S.askedGuesses)
    S.guessIndex = 0

    // The first guess opens by saying it heard the answer. It used to go
    // straight from "not so good" to "Is it because…?", which reads as not
    // having listened — the companion asking a scripted question about the
    // day whatever was said.
    return nextGuess(moodAck())
  }

  function moodAck() {
    if (S.lean) return T('ack.lean.' + S.lean)
    return S.mood ? T('ack.mood.' + S.mood) : ''
  }

  // Chinese runs one sentence straight on from the last; English needs a space.
  function joinLines(a, b) {
    if (!a) return b
    if (!b) return a
    return /[。！？]$/.test(a) ? a + b : a + ' ' + b
  }

  // One budget for speech, typing and buttons, including a corrected mood.
  function askRealAnswer() {
    S.outOfGuesses = true
    const question = T(S.tone === 'neutral' ? 'open.nothing' : 'open.outofguesses')
    if (S.voice) { S.step = 'open'; return say(question) }
    return askOpen(question, true)
  }

  function numberedGuess(g) {
    return joinLines(T(g.kind === 'question' ? 'guess.question.progress' : 'guess.progress',
      { number: S.askedGuesses.length, total: MAX_GUESSES }), g.ask(S.ctx))
  }

  // Button-mode guessing. The voice path uses nextGuess() above, which speaks
  // the guess instead of rendering the three answer buttons.
  function nextGuessButtons(lead) {
    S.step = 'guess'
    const g = S.queue[S.guessIndex]
    const q = numberedGuess(g)
    setPrompt(q)
    say(joinLines(lead, q))

    // A direction-free item is a plain question, not a guess, so "Try Again"
    // would be nonsense on it.
    const q3 = g.kind === 'question'
    setOptions([
      { label: T(q3 ? 'answer.q.yes'   : 'answer.yes'),   emoji: '👍', variant: 'yes', onPick: () => answerGuess('yes') },
      { label: T(q3 ? 'answer.q.close' : 'answer.close'), emoji: '🤏', variant: '',    onPick: () => answerGuess('close') },
      { label: T(q3 ? 'answer.q.no'    : 'answer.no'),    emoji: '🔄', variant: '',    onPick: () => answerGuess('no') }
    ])
  }

  function answerGuess(answer) {
    const g = S.queue[S.guessIndex]
    const q3 = g?.kind === 'question'
    hear(T({
      yes:   q3 ? 'answer.q.yes'   : 'answer.yes',
      close: q3 ? 'answer.q.close' : 'answer.close',
      no:    q3 ? 'answer.q.no'    : 'answer.no'
    }[answer]))

    if (answer === 'yes') {
      S.matched = g
      if (g.concern) S.concerns.push(g.concern)
      // A correct guess opens the subject up rather than closing it: stay on
      // what they just confirmed and ask about it, the way a person would.
      if (g.then) {
        // If they just confirmed the weather and the lookup is still in
        // flight, wait a beat for it — the whole point is to say something
        // true about today rather than a pleasantry.
        if (g.id === 'weather' && S.weather === null) {
          setPrompt(T('wait'))
          setOptions([])
          Promise.race([
            loadWeather(),
            new Promise(res => setTimeout(() => res(null), 2500))
          ]).then(w => {
            if (!S?.active) return
            S.weather = w || null
            askFollowUp(g)
          })
          return
        }
        return askFollowUp(g)
      }
      return askOpen(T('ask.more'), true)
    }

    if (answer === 'close' && g.concern) S.concerns.push(g.concern)

    S.guessIndex++
    nextGuess(T(answer === 'close' ? 'ack.close' : 'ack.miss'))
  }

  // One follow-up question on the subject the guess just landed on.
  // Receives the whole state, so wording can react to the live weather and to
  // anything already reported this session.
  function askFollowUp(g) {
    S.step = 'followup'
    const q = g.then.ask(S)
    setPrompt(q)
    say(q)

    setOptions(g.then.options.map(o => ({
      label: optionLabel(g, o), emoji: o.emoji,
      onPick: () => answerFollowUp(g, o)
    })))
  }

  function answerFollowUp(g, option) {
    hear(optionLabel(g, option))
    S.signals[g.id] = option.value
    // English, for the saved record — the summary line a manager reads should
    // not switch language with the resident.
    S.followUpAnswer = TEn(`guess.${g.id}.${option.key}`)

    // The human reply. Some are worded differently depending on the weather or
    // on what has already been reported this session.
    const reply = optionReply(g, option, S)
    S.reply = reply
    say(reply)

    // Leave the door open without demanding anything: they can add more in
    // their own words, or finish here.
    S.step = 'closing'
    setPrompt(T('close.q'))
    setOptions([
      { label: T('close.more'), emoji: '💬', onPick: () => askOpen(T('open.listening')) },
      { label: T('close.done'), emoji: '✅', variant: 'yes', onPick: () => finish() }
    ])
  }

  // `optional` = they already told us something useful, so Skip is offered.
  function askOpen(question, optional) {
    S.step = 'open'
    setPrompt(question)
    say(question)
    showFreeText(true)

    setOptions(optional
      ? [{ label: T('close.done'), emoji: '⏭', onPick: () => finish() }]
      : [])
  }

  // ── Voice router ──────────────────────────────────────────────
  // Everything the senior says during a voice check-in arrives here (app.js
  // has already pushed it into the transcript). Its job is to decide whether
  // this was a mood, a yes/no to a guess, or something the AI should answer
  // properly — and never to ask a question they have already answered.
  async function handleUserText(text) {
    if (!S?.active || !S.voice) return
    const said = String(text || '').trim()
    if (!said) return

    S.said.push(said)

    // Safety first, at every single step — before any interpretation.
    const urgent = scanUrgent(said)
    if (urgent) return escalate(urgent, said)

    noteConcerns(said)

    // "That's all" means stop, at whatever point they say it. This is checked
    // before the step router: a senior winding the conversation up must never
    // be answered with another question.
    if (P().done?.test(said)) return finish()

    if (S.step === 'mood')     return await onMoodReply(said)
    if (S.step === 'lean')     return await onLeanReply(said)
    if (S.step === 'guess')    return await onGuessReply(said)
    if (S.step === 'followup') return await onFollowUpReply(said)
    if (S.step === 'closing')  return await onClosingReply(said)

    // Asked to say what it is after the guesses ran out, and they would
    // rather not. That is an answer: accepted, and the check-in finishes on
    // what they did say, instead of pressing them for one.
    if (S.step === 'open' && S.outOfGuesses && !S.freeText && !gaveReason(said) &&
        (readYesNo(said) === 'no' || P().unsure?.test(said))) {
      S.declined = true
      S.reply = T('ack.declined')
      return finishAfterReply(S.reply)
    }

    // 'open' / anything else: they are just talking now. Let the
    // model carry the conversation with the full transcript behind it.
    S.freeText = [S.freeText, said].filter(Boolean).join(' ')
    return await aiReply()
  }

  // The answer to the follow-up question is the end of the check-in. A mood, a
  // reason and one answer about it is the whole record — going round again
  // turns a two-minute check-in into an interview, and it is the point the
  // button-mode flow stops at too.
  //
  // Ending it is not ending the conversation. finish() leaves a voice check-in
  // exactly where it is, in the chat, so a senior who wants to keep talking
  // simply keeps talking and the companion answers normally from here.
  async function onClosingReply(said) {
    if (!S.followUpAnswer) S.followUpAnswer = said
    S.freeText = [S.freeText, said].filter(Boolean).join(' ')
    // "Not really" to its last question is heard before the goodbye, not
    // talked over by it.
    const declined = readYesNo(said) === 'no' || Boolean(P().unsure?.test(said))
    return finish(declined ? T('ack.ok') : '')
  }

  function noteConcerns(text) {
    const c = P().concerns || {}
    for (const name of ['loneliness', 'discomfort', 'sleep', 'appetite']) {
      if (c[name]?.test(text)) S.concerns.push(name)
    }
  }

  async function onMoodReply(said) {
    // A greeting is not a mood or a reason. Strip only a leading greeting,
    // keeping any actual answer that follows (including negation/urgency).
    const greeting = P().greeting
    if (greeting) {
      let previous
      do { previous = said; said = said.replace(greeting, '').trim() } while (said && said !== previous)
      if (!said) return say(T('open.voice', { name: S.ctx.name }))
    }
    const mood = readMood(said)

    if (mood) {
      const m = MOODS.find(x => x.key === mood)
      S.mood = m.key
      S.moodLabel = moodLabelEn(m.key)
      S.tone = m.tone

      // They named a mood AND explained it in the same breath. Guessing now
      // would be asking something they just answered — go straight to a real
      // reply about what they actually said.
      if (gaveReason(said)) {
        S.freeText = said
        return await aiReply()
      }

      // "Okay" on its own tells us nothing about the direction of the day, so
      // ask before guessing at a cause.
      if (!m.tone) {
        S.step = 'lean'
        return say(T('ask.lean'))
      }

      return startGuessing()
    }

    // No mood word, but they said something real ("my friend was being mean").
    // Treat it as the substance of the check-in rather than nagging for a mood.
    if (gaveReason(said)) {
      S.mood = S.mood || inferMood(said)
      const m = MOODS.find(x => x.key === S.mood)
      if (m) { S.moodLabel = moodLabelEn(m.key); S.tone = m.tone }
      S.freeText = said
      S.step = 'open'
      return await aiReply()
    }

    // ── Second opinion, before giving up on the sentence ─────────
    // Everything above this line is regex, and regex is why a senior who said
    // "I'm feeling bad" was answered with "I did not quite catch that": the
    // word was missing from a pattern list. Widening the list fixes that
    // sentence and not the next one — the same file has been patched, one
    // reported misunderstanding at a time, since it was written.
    //
    // So this branch — and ONLY this branch, where the patterns already found
    // nothing — asks the model what the sentence meant. The common case never
    // reaches here, so it costs nothing on nearly every turn, and the thing it
    // is competing with is a canned line saying we did not understand. Any
    // failure returns null and falls through to exactly that line.
    const read = await App().understand?.(said).catch(() => null)

    if (read) {
      // Recorded either way. These land on the family and provider dashboards,
      // and a sentence the patterns could not read is precisely the one whose
      // concerns nobody would otherwise see.
      for (const c of read.concerns || []) {
        if (!S.concerns.includes(c)) S.concerns.push(c)
      }

      const m = read.mood ? MOODS.find(x => x.key === read.mood) : null

      // A mood it is SURE of is treated exactly like one the patterns read:
      // the check-in carries on as designed.
      if (m && read.confidence === 'high' && !read.gaveReason) {
        S.mood = m.key
        S.moodLabel = moodLabelEn(m.key)
        S.tone = m.tone
        if (!m.tone) { S.step = 'lean'; return say(T('ask.lean')) }
        return startGuessing()
      }

      // Anything less certain than that does NOT get to pick the guesses.
      // startGuessing() builds the whole rest of the check-in out of the mood,
      // and a wrong one is how somebody who felt unwell was told "that is good
      // to hear" — the fault onGuessReply's correction path exists to undo. A
      // reading this soft is still worth having, so it sets the record and
      // then hands the turn to the model to answer in words, which is the
      // safest use of an uncertain judgement and the better reply anyway.
      if (m || read.gaveReason) {
        if (m) {
          S.mood = m.key
          S.moodLabel = moodLabelEn(m.key)
          S.tone = m.tone
        }
        S.freeText = said
        S.step = 'open'
        return await aiReply()
      }
    }

    // Genuinely could not tell. Ask once more, differently, then move on
    // rather than trapping them in a loop.
    S.unparsed++
    if (S.unparsed >= 2) {
      S.step = 'open'
      return await aiReply()
    }
    return say(T('ask.mood.retry'))
  }

  // Spoken answer to the "which way did it lean?" question. An answer we
  // cannot place is not worth a second attempt — "ordinary" is the honest
  // reading of someone who will not commit either way, and the direction-free
  // questions are safe for all three cases anyway.
  async function onLeanReply(said) {
    if (gaveReason(said) && !readLean(said)) {
      setLean('neutral')
      S.freeText = said
      S.step = 'open'
      return await aiReply()
    }

    setLean(readLean(said) || 'neutral')
    return startGuessing()
  }

  // They skipped the mood word and went straight to the substance. Read the
  // tone of what they said so the record is not blank, but stay cautious —
  // "okay" is the default, because a wrong guess here shapes the whole chat.
  function inferMood(text) {
    const p = P()
    if (p.infer?.low?.test(text))  return 'low'
    if (p.infer?.good?.test(text)) return 'good'
    return 'okay'
  }

  async function onGuessReply(said) {
    const answer = readYesNo(said)
    const g = S.queue[S.guessIndex]

    // Read a corrected mood before the broad yes/no matcher: "I am tired"
    // contains "I am", which otherwise confirms a guess they never accepted.
    const mood = readMood(said)
    if (mood && mood !== S.mood && !S.moodCorrected) {
      const m = MOODS.find(x => x.key === mood)
      S.moodCorrected = true
      S.mood = m.key
      S.moodLabel = moodLabelEn(m.key)
      S.tone = m.tone
      S.lean = null
      if (gaveReason(said)) {
        S.freeText = [S.freeText, said].filter(Boolean).join(' ')
        S.step = 'open'
        return await aiReply()
      }
      if (!m.tone) { S.step = 'lean'; return say(T('ask.lean')) }
      return startGuessing()
    }

    // Anything other than a plain yes/no is them telling us the real reason —
    // which is better than any guess. Stop guessing and respond to it.
    if (!answer) {
      if (gaveReason(said)) {
        S.freeText = said
        S.step = 'open'
        return await aiReply()
      }
      S.unparsed++
      if (S.unparsed >= 2) { S.step = 'open'; return await aiReply() }
      return say(T('ask.yesno.retry'))
    }

    S.unparsed = 0

    // "No, my son didn't call me this week" is a no to the guess AND the real
    // reason, which is better than any guess. It used to be read as a bare
    // miss: the reason was dropped and the next guess asked.
    if (answer !== 'yes' && gaveReason(said)) {
      if (answer === 'close' && g?.concern) S.concerns.push(g.concern)
      S.freeText = [S.freeText, said].filter(Boolean).join(' ')
      S.step = 'open'
      return await aiReply()
    }

    if (answer === 'yes') {
      S.matched = g
      if (g?.concern) S.concerns.push(g.concern)
      if (g?.then) {
        if (g.id === 'weather' && S.weather === null) {
          const w = await Promise.race([
            loadWeather(),
            new Promise(res => setTimeout(() => res(null), 2500))
          ])
          if (!S?.active) return
          S.weather = w || null
        }
        S.step = 'followup'
        return say(g.then.ask(S))
      }
      S.step = 'open'
      return say(T('ask.more'))
    }

    if (answer === 'close' && g?.concern) S.concerns.push(g.concern)

    S.guessIndex++
    // The "no" is heard — "Not that, then." — before the next guess.
    return nextGuess(T(answer === 'close' ? 'ack.close' : 'ack.miss'))
  }

  async function onFollowUpReply(said) {
    const g = S.queue[S.guessIndex]
    const answer = readYesNo(said)
    const option = g?.then?.options?.find(o => o.key === (answer === 'yes' ? 'yes' : 'no'))
      || g?.then?.options?.[answer === 'yes' ? 0 : 1]

    S.followUpAnswer = said
    if (g && option) S.signals[g.id] = option.value

    // If they said something with real content, the model answers it; the
    // scripted line is only for a bare yes/no.
    if (gaveReason(said) || !answer) {
      S.freeText = [S.freeText, said].filter(Boolean).join(' ')
      S.step = 'open'
      return await aiReply()
    }

    const reply = (g && option) ? optionReply(g, option, S) : T('ask.more')
    S.reply = reply
    return finishAfterReply(reply)
  }

  // The intelligent path: hand the whole transcript to the model so the reply
  // is about what they actually said. If the model is unreachable the canned
  // line is clearly marked, rather than passing for an AI answer.
  async function aiReply() {
    let reply = null
    try {
      reply = await App().askAI('checkin')
    } catch (_) {
      reply = null
    }

    if (!reply) {
      const why = App().aiError?.()
      console.warn('[checkin] AI unavailable, using fallback.', why || '')
      reply = fallbackReply()
    }

    S.reply = reply
    say(reply)

    // Once they have told us what it is, this reply is the closing one: a
    // supportive line and a single follow-up question. Button mode puts a
    // ✅ Done underneath it; voice mode draws no buttons at all, so the answer
    // to that question is what ends the check-in.
    //
    // Without this the step stayed 'open' for the rest of the visit. finish()
    // was never reached, so a check-in the senior answered all the way through
    // was never written down — while markAsked() had already spent the day, so
    // nobody was asked again either. And with no model reachable, aiReply()
    // falls back to a canned line that does not vary, so every further answer
    // was met with the identical sentence, word for word.
    if (S.voice && S.freeText) S.step = 'closing'
  }

  // `lead`: what is said first, so the guess follows on from the last answer —
  // "I am sorry you are not feeling so good today." / "Not that, then."
  function nextGuess(lead) {
    if (S.askedGuesses.length >= MAX_GUESSES || S.guessIndex >= S.queue.length) {
      return askRealAnswer()
    }
    const g = S.queue[S.guessIndex]
    // Count when shown, even if they stop or volunteer the answer immediately.
    S.askedGuesses.push(g.id)
    if (S.voice) {
      S.step = 'guess'
      const asked = say(joinLines(lead, numberedGuess(g)))
      // The senior is about to spend several seconds answering, and the line
      // that follows a "no" is already decided. Synthesising it now means it
      // is waiting in the cache instead of being started from cold once they
      // have finished speaking.
      primeNext()
      return asked
    }
    return nextGuessButtons(lead)
  }

  // Best-effort and silent: a primed line that is never reached costs one
  // request, and a wrong guess about what comes next costs nothing at all.
  function primeNext() {
    const prime = App()?.primeSpeech
    if (!prime || !S?.voice || S.askedGuesses.length >= MAX_GUESSES) return
    const next = S.queue?.[S.guessIndex + 1]
    try {
      if (next) prime(next.ask(S.ctx))
      prime(T('ask.mood.retry'))
    } catch (_) {}
  }

  async function submitFree() {
    const input = el('guess-free-input')
    const text = (input?.value || '').trim()
    if (!text) return

    input.value = ''
    showFreeText(false)
    hear(text)

    // Safety gate runs before anything else touches this text.
    const urgent = scanUrgent(text)
    if (urgent) return escalate(urgent, text)

    S.freeText = text
    noteConcerns(text)

    await respond()
  }

  // One short supportive reply plus a single follow-up question. Uses the AI
  // when configured; the canned fallback keeps the same shape so the check-in
  // still completes with no model available.
  async function respond() {
    S.step = 'responding'
    setPrompt(T('wait'))
    setOptions([])

    let reply
    try {
      reply = await App().askAI('checkin')
    } catch (_) {
      reply = null
    }
    if (!reply) reply = fallbackReply()

    S.reply = reply
    say(reply)

    S.step = 'closing'
    setPrompt(T('finish.prompt'))
    setOptions([{ label: T('finish.btn'), emoji: '✅', variant: 'yes', onPick: () => finish() }])
  }

  function fallbackReply() {
    const name = S.ctx.name
    // The chat's own offline reader first: "I am sorry your son didn't call
    // you" rather than a line that could follow anything. It returns null
    // when it has nothing specific to say.
    const last = S.said[S.said.length - 1] || S.freeText || ''
    let tailored = null
    try { tailored = App()?.localReply?.(last, { mood: S.mood }) || null } catch (_) {}
    if (tailored) return tailored
    if (S.concerns.includes('discomfort')) return T('fallback.discomfort', { name })
    if (S.concerns.includes('loneliness')) return T('fallback.loneliness', { name })
    if (S.mood === 'good')                 return T('fallback.good', { name })
    return T('fallback.default', { name })
  }

  // ── Escalation ────────────────────────────────────────────────
  // Stops the check-in dead. We do not counsel, assess, or keep chatting — we
  // acknowledge, hand off to a human, and record the disclosure verbatim.
  async function escalate(urgent, text) {
    S.step = 'escalated'
    S.escalation = {
      level: urgent.level,
      flags: urgent.flags,
      quote: text.slice(0, 300),
      raisedAt: new Date().toISOString()
    }

    say(T(urgent.level === 'emergency' ? 'esc.emergency' : 'esc.urgent'))
    setPrompt(T('esc.prompt'))
    setOptions([])

    const wrap = el('guess-options')
    if (wrap) {
      wrap.innerHTML = `
        <div class="guess-escalate">
          <div class="guess-escalate-title">${App().esc(T('esc.title'))}</div>
          <div class="guess-escalate-body">${App().esc(
            T(urgent.level === 'emergency' ? 'esc.body.emergency' : 'esc.body'))}</div>
        </div>`
    }

    await save()

    // The panel deliberately stays open. Closing it here would blink the
    // hand-off notice off screen before the senior could read it — they must
    // be left looking at confirmation that a human is being brought in, and
    // dismiss it themselves.
    const dismiss = document.createElement('button')
    dismiss.className = 'guess-opt'
    dismiss.type = 'button'
    dismiss.innerHTML = `<span>${App().esc(T('esc.close'))}</span>`
    dismiss.addEventListener('click', () => {
      close()
      App().switchTab('dashboard')
    })
    wrap?.appendChild(dismiss)
  }

  // ── Finish & record ───────────────────────────────────────────
  // `lead`: said first, in the same breath as the goodbye.
  async function finish(lead) {
    if (!S?.active) return
    const wasVoice = S.voice
    showFreeText(false)
    if (S.step !== 'escalated') {
      say(joinLines(typeof lead === 'string' ? lead : '', T('finish.bye', { name: S.ctx.name })), { noListen: true })
    }
    const { ok } = await save()
    close()
    markDoneToday()
    refresh()
    if (ok) App().showToast(T('toast.saved'))
    // In voice mode the senior is mid-conversation in the chat — moving them
    // to the dashboard would end it for them. They stay, and can keep talking
    // to the companion normally.
    if (!wasVoice) App().switchTab('dashboard')
  }

  // In hands-free mode there is no Done button. Once the senior has supplied a
  // mood, confirmed the reason and answered its one follow-up, the record is
  // complete. Save it with the warm reply as the closing line instead of
  // waiting for an extra sentence that many people will naturally never say.
  async function finishAfterReply(reply) {
    if (!S?.active) return
    const wasVoice = S.voice
    showFreeText(false)
    say(reply, { noListen: true })
    const { ok } = await save()
    close()
    markDoneToday()
    refresh()
    if (ok) App().showToast(T('toast.saved'))
    if (!wasVoice) App().switchTab('dashboard')
  }

  function stop() {
    if (!S?.active) return
    App().stopSpeaking()
    const partial = S.mood !== null
    close()
    if (partial) save({ stopped: true }).then(({ ok }) => { if (ok) App().showToast(T('toast.stoppedPartial')) })
    else App().showToast(T('toast.stopped'))
    S.active = false
    // markAsked() has normally done this already — and pressing Stop is itself
    // the touch it may have been waiting for. Repeated anyway: whatever else
    // happened, the question was put today. Writing the same stamp twice costs
    // nothing.
    markDoneToday()
    refresh()
  }

  // ── Once a day ────────────────────────────────────────────────
  // The check-in opens the day's chat and then gets out of the way. A saved
  // record is the normal signal; this marker covers every other ending —
  // abandoned halfway, stopped, or simply left — and is written the moment the
  // question is asked rather than when an answer arrives. Asking it a second
  // time is worse than missing an answer: it tells a senior the companion has
  // forgotten they already spoke.
  //
  // Keyed per resident and stamped with the date, so tomorrow asks again.
  const DISMISS_KEY = 'techable_checkin_dismissed_'

  function todayStamp() { return new Date().toDateString() }

  // `id` is passed by markAsked(), which may be recording a question that was
  // put to somebody who is no longer the one selected.
  function markDoneToday(id) {
    const who = id || App()?.getSelected?.()?.id
    if (!who) return
    try { localStorage.setItem(DISMISS_KEY + who, todayStamp()) } catch (_) {}
  }

  function doneToday() {
    const r = App()?.getSelected?.()
    if (!r) return false
    if (App()?.todaysCheckIn?.()) return true
    try { return localStorage.getItem(DISMISS_KEY + r.id) === todayStamp() }
    catch (_) { return false }
  }

  function repeat() {
    if (!S?.active || !S.lastPrompt) return
    App().speak(S.lastPrompt)
  }

  // Build the structured record. Everything here is *reported*, never inferred
  // as a diagnosis — `concerns` are the topics the senior confirmed, and
  // `summary` is a factual recap of the exchange.
  function buildRecord(extra = {}) {
    const uniq = Array.from(new Set(S.concerns))
    const durationSecs = S.startedAt
      ? Math.max(1, Math.round((Date.now() - S.startedAt.getTime()) / 1000))
      : null

    return {
      game: 'guess_my_day',
      version: 1,
      mood: S.mood,
      moodLabel: S.moodLabel,
      // Which way an "okay" day was leaning, when we asked. Null for every
      // other mood, where the direction is already in `mood`.
      lean: S.lean,
      // Which language it was actually spoken in. Everything else in this
      // record is English on purpose.
      language: S.lang || 'en',
      // What they answered to the follow-up, keyed by the subject that landed
      // (e.g. { weather: 'no' } = confirmed the weather, had not been outside).
      answers: { ...S.signals },
      followUpAnswer: S.followUpAnswer || null,
      reason: S.matched ? S.matched.id : (S.freeText ? 'self_described' : null),
      reasonLabel: S.matched ? inEnglish(() => S.matched.ask(S.ctx)) : (S.freeText || null),
      topic: S.matched?.topic || (S.freeText ? 'open' : null),
      discomfort: uniq.includes('discomfort') || uniq.includes('sleep') ? true : false,
      lonelinessSignal: uniq.includes('loneliness'),
      concerns: uniq,
      guessesUsed: S.askedGuesses.length,
      guessed: Boolean(S.matched),
      seniorWords: S.freeText || '',
      aiResponse: S.reply || '',
      summary: buildSummary(uniq),
      followUp: buildFollowUp(uniq),
      escalation: S.escalation,
      durationSecs,
      stopped: Boolean(extra.stopped),
      recordedAt: new Date().toISOString()
    }
  }

  function buildSummary(concerns) {
    const LEAN_WORD = { positive: 'leaning good', neutral: 'an ordinary day', negative: 'leaning hard' }
    const bits = [`Reported feeling ${S.moodLabel || 'unspecified'}${
      S.lean ? ` (${LEAN_WORD[S.lean]})` : ''}`]

    if (S.matched) bits.push(`confirmed it related to ${S.matched.topic}`)
    if (S.matched && S.followUpAnswer) bits.push(`answered "${S.followUpAnswer}" when asked more about it`)
    else if (S.freeText) bits.push('described it in their own words')
    else if (S.declined) bits.push('preferred not to say why')
    // Only "did not say why" when nothing at all came back — a landed guess
    // IS the reason, and reporting otherwise misleads the manager reading it.
    else if (!S.matched) bits.push('did not say why')
    if (concerns.length) bits.push(`mentioned ${concerns.join(', ')}`)
    if (S.escalation) bits.push(`URGENT: ${S.escalation.flags.join(', ')} — escalated`)
    return bits.join('; ') + '.'
  }

  function buildFollowUp(concerns) {
    if (S.escalation) {
      return S.escalation.level === 'emergency'
        ? 'Immediate contact required — urgent disclosure during check-in.'
        : 'Contact today — concerning disclosure during check-in.'
    }
    if (concerns.includes('discomfort')) return 'Reported physical discomfort — worth asking about.'
    if (concerns.includes('loneliness')) return 'Signs of loneliness — a visit or call may help.'
    if (concerns.includes('appetite')) return 'Reported eating less than usual — worth checking.'
    if (concerns.includes('sleep')) return 'Reported poor sleep — worth checking.'
    if (S.mood === 'good') return null
    // "Okay" is not a low mood. Flagging one as such filled the dashboard with
    // false concern for people who were simply having an ordinary day; only an
    // okay day the senior said was leaning hard is worth a line.
    if (S.mood === 'okay' && S.lean !== 'negative') return null
    return 'Low mood reported — keep an eye on the next few check-ins.'
  }

  // `ok` is false when the record did not get anywhere it needed to go.
  // persistSession() has already told the senior what happened in that case,
  // in words that fit the specific failure — so the callers below must not
  // then paint over it with "Check-in saved ✓", which is what they used to do
  // unconditionally.
  async function save(extra) {
    const record = buildRecord(extra)
    S.active = false
    let ok = false
    try {
      const out = await App().persistSession(record)
      // ok = it reached Firestore, or it was saved on this device when no sync
      // was expected (guest / localStorage mode, where synced:false is the
      // normal state). Saved locally with a failed sync is NOT ok: that is the
      // "not sent to the care team" case, and this used `||`, which let
      // "Check-in saved ✓" cover it. A plain `&&` would be wrong the other
      // way — it would silence the confirmation on every local-mode check-in.
      // An older cached app.js returns the session object with no `synced` on
      // it; treat that as success rather than crying wolf every time. One that
      // reports synced:false without `usingFirestore` cannot say whether a
      // sync was expected, so stay quiet and let its own toast stand.
      if (!out) ok = false
      else if (out.synced === undefined) ok = true
      else ok = out.synced === true || (out.localSaved !== false && out.usingFirestore === false)
    } catch (err) {
      console.warn('[checkin] save failed:', err)
    }
    refresh()
    return { record, ok }
  }

  // ── Voice input ───────────────────────────────────────────────
  // The main chat mic writes into #chat-input, so the check-in needs its own
  // recogniser targeting the check-in textarea.
  // Mirrors the chat mic exactly: words appear as they are spoken, and a
  // short silence submits the answer. Before this, the button-mode mic showed
  // nothing until the senior stopped talking and then still required a press
  // of Send — two different microphones behaving two different ways in the
  // same app.
  const MIC_SILENCE_MS = 1500
  let rec = null
  let listening = false
  let micFinal = ''
  let micTimer = null
  // True once the browser has actually started capturing audio for the
  // current session (see the identical fields on the main chat mic in app.js).
  let micAudioStarted = false
  // Set for exactly one retry when start() is called before the previous
  // session's onend has fired.
  let micRestartPending = false
  let micFailed = false

  // `starting` is the gap between the tap and the browser actually opening
  // the microphone — announced so a screen-reader user is not told "Speak
  // your answer" is already in effect before it is.
  function micUI(on, starting) {
    const b = el('guess-mic')
    if (!b) return
    b.classList.toggle('active', on)
    b.classList.toggle('starting', Boolean(starting))
    b.setAttribute('aria-pressed', on ? 'true' : 'false')
    b.setAttribute('aria-label', starting ? T('ui.ready') : T(on ? 'ui.mic.stop' : 'ui.mic.start'))
  }

  function micClear() {
    if (micTimer) { clearTimeout(micTimer); micTimer = null }
  }

  function micEnd() {
    micClear()
    listening = false
    // A tap off cancels a queued retry (see micStop in app.js).
    micRestartPending = false
    micUI(false)
    try { rec?.stop() } catch (_) {}
  }

  function micCommit() {
    micClear()
    const input = el('guess-free-input')
    const text = (micFinal || input?.value || '').trim()
    micFinal = ''
    micEnd()
    if (!text) return
    if (input) input.value = text
    submitFree()
  }

  // Built once, and as early as the page allows — see ensureRec() below for
  // why building it costs nothing before the senior has tapped anything.
  function ensureRec() {
    if (rec) return rec
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return null

    rec = new SR()
    rec.interimResults = true
    rec.continuous = true
    rec.maxAlternatives = 1

    // Checked before it is assigned below, so this reflects what the browser
    // actually supports rather than our own handler.
    const supportsAudioStart = 'onaudiostart' in rec

    rec.onstart = () => {
      if (!listening || micFailed) return
      if (!supportsAudioStart) { micAudioStarted = true; micUI(true) }
    }

    rec.onaudiostart = () => { if (!listening || micFailed) return; micAudioStarted = true; micUI(true) }

    rec.onresult = e => {
      if (micFailed || !listening) return
      App().stopSpeaking()
      // A transcript is proof audio was heard even on a device that fires
      // neither event above.
      if (!micAudioStarted) { micAudioStarted = true; micUI(true) }

      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0]?.transcript || ''
        if (e.results[i].isFinal) micFinal = (micFinal + ' ' + chunk).trim()
        else interim += chunk
      }
      const input = el('guess-free-input')
      if (input) input.value = (micFinal + ' ' + interim).trim()

      micClear()
      if (micFinal) micTimer = setTimeout(micCommit, MIC_SILENCE_MS)
    }

    rec.onend = () => {
      listening = false
      if (micFailed) { micUI(false); return }
      // A tap that lands while the previous session is still winding down
      // can make start() throw below before onend has actually fired. Rather
      // than leave the mic silently shut, finish the restart here, once.
      if (micRestartPending) {
        micRestartPending = false
        listening = true
        micStart()
        return
      }
      if (micFinal.trim()) micCommit()
      else micUI(false)
    }

    rec.onerror = ev => {
      micClear()
      micFailed = true
      micFinal = ''
      listening = false
      micRestartPending = false
      micUI(false)
      if (ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed') {
        App().showToast(T('toast.micBlocked'))
      } else if (ev?.error === 'network') {
        App().showToast(T('toast.speechNetwork'))
      }
    }

    return rec
  }

  // Shared by the first tap and by the one-shot InvalidStateError retry from
  // onend above.
  function micStart() {
    micFailed = false
    micAudioStarted = false
    micUI(true, true)
    try {
      rec.start()
    } catch (err) {
      if (err?.name === 'InvalidStateError' && !micRestartPending) {
        // The previous session has not finished stopping yet — wait for its
        // onend and try exactly once more.
        micRestartPending = true
        return
      }
      // Anything else is a real failure, and swallowing it (as this used to)
      // is how the mic went silently shut while the senior kept talking to a
      // button that had already given up.
      micRestartPending = false
      listening = false
      micUI(false)
      App().showToast(T('toast.micStartFailed'))
    }
  }

  function mic() {
    if (!ensureRec()) return App().showToast(T('toast.noSpeech'))

    if (listening) { micCommit(); return }

    // Set every time, not once at construction: the language can change
    // between check-ins, and a recogniser still listening for English will
    // return nonsense for Cantonese rather than failing visibly.
    rec.lang = I18n()?.speechLang?.() || 'en-US'

    micFinal = ''
    listening = true
    micRestartPending = false
    micStart()
  }

  // ── Dashboard card ────────────────────────────────────────────
  // The check-in is how the day's chat opens, not a game sitting on the
  // dashboard waiting to be replayed. Once today's is done the card goes away
  // entirely and comes back tomorrow — todayStamp() is a date string, so the
  // reset happens on its own at midnight with nothing to schedule.
  function refresh() {
    const card = el('checkin-card')
    if (!card) return

    const app = App()
    const r = app?.getSelected?.()
    if (!r) { card.style.display = 'none'; return }

    if (doneToday()) { card.style.display = 'none'; return }
    card.style.display = ''

    const esc = app.esc
    const title = card.querySelector('.card-title')
    const sub = card.querySelector('.card-sub')
    if (title) title.textContent = T('card.title')
    if (sub) sub.textContent = T('card.sub')

    const body = el('checkin-body')
    if (!body) return

    body.innerHTML = `
      <div class="checkin-invite">${esc(T('card.invite'))}</div>
      <button class="btn btn-p checkin-play" onclick="startCheckIn()">${esc(T('card.start'))}</button>
      <div class="checkin-note">${esc(T('card.note'))}</div>`
  }

  // The button-mode panel is static markup in app.html, so its furniture is
  // translated on the way in rather than rebuilt.
  function applyPanelLanguage() {
    const set = (sel, text) => {
      const node = panel()?.querySelector(sel)
      if (node) node.textContent = text
    }
    set('.guess-badge', T('card.title'))
    set('#guess-question', T('ui.ready'))
    set('.guess-send', T('ui.send'))

    const repeatBtn = panel()?.querySelector('[onclick="repeatCheckIn()"]')
    if (repeatBtn) repeatBtn.innerHTML = `<span aria-hidden="true">🔁</span> ${App().esc(T('ui.repeat'))}`
    const stopBtn = panel()?.querySelector('[onclick="stopCheckIn()"]')
    if (stopBtn) stopBtn.innerHTML = `<span aria-hidden="true">✕</span> ${App().esc(T('ui.stop'))}`

    const input = el('guess-free-input')
    if (input) input.placeholder = T('ui.placeholder')

    // Screen-reader names, which are as senior-facing as the visible text.
    el('guess-options')?.setAttribute('aria-label', T('ui.answer'))
    panel()?.setAttribute('aria-label', T('card.title'))
    el('guess-mic')?.setAttribute('aria-label', T('ui.mic.start'))
  }

  // ── Wiring ────────────────────────────────────────────────────
  // startCheckIn is the merged, in-chat version now: the companion opens with
  // "How are you feeling today?" in the transcript and the whole check-in
  // happens as a conversation, spoken or typed. The button-and-panel version
  // is still here under its own name for anyone who cannot talk or type, but
  // nothing reaches for it by default.
  Object.assign(window, {
    startCheckIn: startVoice,
    startVoiceCheckIn: startVoice,
    startCheckInButtons: start,
    stopCheckIn: stop,
    repeatCheckIn: repeat,
    submitCheckInText: submitFree,
    micCheckIn: mic
  })

  window.TechableCheckIn = {
    refresh, start, stop,
    pauseVoice() { micFinal = ''; micAudioStarted = false; micFailed = true; micEnd() },
    startVoice,
    handleUserText,
    isActive: () => Boolean(S?.active),
    isVoiceActive: () => Boolean(S?.active && S?.voice),
    // A typed "no" to a new question is a new answer, not a mic duplicate.
    answerContext: () => S?.active && S.voice ? S.lastPrompt : '',
    todayDone: doneToday,
    markDoneToday,
    // app.js keeps long reminiscences in the life story book, and a disclosure
    // must never end up there — a book the family reads is not where a fall or
    // a frightening home goes. Same reader as the check-in's escalation.
    scanUrgent,

    // The reading layer, exposed for tests. These are pure functions of text
    // and the current language pack — the misreads they now guard against
    // ("I'm not feeling good" heard as a good day) only showed up in a live
    // conversation, which is exactly the kind of bug that needs a unit test.
    // buildContext is here for one reason: it decides what the companion calls
    // the senior, and that name is spoken in nearly every prompt below.
    _read: { readMood, readYesNo, readLean, gaveReason, inferMood, scanUrgent, hobbyPhrase, rankGuesses, buildContext },
    _guesses: GUESSES,

    // Test surface for the check-in's own recogniser — the identical timing
    // fix as app.js's _mic, kept separate because this one targets the
    // check-in textarea and has no app.js dependency to reuse.
    _mic: {
      ensure: () => ensureRec(),
      isBuilt: () => Boolean(rec),
      instance: () => rec,
      listening: () => listening,
      audioStarted: () => micAudioStarted,
      restartPending: () => micRestartPending
    }
  }

  // Built as early as the page allows — refresh() paints the check-in card
  // the moment residents and role are settled, and this is safe alongside it
  // for the same reason it is safe in app.js: construction alone does not
  // touch the microphone.
  document.addEventListener('techable:ready', () => { refresh(); ensureRec() })
})()
