// api/_openai.js — shared by chat, understand and tts. Not a route (the
// leading underscore keeps Vercel from serving it).
//
// The key is read from OPENAI_API, the name it was set under in Vercel.
// OPENAI_API_KEY is accepted too: it is the name OpenAI's own docs and SDKs
// use, and someone following them would otherwise set a key the app never sees
// and get canned replies with no clue why.
//
// The key only ever travels as a bearer header. Gemini took it in the query
// string, where it lands in every proxy and request log on the way.

export const OPENAI_BASE = 'https://api.openai.com/v1'

export function openaiKey() {
  return process.env.OPENAI_API || process.env.OPENAI_API_KEY || ''
}

export function openaiHeaders(key) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
}
