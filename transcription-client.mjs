export async function transcribeAudio(blob,signal){
 const user=window.TechableAuth?.currentUser
 if(!user)throw Error('Please sign in before using voice input.')
 const token=await user.getIdToken()
 const response=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':blob.type,Authorization:'Bearer '+token},body:blob,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)})
 const result=await response.json()
 if(!response.ok)throw Error(result.error||'Could not transcribe this recording.')
 return result.text
}
