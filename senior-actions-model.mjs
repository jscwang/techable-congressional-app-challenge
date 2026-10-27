export function cleanBlogDraft(d){
 const title=String(d?.title||'').trim(),text=String(d?.text||'').trim(),id=String(d?.id||'')
 return !title||title.length>120||!text||text.length>4000||id.length>80?null:{title,text,id}
}
export function blogEntries(entries){return (Array.isArray(entries)?entries:[]).filter(e=>String(e.prompt||'').startsWith('Blog: ')).map(e=>({...e,title:e.prompt.slice(6)})).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))}
export function spokenField(field,text){
 if(!['email','first-name','last-name'].includes(field))return null
 let value=String(text||'').trim().replace(/[.,!?]+$/,'')
 if(field==='email')value=value.toLowerCase().replace(/\bat\b/g,'@').replace(/\bdot\b/g,'.').replace(/\bunderscore\b/g,'_').replace(/\b(?:hyphen|dash)\b/g,'-').replace(/\s+/g,'')
 return value
}
export function mergeDictation({baseline,current,text,context,currentContext}){
 if(current!==baseline||context!==currentContext||!String(text||'').trim())return null
 return (baseline.trim()?baseline.trim()+' ':'')+String(text).trim()
}
export function createProviderConnections({fs,db,user,timeoutMs=20000}){
 const state={providers:[],connected:new Set(),known:false,busy:new Set()}
 const ref=id=>fs.doc(db,'provider_follows',user.uid+'_'+id)
 async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Refresh to confirm this change.')),timeoutMs)})])}finally{clearTimeout(timer)}}
 async function read(q){const s=await (fs.getDocsFromServer||fs.getDocs)(q);if(s.metadata?.fromCache||s.metadata?.hasPendingWrites)throw Error('Refresh to confirm with the server.');return s.docs}
 async function load(){state.known=false;const [p,f]=await bounded(Promise.all([read(fs.query(fs.collection(db,'provider_directory'))),read(fs.query(fs.collection(db,'provider_follows'),fs.where('uid','==',user.uid)))]));state.providers=p.map(d=>({id:d.id,...d.data()}));state.connected=new Set(f.map(d=>d.data().providerUid));state.known=true;return state}
 async function change(id,on){
  if(!state.known)throw Error('Refresh your provider connections first.')
  if(!state.providers.some(p=>p.id===id))throw Error('This provider is unavailable.')
  if(state.busy.has(id))throw Error('Please wait for the current change.')
  if(state.connected.has(id)===on)return
  state.busy.add(id)
  try{if(on)await bounded(fs.setDoc(ref(id),{uid:user.uid,providerUid:id,createdAt:fs.serverTimestamp()}));else await bounded(fs.deleteDoc(ref(id)));if(on)state.connected.add(id);else state.connected.delete(id)}catch(e){state.known=false;throw e}finally{state.busy.delete(id)}
 }
 return {state,load,connect:id=>change(id,true),disconnect:id=>change(id,false)}
}
