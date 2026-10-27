// Browser-side half of the verification upload flow. Firebase proves who the
// user is; the server returns a one-object Supabase signed URL. No Supabase
// secret or publishable key is shipped to the browser.

function uploadError(message) {
  const error = new Error(message || 'Document upload failed')
  error.code = 'storage/upload-failed'
  return error
}

async function responseJson(response) {
  return response.json().catch(() => ({}))
}

export async function deleteVerificationFiles(user, role, documents) {
  const paths = (Array.isArray(documents) ? documents : []).map(item => item?.path).filter(Boolean)
  if (!user || !paths.length) return
  const idToken = await user.getIdToken()
  const response = await fetch('/api/verification-storage', {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ role, paths })
  })
  if (!response.ok) throw uploadError((await responseJson(response)).error)
}

export async function uploadVerificationFiles(user, role, files, contentTypeFor) {
  const uploaded = []
  const prepared = []
  const idToken = await user.getIdToken()

  try {
    for (const file of files) {
      const type = contentTypeFor(file)
      const signResponse = await fetch('/api/verification-storage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`
        },
        body: JSON.stringify({ role, name: file.name, type, size: file.size })
      })
      const signed = await responseJson(signResponse)
      if (!signResponse.ok || !signed.signedUrl || !signed.path) throw uploadError(signed.error)
      // An interrupted PUT may already have stored the object. Roll back its
      // prepared path as well as uploads whose response reached this browser.
      prepared.push({ path: signed.path })

      // This is the same multipart shape used by Supabase's uploadToSignedUrl.
      const form = new FormData()
      form.append('cacheControl', '3600')
      form.append('', file.type === type ? file : new Blob([file], { type }), file.name)
      const uploadResponse = await fetch(signed.signedUrl, { method: 'PUT', body: form })
      if (!uploadResponse.ok) {
        const detail = await responseJson(uploadResponse)
        throw uploadError(detail.message || detail.error)
      }

      uploaded.push({
        name: file.name,
        path: signed.path,
        type,
        size: file.size,
        storageProvider: 'supabase'
      })
    }
    return uploaded
  } catch (error) {
    try { await deleteVerificationFiles(user, role, prepared) }
    catch (_) { throw uploadError('Upload was not confirmed and cleanup failed. Contact Techable support before retrying.') }
    throw error
  }
}
