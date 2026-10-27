// api/tts.js — Vercel Serverless Function
// Neural text-to-speech. Turns a reply into spoken audio that sounds like a
// person rather than a train announcement.
//
// Why this exists: the browser's built-in speechSynthesis reads with whatever
// the operating system ships. On Windows that is a SAPI5 voice — flat and
// unmistakably synthetic — and it is the voice an elderly user hears every
// day. Worse, the two languages that matter most here are the two the OS is
// least likely to have installed. A stock Windows 11 machine reports six
// voices, all English, none Chinese: on that machine a Cantonese check-in has
// no voice to speak with at all. This endpoint is the only way it gets one.
//
// ── Two engines ────────────────────────────────────────────────
//
// A. OpenAI speech (default, no extra setup)
//    Uses the OPENAI_API key that /api/chat already needs. gpt-4o-mini-tts
//    takes a plain-English direction in its own `instructions` field — "warmly,
//    unhurried, like a kind friend" — which is most of what separates a
//    companion from an announcement board.
//    Caveat worth knowing before you rely on it: it is asked to speak
//    Cantonese by instruction, not by picking a Cantonese voice, so verify by
//    ear that a yue reply does not come out sounding Mandarin. If it does,
//    use engine B, which has real yue-HK voices.
//
// B. Google Cloud Text-to-Speech (better for Cantonese, needs a service account)
//    Cloud TTS refuses API keys outright — it answers 401 CREDENTIALS_MISSING
//    to any ?key= request — so it needs a service account, signed for here
//    with node:crypto rather than a dependency. Set GOOGLE_TTS_SA_KEY to the
//    whole service-account JSON (or its base64) and this takes over: real
//    per-language voices, including yue-HK Cantonese.
//
// Env:
//   OPENAI_API            — engine A (already required by /api/chat)
//   GOOGLE_TTS_SA_KEY     — engine B: service-account JSON, raw or base64
//   TTS_OPENAI_MODEL      — default gpt-4o-mini-tts. tts-1 and tts-1-hd ignore
//                           `instructions`, which is where the accent is
//                           asked for, so do not move to them.
//   TTS_VOICE_EN / _CMN / _YUE — pin an exact voice on either engine
//   TTS_LOCALE_EN         — default en-US. Picks the voice on engine B. On
//                           engine A the accent is the one STYLE names.
//
// Request  : { text, lang: "en"|"cmn"|"yue", rate?: 0.5–1.5 }
// Response : { audio: "<base64>", mime, voice, engine, rateApplied }
//            { ttsEnabled: false } → not configured. The client stops asking
//                                    for the rest of the session.
//            429 { retryable: false, retryAfter } → the quota is spent. Not a
//                                    failure of the feature: the client uses
//                                    the OS voice until the window lifts, then
//                                    picks the good voice back up by itself.
//            5xx { retryable: true } → this utterance failed. The client speaks
//                                    it with the OS voice and tries again on
//                                    the next one.
//
// Those three differ in how long they last, and collapsing them is what an
// elderly user hears. A missing key is permanent. A spent quota lifts on its
// own — retrying inside it only adds a wait before the companion speaks, and
// counting those retries as failures retires the neural voice for the whole
// visit. A blocked or timed-out utterance is neither.

import crypto from 'node:crypto'
import { guard } from './_guard.js'
import { OPENAI_BASE, openaiKey, openaiHeaders } from './_openai.js'

// How long to hold a connection open before calling it dead.
//
// This was a flat twenty seconds, which is not patience — it is twenty seconds
// of silence in front of somebody waiting to be spoken to, for a line that was
// never coming. A neural engine takes roughly as long to make speech as the
// speech lasts, so the honest ceiling scales with the text: generous for a
// long chunk, and short enough on a forty-character opener that a hung
// connection is given up on while the senior is still willing to wait.
//
// The per-character figure has to stay ABOVE what synthesis actually costs, or
// this cuts off audio that was on its way and the senior gets the robotic voice
// on a working day. Speech runs about 11 characters a second at the rate this
// app asks for, so ~90ms a character, and the base covers the round trip and a
// cold start. Being too generous only costs a hung socket a few extra seconds;
// being too tight costs the feature. Same reasoning, and the same number, as
// FIRST_WORD_PER_CHAR in app.js — if one moves, move both.
const TIMEOUT_BASE_MS = 5000
const TIMEOUT_PER_CHAR_MS = 90
const TIMEOUT_MAX_MS = 20000
const MAX_CHARS = 1200

