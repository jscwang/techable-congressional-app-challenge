// api/understand.js — Vercel Serverless Function
// Reads ONE sentence a senior said and returns what it meant, as data.
//
// Why this exists
// ───────────────
// Every comprehension decision in the check-in is hand-written regex in
// i18n.js: the mood, the yes/no, which way an "okay" day leaned, whether they
// already gave a reason. The model was never asked what the sentence meant —
// it was only ever asked to WRITE the reply, downstream of a pattern list that
// decided what it was allowed to hear.
//
// That pattern list has been patched, one reported misunderstanding at a time,
// for as long as the file has existed: "fell asleep" raising an emergency,
// "since breakfast" counted as a missed meal, "not feeling good" read as good,
// "right now" read as yes. The one that prompted this endpoint was the
// plainest of the lot — "I'm feeling bad" matched nothing at all, because the
// word `bad` appeared in the whole English pack exactly once, inside "not too
// bad", which means the opposite. A senior said they felt bad and was told
// "I did not quite catch that."
//
// So the regex keeps the job it is good at and this takes the rest:
//
//   regex matched      → use it. Free, instant, works with no network, and it
//                        is the common case. This endpoint is never called.
//   regex found nothing → ask here, once, instead of saying "I did not quite
//                        catch that". That branch is a dead end today, so a
//                        round trip there is strictly better than a wrong
//                        answer.
//   this fails/times out → fall back to exactly the old behaviour.
//
// WHAT THIS DELIBERATELY DOES NOT DO: escalation. Falls, self-harm, abuse and
// the rest stay entirely in checkin.js's URGENT list, which is deterministic,
// auditable, and works when this endpoint is unreachable. A hallucinated
// emergency is not a harmless error — a carer paged for a fall that did not
// happen stops reading the pages, which manufactures the missed disclosure the
// whole mechanism exists to prevent. `concerns` below is recorded so a human
// reviewing the check-in can see it; it raises nothing on its own.
//
// Required env var: OPENAI_API (the same one /api/chat already needs)
// Optional:         UNDERSTAND_MODEL (default: OPENAI_MODEL, then gpt-4.1-mini)
//
// Request  : { text: "...", lang?: "en" | "cmn" | "yue" }
// Response : { mood, tone, gaveReason, concerns[], confidence, model }
//            { aiEnabled: false }  → no key; the client keeps the old path

import { guard } from './_guard.js'
import { OPENAI_BASE, openaiKey, openaiHeaders } from './_openai.js'

// A senior is sitting in front of a silent screen while this runs, so it gets a
// short leash. Past this the old retry line is a better answer than a longer
// wait — and the client applies its own deadline too, because a hung fetch
// never reaches this one.
const TIMEOUT_MS = 6000

// Kept in step with MOODS in checkin.js. Anything outside this list is dropped
// rather than trusted: the client indexes straight into MOODS with it.
const MOODS = ['good', 'okay', 'low', 'tired']

// `tone` is not asked for. It is implied by the mood and checkin.js already
// owns that mapping — asking the model for it would create a second source of
// truth that can disagree with the first. 'okay' has no tone on purpose: the
// check-in asks which way the day leaned instead of guessing.
const TONE = { good: 'positive', okay: null, low: 'negative', tired: 'negative' }

// The concerns checkin.js already records, so the shapes match. The model is
// held to this list rather than inventing categories a dashboard cannot read.
const CONCERNS = ['loneliness', 'discomfort', 'sleep', 'appetite']

const PROMPT = `You read ONE thing an older adult said during a daily well-being check-in and report what it meant. You are a classifier. You do not reply to them and you do not talk to them.

They were asked "How are you feeling today?" — so a bare answer like "bad", "not great" or "so-so" is an answer to THAT question.

mood — one of:
  good  — they are happy, well, cheerful, or the day went well
  okay  — middling, ordinary, so-so, "can't complain", "not too bad" (in English "not bad" is MILDLY POSITIVE, not negative)
  low   — sad, upset, unwell, in pain, lonely, worried, frightened, fed up, "bad", "not good", "not myself"
  tired — tired, exhausted, no energy, did not sleep
  null  — they genuinely did not say how they are (a greeting, a question back, nonsense, or a topic change)

Judge the sentence as a whole. Negation flips the meaning: "not feeling good" is low, not good. If someone is both unwell and tired, pick the one they led with.

gaveReason — true only if they said WHY, or told you what happened, in the same breath. "I'm feeling bad" is false. "I'm sad because my friend was mean" is true. "My knee has been aching all day" is true.

concerns — any of loneliness, discomfort, sleep, appetite that they actually raised. Empty when they raised none. Do not infer from mood alone.

confidence — high when the sentence plainly says one of these, low when you are reading between the lines. Say low rather than guessing.

Report only what they said. Do not diagnose, do not infer a condition, and do not soften a negative answer.`

