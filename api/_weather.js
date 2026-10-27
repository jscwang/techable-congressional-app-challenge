// api/_weather.js — shared OpenWeather lookup.
//
// The leading underscore keeps Vercel from exposing this as its own route;
// it is imported by api/chat.js and api/weather.js.
//
// Required env var: OPENWEATHER_API_KEY
// Optional:         OPENWEATHER_DEFAULT_CITY  (e.g. "Kuala Lumpur,MY")
//
// Everything here fails soft. Weather is a nice-to-have flavour on top of the
// conversation — if the key is missing, the city is unknown, or OpenWeather is
// slow, the caller gets null and the chat carries on exactly as before.

const TIMEOUT_MS = 4000
const CACHE_MS = 15 * 60 * 1000   // 15 min: weather does not move faster than
                                  // a check-in cycle, and this keeps us far
                                  // inside the free tier's call limits.

// Module-level cache. Vercel keeps warm instances alive between invocations,
// so this genuinely saves calls; a cold start simply repopulates it.
//
// F39: the place comes from the browser (api/chat.js passes resident.location
// straight in), and this used to be keyed by the raw string with no length cap
// and no eviction — every made-up "city" was another entry for the life of the
// instance and another call against the OpenWeather quota. Now each part is
// trimmed and capped (an over-long one is not looked up at all), the key is
// case- and spacing-insensitive, and the Map holds at most MAX_ENTRIES:
// expired entries go first, then the oldest.
const MAX_PART = 80
const MAX_ENTRIES = 200
const cache = new Map()

// For tests: the cache must stay bounded however many places are asked for.
export function weatherCacheSize() { return cache.size }

function remember(key, value) {
  const now = Date.now()
  cache.delete(key)   // re-inserting moves it to the newest end
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k)
  }
  while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value)
  cache.set(key, { at: now, value })
}

export async function getWeather({ city, country } = {}) {
  const apiKey = process.env.OPENWEATHER_API_KEY
  if (!apiKey) return null

  const place = buildQuery(city, country)
  if (!place) return null
  const key = place.toLowerCase()

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const url = 'https://api.openweathermap.org/data/2.5/weather'
    + `?q=${encodeURIComponent(place)}&units=metric&appid=${encodeURIComponent(apiKey)}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      // 404 = city not recognised. Cache the miss briefly so a bad centre
      // address does not cause a lookup on every single message.
      if (res.status === 404) remember(key, null)
      else console.warn('[Techable] OpenWeather', res.status)
      return null
    }

    const j = await res.json()
    const value = shape(j, place)
    remember(key, value)
    return value
  } catch (err) {
    console.warn('[Techable] weather lookup failed:', err?.name === 'AbortError' ? 'timeout' : err?.message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// '' for nothing usable, null for something that must not be looked up (too
// long). Only strings: anything else from a request body is ignored.
function cleanPart(value) {
  if (typeof value !== 'string') return ''
  const v = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return v.length > MAX_PART ? null : v
}

function buildQuery(city, country) {
  const c = cleanPart(city)
  const k = cleanPart(country)
  if (c === null || k === null) return null
  if (c) return k ? `${c},${k}` : c
  return String(process.env.OPENWEATHER_DEFAULT_CITY || '').trim() || null
}

function shape(j, place) {
  const description = j?.weather?.[0]?.description || ''
  const main = j?.weather?.[0]?.main || ''
  const temp = Number.isFinite(j?.main?.temp) ? Math.round(j.main.temp) : null
  const feelsLike = Number.isFinite(j?.main?.feels_like) ? Math.round(j.main.feels_like) : null

  return {
    available: true,
    place: j?.name || place,
    description,
    main,
    temp,
    feelsLike,
    // Is it the kind of day worth suggesting a bit of fresh air? Deliberately
    // conservative — used to decide whether Techable encourages going outside.
    pleasant: isPleasant(main, temp),
    wet: /rain|drizzle|thunderstorm|snow/i.test(main),
    // A short, plain-English line safe to speak aloud to an elderly listener.
    summary: summarise(description, temp)
  }
}

function isPleasant(main, temp) {
  if (/rain|drizzle|thunderstorm|snow|squall|tornado/i.test(main)) return false
  if (temp == null) return false
  return temp >= 16 && temp <= 30
}

function summarise(description, temp) {
  const d = description ? description.replace(/\b\w/, c => c.toUpperCase()) : 'Mild'
  return temp == null ? d : `${d}, around ${temp}°C`
}