// Exported for the test suite: the boundaries are cheap to assert directly,
// and a wall-clock test alone would take twenty seconds to prove the bad case.
export function timeoutFor(text) {
  return Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + String(text || '').length * TIMEOUT_PER_CHAR_MS)
}

// A refusal that will refuse again a millisecond later, and roughly for how
// long. The error body says so — passing it on is what lets the client stop
// asking, instead of putting a failed round trip in front of every sentence
// until it has given up on the neural voice for the whole visit.
//
// Google puts it in a retryDelay field; OpenAI writes "Please try again in
// 53s" into the message. An OpenAI account with no credit left also answers
// 429, as insufficient_quota, and that does not lift in a minute — retrying it
// every minute all day is the storm this exists to stop, so it gets the
// longest wait allowed.
function retryAfterFrom(status, body, headers) {
  if (status !== 429) return 0
  const text = String(body || '')
  if (/insufficient_quota/.test(text)) return 3600
  const fromBody = Number(
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text)?.[1] ??
    /try again in (\d+(?:\.\d+)?)s\b/i.exec(text)?.[1]
  )
  const fromHead = Number(headers?.get?.('retry-after'))
  const secs = Number.isFinite(fromBody) && fromBody > 0 ? fromBody
             : Number.isFinite(fromHead) && fromHead > 0 ? fromHead
             : 60
  return Math.min(3600, Math.max(5, Math.ceil(secs)))
}

// en-US, not en-GB. The app spells British, but what a listener notices is the
// accent, and this is the one that was asked for. On the Cloud engine this
// decides the accent outright — it selects the voice. OpenAI speech takes no
// locale at all, so there the instruction in STYLE is all there is.
// TTS_LOCALE_EN is an override, not a free-text field. A malformed or unrelated
// value here does not fail loudly — it just quietly decides which accent an
// elderly user hears for the rest of the deployment, which is the one class of
// bug that can only be found by listening. Anything that is not a well-formed
// English tag is ignored and reported.
function localeEn() {
  const set = String(process.env.TTS_LOCALE_EN || '').trim()
  if (!set) return 'en-US'
  if (/^en-[A-Za-z]{2}$/.test(set)) return set.slice(0, 3) + set.slice(3).toUpperCase()
  console.warn(`[Techable] TTS: ignoring TTS_LOCALE_EN="${set}" — expected a tag like en-US`)
  return 'en-US'
}

const LOCALES = {
  en:  localeEn,
  cmn: () => 'cmn-CN',
  yue: () => 'yue-HK'
}

const PINNED = {
  en:  () => process.env.TTS_VOICE_EN,
  cmn: () => process.env.TTS_VOICE_CMN,
  yue: () => process.env.TTS_VOICE_YUE
}

// ── Engine A: OpenAI speech ────────────────────────────────────

// The persona, spoken rather than written. This is the part that answers
// "less robotic, more human" — a neural voice reading with no direction still
// reads like a newsreader. Kept short: the model follows a sentence of
// direction well and starts performing at a paragraph of it.
//
// The accent sentence is not decoration. A speech model is not a voice
// bank: the voice name fixes the timbre, and everything else about
// the delivery — including which English accent it uses — is re-decided on
// every request from the instruction and the text. Unpinned, the same
// companion greeted a senior in an American accent and then answered them in
// an Australian one, and asking it to "speak slower" flipped it back, because
// the request had changed the text it was reading. Naming the accent, in the
// same words every time, is what makes the voice recognisably one person.
//
// Naming the accent positively was not enough on its own — it was tried, and
// the companion still came back Australian. A model reads "American" as one
// option among the English accents it knows unless the others are closed off,
// so the wrong ones are now named and refused, and the accent is asked for in
// terms of a specific speaker rather than a label.
const STYLE = {
  en:  'Speak in a standard American English accent — General American, the accent of a national news presenter in the United States. '
     + 'Never a British, Australian, Irish, Canadian or Indian accent. '
     + 'Always use this same accent, voice and pace, whatever the words say. '
     + 'Read the following warmly and gently, unhurried, the way a kind friend speaks to an older person they are fond of. Do not read this instruction aloud.',
  cmn: '用標準普通話朗讀，口音、聲線同語速每次都要一樣，唔好因為內容而改變。'
     + '用溫暖、親切、不急不趕的語氣朗讀以下內容，像一位關心長輩的朋友。不要讀出這句指示。',
  // Named explicitly, because a model told only "Chinese" reads Cantonese text
  // in Mandarin — the same trap the chat prompt and i18n.js both warn about.
  yue: '請用地道香港廣東話朗讀，口音、聲線同語速每次都要一樣，唔好因為內容而改變。'
     + '用溫暖親切、不急不趕嘅語氣朗讀以下內容，好似一個關心長輩嘅朋友咁。唔好讀出呢句指示。'
}

