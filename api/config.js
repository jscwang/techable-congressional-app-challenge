// api/config.js — Vercel Serverless Function
// Required env vars: FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
//   FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID, OPENAI_API
//
// Auto-derived (no env var needed):
//   FIREBASE_AUTH_DOMAIN    → {projectId}.firebaseapp.com
//   FIREBASE_STORAGE_BUCKET → {projectId}.firebasestorage.app

import { guard } from './_guard.js'
import { adminAccessConfigured } from './_firestore-admin.js'
import { openaiKey } from './_openai.js'

export default function handler(req, res) {
  if (guard(req, res, 'GET, OPTIONS')) return
  if (req.method !== 'GET')     { res.status(405).json({ error: 'Method not allowed' }); return }

  const projectId = process.env.FIREBASE_PROJECT_ID || ''

  // authDomain and storageBucket are always predictable from projectId.
  // Derive them so they never need to be set as separate env vars.
  const authDomain    = process.env.FIREBASE_AUTH_DOMAIN
                        || (projectId ? `${projectId}.firebaseapp.com` : '')

  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET
                        || (projectId ? `${projectId}.firebasestorage.app` : '')

  const firebase = {
    apiKey:            process.env.FIREBASE_API_KEY             || '',
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID              || '',
    measurementId:     process.env.FIREBASE_MEASUREMENT_ID      || ''
  }

  // Admin access too (FIREBASE_ADMIN_SA_KEY, or keyless workload identity —
  // F37): api/verification-storage.js checks the caller's role with it and
  // refuses every upload without it (F09-2), so offering the upload field
  // would only make each manager or provider sign-up fail.
  const supabaseStorageConfigured = Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && adminAccessConfigured()
  )

  const missing = Object.entries({
    FIREBASE_API_KEY:             firebase.apiKey,
    FIREBASE_PROJECT_ID:          firebase.projectId,
    FIREBASE_MESSAGING_SENDER_ID: firebase.messagingSenderId,
    FIREBASE_APP_ID:              firebase.appId,
    OPENAI_API:                   openaiKey()
  }).filter(([, v]) => !v).map(([k]) => k)

  if (missing.length) console.warn('[Techable] Missing env vars:', missing.join(', '))

  // SECURITY FIX: never send the AI key (OPENAI_API) to the browser. Anyone could open
  // /api/config in devtools, copy the key, and run up your billing. The key now
  // stays server-side and is used only by /api/chat. The client just needs to
  // know whether AI is available (aiEnabled) and which model/mode to request.
  // Natural-sounding speech. Uses the OpenAI key that is already here;
  // GOOGLE_TTS_SA_KEY (a service-account JSON) switches /api/tts to Google
  // Cloud TTS instead, which has real yue-HK Cantonese voices. Either way the
  // client falls back to the browser's own voice if the request fails, so this
  // flag only says "worth trying", never "guaranteed".
  res.status(200).json({
    aiEnabled:   Boolean(openaiKey()),
    transcriptionEnabled: Boolean(openaiKey() && firebase.apiKey),
    ttsEnabled:  Boolean(process.env.GOOGLE_TTS_SA_KEY || openaiKey()),
    // Firebase remains the identity/database provider. Verification documents
    // use signed URLs from our authenticated Supabase storage proxy.
    storageEnabled: supabaseStorageConfigured,
    storageProvider: supabaseStorageConfigured ? 'supabase' : null,
    aiModel:     process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    aiMode:      process.env.AI_MODE      || 'openai',
    firebase,
    // Which env vars are unset is a description of the deployment's innards and
    // it went to anyone who asked. The login pages only need to know that the
    // config is incomplete — the names are in the server log, where whoever can
    // fix them is looking.
    configIncomplete: missing.length > 0
  })
}
