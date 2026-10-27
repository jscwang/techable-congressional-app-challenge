// api/weather.js — Vercel Serverless Function
//
// Current conditions for a centre's location, so the browser never sees the
// OpenWeather key. Used by checkin.js when the "Is it because of the weather?"
// guess lands, so Techable can say something true about today rather than a
// generic pleasantry.
//
// GET /api/weather?city=Kuala%20Lumpur&country=MY
// →  { available: true, description, temp, summary, pleasant, wet, place }
// →  { available: false }            when unconfigured or unavailable
//
// Always 200: the client treats "no weather" as a normal, unremarkable state.

import { getWeather } from './_weather.js'
import { guard } from './_guard.js'

export default async function handler(req, res) {
  if (guard(req, res, 'GET, OPTIONS')) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return }

  // Overrides the guard's no-store: the weather is not private and a browser
  // reusing a lookup for a few minutes is a saved upstream call.
  res.setHeader('Cache-Control', 'public, max-age=600')

  const { city = '', country = '' } = req.query || {}

  try {
    const weather = await getWeather({ city, country })
    res.status(200).json(weather || { available: false })
  } catch (err) {
    console.error('[Techable] /api/weather failed:', err?.message || err)
    res.status(200).json({ available: false })
  }
}