// One voice per language, and the same one every time. Kept identical across
// the three on purpose: it is the same companion speaking, so a senior who
// switches language should still recognise who is talking to them. coral is
// the warmest of OpenAI's built-in voices to most listeners; TTS_VOICE_* pins
// another without a redeploy.
const OPENAI_VOICES = { en: 'coral', cmn: 'coral', yue: 'coral' }

async function openaiTTS(apiKey, text, lang, signal) {
  const model = process.env.TTS_OPENAI_MODEL || 'gpt-4o-mini-tts'
  const voice = PINNED[lang]() || OPENAI_VOICES[lang] || 'coral'

  const r = await fetch(`${OPENAI_BASE}/audio/speech`, {
    method: 'POST',
    headers: openaiHeaders(apiKey),
    signal,
    body: JSON.stringify({
      model,
      voice,
      // The direction has a field of its own here. Put in front of the words,
      // the way the Gemini engine had to, it would be read aloud.
      input: text,
      instructions: STYLE[lang] || STYLE.en,
      response_format: 'mp3'
    })
  })

  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    // The whole body is searched for the retry hint and only the message is
    // truncated: the wait can sit past the 200 characters worth logging.
    const err = new Error(`openai-tts ${r.status}: ${detail.slice(0, 200)}`)
    err.status = r.status
    const after = retryAfterFrom(r.status, detail, r.headers)
    if (after) err.retryAfter = after
    throw err
  }

  // The answer is the audio file itself. An empty one is a failed utterance,
  // not a broken configuration.
  const audio = Buffer.from(await r.arrayBuffer())
  if (!audio.length) throw new Error('openai-tts returned no audio')

  // gpt-4o-mini-tts ignores `speed`, so the client slows playback instead,
  // exactly as it did for Gemini.
  return { audio: audio.toString('base64'), mime: 'audio/mpeg', voice, engine: 'openai', rateApplied: false }
}

// ── Engine B: Google Cloud TTS ─────────────────────────────────

function serviceAccount() {
  const raw = process.env.GOOGLE_TTS_SA_KEY
  if (!raw) return null
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
    const sa = JSON.parse(text)
    return sa.client_email && sa.private_key ? sa : null
  } catch (_) {
    console.error('[Techable] GOOGLE_TTS_SA_KEY is not valid JSON or base64 JSON')
    return null
  }
}

// Tokens last an hour; warm invocations reuse them rather than paying an
// extra round trip before every spoken sentence.
let token = null

async function accessToken(sa, signal) {
  const now = Math.floor(Date.now() / 1000)
  if (token && token.exp > now + 60) return token.value

  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = b64({ alg: 'RS256', typ: 'JWT' })
  const claim = b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key)

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${claim}.${sig.toString('base64url')}`
    })
  })

  if (!r.ok) throw new Error(`oauth ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`)
  const json = await r.json()
  token = { value: json.access_token, exp: now + (Number(json.expires_in) || 3600) }
  return token.value
}

// Voice names are not hardcoded: Google retires them on its own schedule, and
// a pinned name that has been withdrawn fails every request with a 400 that
// looks exactly like an outage. Ask which voices exist and rank what comes
// back, so new voice generations arrive without a redeploy.
function tierOf(name) {
  const n = String(name || '')
  if (/Chirp3?-?HD|Chirp-HD/i.test(n)) return 6
  if (/Studio/i.test(n))               return 5
  if (/Neural2|Polyglot|Journey/i.test(n)) return 4
  if (/Wavenet/i.test(n))              return 3
  if (/News/i.test(n))                 return 2
  return 1                              // Standard
}

const voiceCache = new Map()

async function cloudVoices(bearer, languageCode, signal) {
  if (voiceCache.has(languageCode)) return voiceCache.get(languageCode)

  const r = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(languageCode)}`,
    { headers: { Authorization: `Bearer ${bearer}` }, signal }
  )
  if (!r.ok) {
    console.error('[Techable] TTS voices lookup', r.status, (await r.text().catch(() => '')).slice(0, 200))
    // Deliberately not cached. A voices lookup can fail for a minute — a 500, a
    // token that expired between the two calls — and caching the empty answer
    // made that permanent for the life of the instance: every later request for
    // that language threw "no cloud voices" for a language that has dozens.
    return []
  }

  // Ranked, then broken by name. The name tiebreak is the part that matters:
  // Google returns a dozen voices of the same generation and gender, Array
  // sort is only stable with respect to the order they arrived in, and a
  // serverless function is many short-lived instances. Without a total order
  // two instances could rank the same list differently and answer consecutive
  // sentences of one conversation in two different voices.
  const score = v => tierOf(v.name) * 10 + (v.ssmlGender === 'FEMALE' ? 2 : 0)

  const ranked = ((await r.json())?.voices || [])
    .filter(v => v.name && Array.isArray(v.languageCodes))
    // A companion, not a newsreader: female reads as warmer to most listeners.
    // A tiebreak only — voice generation matters far more.
    .sort((a, b) => score(b) - score(a) || String(a.name).localeCompare(String(b.name)))
    .map(v => ({ name: v.name, languageCode: v.languageCodes[0] }))

  // Same reasoning: only a real answer is worth remembering.
  if (ranked.length) voiceCache.set(languageCode, ranked)
  return ranked
}

