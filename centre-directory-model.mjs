// Directory connections share news/attendance, never care-profile access.
import {requestConnection,withdrawConnection} from './center-connections.mjs'
export const dayKey=date=>[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-')
export const attendanceKey=(center,resident,date)=>`${String(center).replace(/[^a-zA-Z0-9_-]/g,'_')}_${String(resident).replace(/[^a-zA-Z0-9_-]/g,'_')}_${dayKey(date)}`
export function voiceIntent(value){
  const text=String(value||'').toLowerCase().replace(/[.!?,]/g,'').replace(/\s+/g,' ').trim()
  return /^(?:(?:please )?(?:sign|check)(?:(?: me)? in| in me)(?: please)?|i (?:would like|want) to (?:sign|check)(?: me)? in)$/.test(text)?'sign-in':null
}
export function createDirectory({fs,db,user,clock=()=>new Date(),timeoutMs=20000}){
  const state={centers:[],connected:new Set(),applications:new Map(),resident:null,known:false,busy:new Set()}
  const ref=(col,id)=>fs.doc(db,col,id)
  const confirmed=snapshot=>{if(snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)throw Error('Reload to confirm your connection with the server.');return snapshot}
  const serverDocs=async q=>confirmed(await (fs.getDocsFromServer||fs.getDocs)(q))
  const serverDoc=async r=>confirmed(await (fs.getDocFromServer||fs.getDoc)(r))
  async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Could not confirm the change. Reload to check your connection.')),timeoutMs)})])}finally{clearTimeout(timer)}}
  function center(id){const c=state.centers.find(c=>c.id===id);if(!c)throw Error('This center is unavailable.');return c}
  function known(){if(!state.known)throw Error('Reload to check your center connections first.')}
  function connected(id){known();if(!state.connected.has(id))throw Error('Connect to this center first.')}
  async function exclusive(id,fn){if(state.busy.has(id))throw Error('Please wait for the current change.');state.busy.add(id);try{return await fn()}finally{state.busy.delete(id)}}
  async function load(){
    state.known=false
    const [centers,follows,residents,applications]=await bounded(Promise.all([
      serverDocs(fs.query(fs.collection(db,'communities'),fs.where('isPublic','==',true))),
      serverDocs(fs.query(fs.collection(db,'follows'),fs.where('uid','==',user.uid))),
      serverDocs(fs.query(fs.collection(db,'residents'),fs.where('ownerUid','==',user.uid))),
      serverDocs(fs.query(fs.collection(db,'center_connections'),fs.where('seniorUid','==',user.uid)))
    ]))
    state.centers=centers.docs.map(d=>({id:d.id,...d.data()})).filter(c=>c.isPublic&&c.verified&&c.managerUid).sort((a,b)=>(a.directoryOrder??99)-(b.directoryOrder??99)||String(a.name).localeCompare(String(b.name)))
    state.connected=new Set(follows.docs.map(d=>d.data().communityId))
    state.applications=new Map(applications.docs.map(d=>[d.data().communityId,{id:d.id,...d.data()}]))
    const rows=residents.docs.map(d=>({id:d.id,...d.data()})).filter(r=>r.ownerUid===user.uid)
    rows.sort((a,b)=>String(a.createdAt?.toDate?.()?.toISOString?.()||a.createdAt||'').localeCompare(String(b.createdAt?.toDate?.()?.toISOString?.()||b.createdAt||''))||a.id.localeCompare(b.id))
    state.resident=rows[0]||null;state.known=true;return state
  }
  async function connect(id,{consented=false}={}){return exclusive(id,async()=>{
    known();const c=center(id)
    try{const application=await bounded(requestConnection(fs,db,{user,resident:state.resident,center:c,following:state.connected.has(id),existing:state.applications.get(id),consented}));state.connected.add(id);state.applications.set(id,application)}catch(error){state.known=false;throw error}
  })}
  async function disconnect(id){return exclusive(id,async()=>{
    known();const c=center(id);if(!state.connected.has(id)&&!state.applications.has(id))return
    try{await bounded(withdrawConnection(fs,db,{user,center:c,following:state.connected.has(id),existing:state.applications.has(id)}));state.connected.delete(id);state.applications.delete(id)}catch(error){state.known=false;throw error}
  })}
  async function attendanceStatus(id){center(id);if(!state.resident)return null;const snap=await bounded(serverDoc(ref('attendance',attendanceKey(id,state.resident.id,clock()))));return snap.exists()?snap.data():null}
  async function signIn(id,method){return exclusive(id,async()=>{
    connected(id);center(id)
    if(!['centre_button','centre_voice'].includes(method))throw Error('Choose a sign-in method.')
    const resident=state.resident;if(!resident)throw Error('Open your companion to finish setting up your profile first.')
    const date=clock(),key=attendanceKey(id,resident.id,date),record=ref('attendance',key)
    return bounded(fs.runTransaction(db,async tx=>{
      const [c,f,r,existing]=await Promise.all([tx.get(ref('communities',id)),tx.get(ref('follows',user.uid+'_'+id)),tx.get(ref('residents',resident.id)),tx.get(record)])
      const data=c.data()
      if(!c.exists()||!data.isPublic||!data.verified||!data.managerUid)throw Error('This center is unavailable.')
      if(!f.exists()||f.data().uid!==user.uid||f.data().communityId!==id)throw Error('Connect to this center first.')
      if(!r.exists()||r.data().ownerUid!==user.uid)throw Error('Your senior profile could not be verified.')
      if(existing.exists())return {already:true,id:key}
      tx.set(record,{communityId:id,communityName:String(data.name||'').slice(0,200),managerUid:data.managerUid,residentId:resident.id,residentName:String(r.data().name||r.data().preferredName||'Senior').slice(0,200),ownerUid:user.uid,day:dayKey(date),method,checkedInAt:fs.serverTimestamp()})
      return {already:false,id:key}
    }))
  })}
  async function news(id){
    connected(id);center(id)
    const snap=await bounded(serverDocs(fs.query(fs.collection(db,'announcements'),fs.where('communityId','==',id),fs.orderBy('createdAt','desc'),fs.limit(50))))
    return snap.docs.map(d=>({id:d.id,...d.data()}))
  }
  return {state,load,connect,disconnect,attendanceStatus,signIn,news}
}
