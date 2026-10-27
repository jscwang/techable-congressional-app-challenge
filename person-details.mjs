// Explicit projections: never render a raw Firestore document in a detail view.
function text(value){return typeof value==='string'||typeof value==='number'?String(value):''}
function date(value){try{const d=value?.toDate?.()||new Date(value);return Number.isNaN(d.getTime())?'':d.toLocaleString()}catch{return ''}}
export async function loadPersonRecord({fs,db,collection,id,timeoutMs=10000}){
 let timer;try{const snap=await Promise.race([fs.getDocFromServer(fs.doc(db,collection,id)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Unavailable')),timeoutMs)})]);if(!snap.exists()||snap.metadata?.fromCache||snap.metadata?.hasPendingWrites)throw Error('Unavailable');return{...snap.data(),id:snap.id}}finally{clearTimeout(timer)}
}
export function personDetails(kind,row,managerUid){
 if(!row||!managerUid||!['connection','care-request','member','registration','provider-connection'].includes(kind))throw Error('Unavailable')
 const provider=kind==='provider-connection',limited=provider||kind==='connection'||kind==='care-request',owner=provider?row.providerUid:limited?row.managerUid:row.centreId
 if(owner!==managerUid)throw Error('Unavailable')
 const status=text(row.status||'active'),name=text(limited?row.seniorName:row.preferredName||row.name)||'Senior'
 const rows=[['Name',name],['Center',text(row.communityName)],['Status',status],['Requested',date(row.createdAt)],['Reviewed',date(row.reviewedAt)]]
 if(!limited){const details=row.myDetails||{};rows.push(['Age',text(row.age)],['Room',text(row.room)],['Phone',text(kind==='registration'?row.phone:details.phone)],['Email',text(kind==='registration'?row.email:details.email)]);if(kind==='registration')rows.push(['Address',text(row.address)],['Emergency contact',text(row.emergencyName)],['Emergency phone',text(row.emergencyPhone)])}
 const notice=provider?'Only the name and application details shared with this provider are shown. Approval and announcements do not grant access to private profiles, health records, chat history or memories.':kind==='connection'?'Only the name and connection details shared with this center are shown. Approval does not provide access to private profiles, health records, chat history or memories.':kind==='care-request'?'This is a care-center membership request. Approval gives this center access to the senior’s profile, memories, life story, forms, chat summaries and check-ins.':kind==='registration'?'These details were submitted on this center’s registration form. Approval adds a roster record; it does not create a sign-in account.':'Basic details from the member record your center is permitted to access. Medical information and conversation content are not shown here.'
 return {title:name,rows:rows.filter(([,v])=>v!==''),notice,canReview:kind!=='member'&&status==='pending',canAnnounce:provider?status==='approved'&&!!row.seniorUid:kind==='connection'?status==='approved'&&!!row.seniorUid:kind==='member'&&status==='active'&&!!row.ownerUid}
}
export function createPersonDetails({document:d=globalThis.document}={}){
 const el=(tag,value)=>{const n=d.createElement(tag);if(value!==undefined)n.textContent=value;return n},dialog=el('dialog'),title=el('h2'),notice=el('p'),body=el('dl'),actions=el('div'),status=el('p'),closeButton=el('button','Close')
 dialog.id='techable-person-details';title.id='person-details-title';dialog.setAttribute('aria-labelledby',title.id);notice.id='person-details-notice';dialog.setAttribute('aria-describedby',notice.id);status.setAttribute('role','status');status.setAttribute('aria-live','polite');closeButton.type='button';closeButton.className='btn btn-secondary'
 const style=el('style','#techable-person-details{width:calc(100% - 32px);max-width:640px;margin:auto;max-height:85dvh;overflow:auto;border:1px solid #bfcfc8;border-radius:18px;padding:24px;background:var(--cream,#faf6f0);color:var(--ink,#173443);font:inherit}#techable-person-details::backdrop{background:#0d1b2a88}#techable-person-details h2{margin:0 0 14px;font-size:26px}#techable-person-details p{line-height:1.6}#techable-person-details dl>div{display:grid;grid-template-columns:minmax(90px,1fr) 2fr;gap:14px;padding:10px 0;border-bottom:1px solid #ccd8d1}#techable-person-details dt{font-weight:600}#techable-person-details dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}#techable-person-details button{min-height:44px;padding:10px 16px;margin:8px 8px 0 0;border-radius:10px;cursor:pointer}.person-link{background:none;border:0;color:var(--green2,#26694f);text-decoration:underline;text-align:left;font:inherit;min-height:44px;padding:8px 0;cursor:pointer}')
 ;(d.head||d.body).append(style);dialog.append(title,notice,body,actions,status,closeButton);d.body.append(dialog)
 let spec=null,generation=0,busy=false,opener=null
 function button(label,fn){const b=el('button',label);b.type='button';b.className='btn btn-primary';b.addEventListener('click',fn);actions.append(b);return b}
 function close(){if(busy)return false;generation++;dialog.close();body.replaceChildren();actions.replaceChildren();title.textContent='';notice.textContent='';status.textContent='';const focus=opener?.isConnected?opener:spec?.fallback?.();spec=null;focus?.focus?.();return true}
 closeButton.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close()})
 function failure(){body.replaceChildren();actions.replaceChildren();status.textContent='Details or access changed. Reload details before trying again.';button('Reload details',()=>refresh())}
 async function refresh(message=''){
  const at=++generation,config=spec;body.replaceChildren();actions.replaceChildren();notice.textContent='';title.textContent='Loading details…';status.textContent=''
  try{const row=await config.load();if(at!==generation||!spec)return;const view=personDetails(config.kind,row,config.managerUid);title.textContent=view.title;notice.textContent=view.notice;for(const [label,value]of view.rows){const group=el('div');group.append(el('dt',label),el('dd',value));body.append(group)}status.textContent=message
   if(view.canReview&&config.review)for(const [decision,label]of [['approved','Approve'],['declined','Decline']])button(label,()=>review(decision))
   if(view.canAnnounce&&config.onAnnounce)button('Write announcement to this member',()=>announce())
  }catch{if(at===generation&&spec)failure()}
 }
 async function review(decision){
  if(busy)return;busy=true;closeButton.disabled=true;const at=generation,config=spec;actions.replaceChildren();status.textContent='Saving decision…'
  try{const fresh=await config.load();if(!personDetails(config.kind,fresh,config.managerUid).canReview)throw Error('Changed');await config.review(fresh,decision);if(at===generation)await refresh('Decision saved.')}
  catch{if(at===generation&&spec)failure()}
  finally{busy=false;closeButton.disabled=false}
 }
 async function announce(){
  if(busy)return;const at=generation,config=spec
  try{const row=await config.load();if(at!==generation||!personDetails(config.kind,row,config.managerUid).canAnnounce)throw Error('Changed');const selected=await config.onAnnounce(row);if(at!==generation)return;if(selected){close();config.afterAnnounce?.()}else status.textContent='Your current announcement draft or recipients were kept. Finish or clear that draft, then try again.'}
  catch{if(at===generation&&spec)failure()}
 }
 return {close,async open(config){if(busy)return false;spec=config;opener=config.opener||d.activeElement;if(!dialog.open)dialog.showModal();closeButton.focus();await refresh();return true}}
}