// Chirp 3: HD voices reject the two knobs below with a 400, which the retry
// loop would read as "this voice is unavailable" and answer in a different
// one — an audible voice change caused entirely by us.
function audioConfig(voiceName, rate) {
  const cfg = { audioEncoding: 'MP3', speakingRate: rate, volumeGainDb: 2 }
  if (/Chirp/i.test(voiceName)) return cfg
  return {
    ...cfg,
    pitch: 0,
    // Usually a phone or tablet at arm's length, often held by someone
    // hard of hearing. This profile lifts the speech band.
    effectsProfileId: ['handset-class-device']
  }
}

// The voice that last actually spoke for a language, so a one-off rejection
// costs a single sentence rather than moving the companion to a new voice for
// the rest of the conversation.
const chosen = new Map()

async function cloudTTS(sa, text, lang, rate, signal) {
  const bearer = await accessToken(sa, signal)
  const languageCode = LOCALES[lang]()
  const pinned = PINNED[lang]()
  const ranked = pinned
    ? [{ name: pinned, languageCode }]
    : await cloudVoices(bearer, languageCode, signal)

  // Whatever spoke last for this language goes first, so the voice only ever
  // moves when the one being used has genuinely stopped working.
  const stick = chosen.get(languageCode)
  const candidates = stick
    ? [ranked.find(v => v.name === stick) || { name: stick, languageCode },
       ...ranked.filter(v => v.name !== stick)]
    : ranked

  if (!candidates.length) throw new Error(`no cloud voices for ${languageCode}`)

  // Walk down the ranked list: a voice can be withdrawn or unavailable in this
  // project's region, and that should cost one retry, not the whole feature.
  let last = ''
  for (const v of candidates.slice(0, 3)) {
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        // Plain text, never SSML: what passes through here includes whatever
        // the senior said back to us, and SSML would let a stray angle bracket
        // rewrite the markup.
        input: { text },
        voice: { languageCode: v.languageCode || languageCode, name: v.name },
        audioConfig: audioConfig(v.name, rate)
      })
    })

    if (r.ok) {
      const audio = (await r.json())?.audioContent
      if (audio) {
        chosen.set(languageCode, v.name)
        return { audio, mime: 'audio/mpeg', voice: v.name, engine: 'cloud', rateApplied: true }
      }
    }

    // A quota is spent per project, not per voice, so walking down the list
    // cannot help — it can only spend two more round trips discovering the
    // same refusal while somebody waits to be spoken to.
    if (r.status === 429) {
      const err = new Error(`cloud-tts 429 (${v.name})`)
      err.status = 429
      err.retryAfter = retryAfterFrom(429, await r.text().catch(() => ''), r.headers)
      throw err
    }

    last = `${v.name} → ${r.status}`
    console.warn('[Techable] TTS voice rejected', last)
  }
  throw new Error(`cloud-tts exhausted candidates (${last})`)
}

// ── Handler ────────────────────────────────────────────────────

// Languages whose resolved voice has already been written to the log.
const announced = new Set()

