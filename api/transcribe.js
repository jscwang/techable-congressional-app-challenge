// Authenticated audio upload. Vercel must leave the recording as a raw stream.
import {guard} from './_guard.js'
import {openaiKey} from './_openai.js'
export const config={api:{bodyParser:false}}
export function createTranscriptionHandler({key=openaiKey,firebaseKey=()=>process.env.FIREBASE_API_KEY||'',fetchImpl=fetch,timeoutMs=25000,maxBytes=2*1024*1024}={}){
 let active=0
 return async(req,res)=>{
  if(guard(req,res,'GET, POST, OPTIONS'))return
  if(req.method==='GET')return res.status(200).json({enabled:Boolean(key()&&firebaseKey()),model:'gpt-transcribe'})
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'})
  const token=/^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization||''))?.[1]
  if(!token)return res.status(401).json({error:'Please sign in before using voice input.'})
  if(!key()||!firebaseKey())return res.status(503).json({error:'Voice input is not configured. You can still type.'})
  const mime=String(req.headers?.['content-type']||'').split(';')[0].trim()
  const extension={'audio/webm':'webm','audio/mp4':'mp4','audio/ogg':'ogg'}[mime]
  if(!extension)return res.status(415).json({error:'Unsupported recording format.'})
  if(active>=3)return res.status(429).json({error:'Voice input is busy. Please try again shortly.'})
  active++;const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs)
  const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true}))])
  try{
   const auth=await bounded(fetchImpl('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(firebaseKey()),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:token}),signal:controller.signal,redirect:'error'}))
   const identity=await bounded(auth.json());const user=identity?.users?.[0]
   if(!auth.ok||!user?.localId||user.disabled)return res.status(401).json({error:'Your sign-in has expired. Please sign in again.'})
   let size=0
   const chunks=await bounded((async()=>{const parts=[];for await(const chunk of req){if(controller.signal.aborted)throw Error('timeout');size+=chunk.length;if(size>maxBytes)throw Object.assign(Error('size'),{status:413});parts.push(Buffer.from(chunk))}return parts})())
   if(!size)return res.status(400).json({error:'The recording was empty. Please try again.'})
   const form=new FormData();form.set('file',new Blob(chunks,{type:mime}),'answer.'+extension);form.set('model','gpt-transcribe')
   const upstream=await bounded(fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+key()},body:form,signal:controller.signal,redirect:'error'}))
   if(!upstream.ok)return res.status(upstream.status===429?429:502).json({error:upstream.status===429?'Speech service quota reached. You can still type.':'Speech service is unavailable. Please try again or type.'})
   const data=await bounded(upstream.json())
   if(typeof data.text!=='string')return res.status(502).json({error:'No transcript was returned. Please try again.'})
   return res.status(200).json({text:data.text.trim().slice(0,8000)})
  }catch(error){return res.status(controller.signal.aborted?504:error.status===413?413:502).json({error:controller.signal.aborted?'Voice input timed out. Please try again or type.':error.status===413?'The recording was too large. Please record a shorter answer.':'Could not transcribe this recording. Please try again or type.'})}
  finally{clearTimeout(timer);active--}
 }
}
export default createTranscriptionHandler()