export default async function handler(req, res) {
  if (guard(req, res, 'POST, OPTIONS')) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const apiKey = openaiKey()
  if (!apiKey) {
    // 200 on purpose, matching /api/chat: the client reads aiEnabled === false
    // and stops asking for the rest of the session.
    res.status(200).json({ aiEnabled: false, error: 'OPENAI_API is not set' })
    return
  }

  let body = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch (_) { body = {} } }
  body = body || {}

  const text = String(body.text || '').trim().slice(0, 500)
  if (!text) { res.status(400).json({ error: 'No text provided' }); return }

  const lang = ['en', 'cmn', 'yue'].includes(body.lang) ? body.lang : 'en'
  const model = process.env.UNDERSTAND_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini'

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const upstream = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: openaiHeaders(apiKey),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: describe(text, lang) }
        ],
        // A classification, not a conversation. Temperature 0 so the same
        // sentence gets the same reading twice — the regex it is standing in
        // for was at least predictable, and losing that would be a step back.
        temperature: 0,
        max_completion_tokens: 200,
        // Structured output, enforced by the API rather than by parsing
        // whatever prose came back. Without this a model returns JSON in a
        // fenced code block about a third of the time. Strict mode needs every
        // property listed as required and nothing else allowed, so a mood
        // that was not said is a null, not a missing key.
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'checkin_reading',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                mood:       { type: ['string', 'null'], enum: [...MOODS, null] },
                gaveReason: { type: 'boolean' },
                concerns:   { type: 'array', items: { type: 'string', enum: CONCERNS } },
                confidence: { type: 'string', enum: ['high', 'low'] }
              },
              required: ['mood', 'gaveReason', 'concerns', 'confidence'],
              additionalProperties: false
            }
          }
        }
      })
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.error('[Techable] understand upstream', upstream.status, detail.slice(0, 300))
      res.status(502).json({ error: 'Upstream request failed', status: upstream.status })
      return
    }

    const json = await upstream.json()
    const choice = json?.choices?.[0]
    const raw = String(choice?.message?.content || '').trim()

    let parsed = null
    try { parsed = JSON.parse(raw) } catch (_) { parsed = null }
    if (!parsed || typeof parsed !== 'object') {
      // A senior describing a fall, a bereavement or feeling that everyone
      // would be better off without them is exactly what this has to be able
      // to read. If the model refuses one, the check-in falls back to its old
      // path — and the URGENT list in checkin.js still sees the sentence.
      const reason = choice?.message?.refusal ? 'refusal' : (choice?.finish_reason || 'empty')
      console.warn('[Techable] understand returned no usable JSON:', reason)
      res.status(502).json({ error: 'Unusable reply', reason })
      return
    }

    res.status(200).json(clean(parsed, model))
  } catch (err) {
    const aborted = err?.name === 'AbortError'
    console.error('[Techable] /api/understand failed:', err?.message || err)
    res.status(aborted ? 504 : 500).json({ error: aborted ? 'Timed out' : 'Failed', timedOut: aborted })
  } finally {
    clearTimeout(timer)
  }
}

// ── Helpers ────────────────────────────────────────────────────

// The sentence is wrapped rather than sent bare, because a senior's answer can
// itself read as an instruction ("stop", "start again", "tell me about the
// weather") and the model is being asked to CLASSIFY it, not obey it.
function describe(text, lang) {
  const named = { en: 'English', cmn: 'Mandarin Chinese', cmn_: '', yue: 'Cantonese' }[lang] || 'English'
  return `The check-in is running in ${named}, though they may answer in any language or mix two.\n\nThey said:\n"""\n${text}\n"""`
}

// The JSON schema constrains what the model may emit; this decides what leaves
// the server. Two different jobs, and doing only the first is how a `mood` of
// "sad" — a word no MOODS entry has — reaches the client and indexes into
// nothing. Everything here fails closed to the shape the caller expects.
function clean(p, model) {
  const mood = MOODS.includes(p.mood) ? p.mood : null
  const confidence = p.confidence === 'high' ? 'high' : 'low'
  return {
    mood,
    // Derived here, never taken from the model — see the note on TONE above.
    tone: mood ? TONE[mood] : null,
    gaveReason: p.gaveReason === true,
    concerns: Array.isArray(p.concerns)
      ? [...new Set(p.concerns.filter(c => CONCERNS.includes(c)))]
      : [],
    confidence,
    model
  }
}