export default async function handler(req, res) {
  // Sets no-store too: spoken audio is one person's conversation and must not
  // sit in a shared cache.
  if (guard(req, res, 'POST, GET, OPTIONS')) return

  const sa = serviceAccount()
  const apiKey = openaiKey()

  // GET is a capability probe, so the client can decide once per session
  // whether the network path is worth trying at all. It also reports what the
  // English accent has actually resolved to: "the voice is still Australian" is
  // otherwise only answerable by ear, and the answer is usually an environment
  // variable rather than the code.
  if (req.method === 'GET') {
    res.status(200).json({
      ttsEnabled: Boolean(sa || apiKey),
      engine: sa ? 'cloud' : (apiKey ? 'openai' : null),
      localeEn: LOCALES.en(),
      voiceEn: PINNED.en() || (sa ? 'auto (ranked per locale)' : OPENAI_VOICES.en),
      // OpenAI decides the accent from the instruction; Cloud decides it from
      // the voice name. Only one of those is a guarantee.
      accentGuaranteed: Boolean(sa)
    })
    return
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  if (!sa && !apiKey) {
    // 200 on purpose: the client reads ttsEnabled === false and quietly uses
    // the browser's voice. A 500 here would look like a broken app.
    res.status(200).json({ ttsEnabled: false, error: 'No OPENAI_API or GOOGLE_TTS_SA_KEY set' })
    return
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch (_) { body = {} } }
  body = body || {}

  const text = String(body.text || '').trim().slice(0, MAX_CHARS)
  if (!text) { res.status(400).json({ error: 'No text provided' }); return }

  const lang = LOCALES[body.lang] ? body.lang : 'en'
  // Slower than conversational, because the listener is often hard of hearing —
  // but not as slow as the old browser path needed. A neural voice keeps its
  // rhythm when slowed; a robotic one just drags.
  const rate = Math.min(1.5, Math.max(0.5, Number(body.rate) || 0.92))

  const controller = new AbortController()
  const budget = timeoutFor(text)
  const timer = setTimeout(() => controller.abort(), budget)

  try {
    const out = sa
      ? await cloudTTS(sa, text, lang, rate, controller.signal)
      : await openaiTTS(apiKey, text, lang, controller.signal)
    // Once per language per instance: enough to answer "which voice is it
    // actually using" from the logs, quiet enough not to be noise.
    if (!announced.has(lang)) {
      announced.add(lang)
      console.log(`[Techable] TTS ${lang}: engine=${out.engine} voice=${out.voice} locale=${LOCALES[lang]()}`)
    }
    res.status(200).json({ ...out, rate })
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    console.error('[Techable] TTS failed:', aborted ? `timeout after ${budget}ms` : err?.message)

    // Rationed, not broken, and the two want different answers. The free tier
    // allows a small number of requests a day, and one reply is several of
    // them — so a real visit reaches this after about five answers. Saying only
    // "failed" made the client retry immediately (a second refusal, and a
    // second wait the senior hears as the companion going quiet) and then
    // count it towards giving up on the neural voice for the rest of the day.
    //
    // Still not { ttsEnabled: false }: the key is fine and the feature is not
    // gone. retryAfter says when it is worth asking again.
    const after = Number(err?.retryAfter) || 0
    if (after > 0) {
      res.setHeader('Retry-After', String(after))
      res.status(429).json({ error: 'TTS quota exhausted', retryable: false, retryAfter: after })
      return
    }

    // Anything else is this utterance only. The client speaks it with the OS
    // voice and asks for the next one normally.
    //
    // Except a timeout, which is not worth asking twice: the wait has already
    // been spent in full here, and a second attempt spends it again in front of
    // somebody who has been looking at an unread reply for that whole time. The
    // client still tries the next utterance normally — this is about this one.
    res.status(aborted ? 504 : 502).json({
      error: aborted ? 'TTS timed out' : 'TTS failed',
      retryable: !aborted,
      // Marked, rather than left to be inferred from the status code. The
      // client already exempts its OWN missed deadline from the count that
      // retires the neural voice — a slow engine is not a broken one — and then
      // counted this, which is the same event seen from the other end. Because
      // the client's deadline is the tighter of the two below the shared 20000
      // ceiling — 2500ms of base against 5000ms here — every slow
      // reply landed here a moment after the fallback had already spoken, and
      // three of them took the good voice away for the rest of the visit. That
      // is precisely the fault the deadline was added to prevent.
      timedOut: aborted
    })
  } finally {
    clearTimeout(timer)
  }
}
