// Private center-to-member announcements. Public follower news stays separate.
export function eligibleMembers(members,managerUid){
 return members.filter(m=>(m.centreId===managerUid||(m.managerUid===managerUid&&m.connectionId))&&typeof m.ownerUid==='string'&&m.ownerUid&&(!m.status||m.status==='active'))
}
export function cleanMemberNews(input,selected){
 const title=String(input?.title||'').trim(),body=String(input?.body||'').trim(),ids=[...new Set(selected||[])]
 if(!title||title.length>120||!body||body.length>2000)throw Error('Add a title (up to 120 characters) and details (up to 2,000 characters).')
 if(!ids.length||ids.some(id=>typeof id!=='string'||!id||id.includes('/')))throw Error('Select at least one member.')
 return {title,body,ids}
}
export async function sendMemberNews(fs,db,managerUid,campaign,draft){
 const clean=cleanMemberNews(draft,draft.ids)
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(campaign))throw Error('Invalid delivery reference.')
 // Three recipients fit the connection/follow and sender permission checks.
 // Deterministic references let a retry finish partial delivery without duplicates.
 for(let start=0;start<clean.ids.length;start+=3){
  const ids=clean.ids.slice(start,start+3)
  await fs.runTransaction(db,async tx=>{
   const refs=ids.map(id=>fs.doc(db,'member_announcements',campaign+'_'+id))
   const prior=await Promise.all(refs.map(ref=>tx.get(ref)))
   const people=await Promise.all(ids.map((id,i)=>prior[i].exists()?null:tx.get(fs.doc(db,draft.connections?.[id]?'center_connections':'residents',draft.connections?.[id]||id))))
   for(let i=0;i<ids.length;i++){
    if(prior[i].exists()){
     const old=prior[i].data()
     if(old.authorUid!==managerUid||old.residentId!==ids[i]||old.title!==clean.title||old.body!==clean.body)throw Error('Delivery reference already used. Refresh to review.')
     continue
    }
    const connectionId=draft.connections?.[ids[i]],connection=connectionId&&people[i].exists()?people[i].data():null
    if(connectionId&&(!connection||connection.status!=='approved'||connection.managerUid!==managerUid||connection.residentId!==ids[i]))throw Error('A selected connection is no longer approved.')
    const m=connection?{id:ids[i],managerUid,ownerUid:connection.seniorUid,connectionId,status:'active'}:people[i].exists()?{id:ids[i],...people[i].data()}:null
    if(!m||!eligibleMembers([m],managerUid).length)throw Error('A selected member is no longer eligible. No new delivery in this group was sent.')
    tx.set(refs[i],{authorUid:managerUid,residentId:ids[i],seniorUid:m.ownerUid,...(connectionId?{connectionId}:{}),title:clean.title,body:clean.body,createdAt:fs.serverTimestamp()})
   }
  })
 }
 return clean.ids.length
}
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
export function mountMemberComposer(root,{fs,db,user,profile,members}){
 root.replaceChildren();const eligible=eligibleMembers(members,user.uid)
 const note=el('p','Choose members, review your announcement, then send. It appears in their Centers page; no email or text message is sent.');note.className='card-sub';root.append(note)
 if(profile.verificationStatus!=='approved'){root.append(el('p','Your account must be verified before sending member announcements.'));return}
 const excluded=members.length-eligible.length
 if(excluded)root.append(el('p',excluded+' member(s) unavailable: inactive or no personal sign-in.'))
 if(!eligible.length){root.append(el('p','No active members with a personal sign-in are available.'));return}
 const form=el('form');form.className='tn-form';const allLabel=el('label'),all=el('input');all.type='checkbox';all.style.width='auto';all.id='member-news-all';allLabel.append(all,document.createTextNode(' Select all available members'));form.append(allLabel)
 const boxes=eligible.map(m=>{const label=el('label'),box=el('input');box.type='checkbox';box.style.width='auto';box.value=m.id;box.className='member-news-recipient';label.append(box,document.createTextNode(' '+(m.preferredName||m.name||'Unnamed member')));form.append(label);return box})
 const count=el('p','0 members selected');count.setAttribute('role','status');form.append(count)
 function update(){const n=boxes.filter(b=>b.checked).length;all.checked=n===boxes.length;all.indeterminate=n>0&&n<boxes.length;count.textContent=n+' member(s) selected';send.disabled=!n}
 all.addEventListener('change',()=>{boxes.forEach(b=>b.checked=all.checked);update()});boxes.forEach(b=>b.addEventListener('change',update))
 const field=(label,id,max,tag)=>{const wrap=el('label',label),input=el(tag);input.id=id;input.maxLength=max;wrap.htmlFor=id;wrap.append(input);form.append(wrap);return input}
 const title=field('Title','member-news-title',120,'input'),body=field('Announcement','member-news-body',2000,'textarea')
 const send=el('button','Send to selected members');send.type='submit';send.className='tn-post';send.disabled=true;form.append(send)
 const status=el('p');status.id='member-news-status';status.setAttribute('role','status');form.append(status);root.append(form)
 let pending=null,busy=false
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return
  try{if(!pending){const draft=cleanMemberNews({title:title.value,body:body.value},boxes.filter(b=>b.checked).map(b=>b.value));draft.connections=Object.fromEntries(eligible.filter(m=>draft.ids.includes(m.id)&&m.connectionId).map(m=>[m.id,m.connectionId]));pending={campaign:crypto.randomUUID(),draft}}}
  catch(error){status.textContent=error.message;return}
  busy=true;[all,...boxes,title,body,send].forEach(n=>n.disabled=true);status.textContent='Sending to the selected members…'
  try{
   const n=await sendMemberNews(fs,db,user.uid,pending.campaign,pending.draft)
   status.textContent='Sent to '+n+' member(s). They can read it on their Centers page.';pending=null;title.value=body.value='';boxes.forEach(b=>b.checked=false);[all,...boxes,title,body].forEach(n=>n.disabled=false);send.textContent='Send to selected members';update()
  }catch{status.textContent='Delivery is not fully confirmed. Some members may already have it. Retry this same announcement to finish without duplicates. If it still fails, refresh and review with your center administrator.';send.disabled=false;send.textContent='Retry same announcement'}
  finally{busy=false}
 })
 return {selectOnly(id){
  if(busy||pending||title.value?.trim()||body.value?.trim()||boxes.some(b=>b.checked))return false
  const selected=boxes.find(b=>b.value===id);if(!selected)return false
  boxes.forEach(b=>b.checked=b===selected);update();form.scrollIntoView?.({block:'center'});title.focus?.();return true
 }}
}
export async function mountMemberInbox(root,{fs,db,user,providerOnly=false}){
 const heading=providerOnly?'Provider announcements for you':'Announcements for you'
 root.replaceChildren(el('h2',heading),el('p','Loading your member announcements…'))
 try{
  const snap=await fs.getDocs(fs.query(fs.collection(db,'member_announcements'),fs.where('seniorUid','==',user.uid),fs.orderBy('createdAt','desc'),fs.limit(40)))
  if(snap.metadata?.fromCache)throw Error('Unconfirmed cached result')
  root.replaceChildren(el('h2',heading));let count=0
  snap.forEach(d=>{const data=d.data();if(providerOnly&&!data.providerConnectionId)return;count++;const card=el('article');card.className='news-item';card.append(el('h3',data.title),el('p',data.providerConnectionId?'From your service provider':'From your center team'),el('p',data.body));root.append(card)})
  if(!count)root.append(el('p','No member announcements in the latest 40 deliveries.'))
 }catch{root.replaceChildren(el('h2',heading),el('p','Member announcements could not be loaded. Refresh to try again.'))}
}
