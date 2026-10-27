// api/_guard.js — who is allowed to call these functions, and how often.
//
// Every endpoint here answered `Access-Control-Allow-Origin: *` and asked the
// caller for nothing at all. /api/chat and /api/tts spend a Gemini key that
// belongs to whoever deployed this, so that is an open, unauthenticated proxy:
// anyone who finds the URL can run a chatbot and a speech engine on somebody
// else's bill. The free TTS allowance in particular is small, and exhausting it
// does not just cost money — it drops real seniors back to the robotic browser
// voice for the rest of the day.
//
// WHAT THIS DOES NOT DO: it does not verify WHO the caller is. That wants a
// Firebase ID token checked against the project, which is a question about
// which accounts are allowed to use the app — the same question the Firestore
// rules are waiting on. This is the part that can be settled without it.
//
// Both controls fail OPEN when unconfigured, and say so in the logs. A guard
// that silently breaks a working deployment the moment it ships is worse than
// the hole it closes.

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)

// Preview URLs are generated at deployment time. Trust only the exact hosts
// supplied by Vercel's server environment, never a request Host or wildcard.
// Production retains its explicitly configured allowlist.
if(process.env.VERCEL_ENV==='preview'){
  for(const host of [process.env.VERCEL_URL,process.env.VERCEL_BRANCH_URL]){
    if(typeof host==='string'&&/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/i.test(host))ALLOWED.push('https://'+host.toLowerCase())
  }
}

let warnedOpen = false

// Requests per window, per client, per instance.
//
// Set high on purpose. A reply is spoken in pieces, so one answer can be five
// or six /api/tts calls, the keep-warm probe adds one every four minutes, and a
// care home or a family on one connection shares an address. Cutting a senior
// off mid-sentence is a worse failure than letting an abuser through slowly, so
// this is a brake on scripted hammering, not a quota.
const WINDOW_MS = 60000
const MAX_PER_WINDOW = Number(process.env.API_RATE_LIMIT || 90)

// Best-effort, and deliberately so. Serverless instances are short-lived and
// there may be many at once, so this is not a global quota — it is a brake on
// the cheapest kind of abuse (one machine in a loop) that costs no
// infrastructure. A real limit belongs at the edge.
const hits = new Map()

function clientKey(req) {
  const fwd = (req.headers || {})['x-forwarded-for']
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim()
  return ip || req.socket?.remoteAddress || 'unknown'
}

function rateLimited(req) {
  if (MAX_PER_WINDOW <= 0) return false
  const key = clientKey(req)
  const now = Date.now()
  const seen = hits.get(key)

  if (!seen || now - seen.start >= WINDOW_MS) {
    hits.set(key, { start: now, n: 1 })
    // Keep the map from growing without bound on a long-lived instance.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now - v.start >= WINDOW_MS) hits.delete(k)
    }
    return false
  }

  seen.n++
  return seen.n > MAX_PER_WINDOW
}

function originAllowed(origin) {
  if (!ALLOWED.length) return true            // unconfigured: fail open
  if (!origin) return true                    // same-origin and server-to-server send none
  return ALLOWED.includes(String(origin).replace(/\/$/, ''))
}

// Returns true when the caller has been answered and the handler should stop.
//
// `methods` is what this endpoint accepts, e.g. 'POST, OPTIONS'.
export function guard(req, res, methods) {
  // Defensive: a handler must not throw on a request shaped oddly, and these
  // are also called directly from the test suite with minimal stubs.
  const origin = (req.headers || {}).origin

  // Echo the caller's origin when it is on the list, rather than '*'. With
  // credentials never sent here it is mostly signalling, but it is the
  // difference between a browser refusing a cross-site call and helping it.
  res.setHeader('Access-Control-Allow-Origin', ALLOWED.length ? (origin || ALLOWED[0]) : '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Cache-Control', 'no-store')

  if (!ALLOWED.length && !warnedOpen) {
    warnedOpen = true
    console.warn('[Techable] ALLOWED_ORIGINS is not set — these functions will answer any site. ' +
                 'Set it to your deployment origin, e.g. https://techable.example')
  }

  if (req.method === 'OPTIONS') { res.status(204).end(); return true }

  if (!originAllowed(origin)) {
    console.warn('[Techable] refused cross-origin call from', origin)
    res.status(403).json({ error: 'Origin not allowed' })
    return true
  }

  if (rateLimited(req)) {
    const after = Math.ceil(WINDOW_MS / 1000)
    res.setHeader('Retry-After', String(after))
    // Same shape /api/tts uses for an exhausted upstream quota, and for the
    // same reason: a caller told only "failed" retries immediately, which is a
    // second refusal and a second silence in front of whoever is waiting to be
    // spoken to. retryable says not to; retryAfter says when it is worth it.
    res.status(429).json({ error: 'Too many requests', retryable: false, retryAfter: after })
    return true
  }

  return false
}
