import {cleanMemberNews} from './member-news.mjs'
export function eligibleProviderMembers(rows,providerUid){
 return rows.filter(r=>r.providerUid===providerUid&&r.status==='approved'&&typeof r.seniorUid==='string'&&r.seniorUid&&typeof r.residentId==='string'&&r.residentId&&r.id===r.seniorUid+'_'+providerUid)
}
export async function sendProviderNews(fs,db,providerUid,campaign,draft){
 const clean=cleanMemberNews(draft,draft.ids)
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(campaign))throw Error('Invalid delivery reference.')
 for(let start=0;start<clean.ids.length;start+=3){
  const ids=clean.ids.slice(start,start+3)
  await fs.runTransaction(db,async tx=>{
   const refs=ids.map(id=>fs.doc(db,'member_announcements','provider-'+providerUid+'-'+campaign+'_'+id))
   // All reads precede writes, and even retries recheck current membership.
   const prior=await Promise.all(refs.map(ref=>tx.get(ref)))
   const connections=await Promise.all(ids.map(id=>tx.get(fs.doc(db,'provider_connections',id))))
   const rows=connections.map((s,i)=>s.exists()?{...s.data(),id:ids[i]}:null)
   if(rows.some(r=>!r||eligibleProviderMembers([r],providerUid).length!==1))throw Error('A selected member is no longer approved. Refresh Members before sending.')
   for(let i=0;i<ids.length;i++){
    const row=rows[i]
    if(prior[i].exists()){
     const old=prior[i].data()
     if(old.authorUid!==providerUid||old.seniorUid!==row.seniorUid||old.residentId!==row.residentId||old.providerConnectionId!==ids[i]||old.title!==clean.title||old.body!==clean.body)throw Error('Delivery reference already used. Refresh to review.')
    }else tx.set(refs[i],{authorUid:providerUid,seniorUid:row.seniorUid,residentId:row.residentId,providerConnectionId:ids[i],title:clean.title,body:clean.body,createdAt:fs.serverTimestamp()})
   }
  })
 }
 return clean.ids.length
}
export function mountProviderComposer(root,{fs,db,user,profile}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
 root.replaceChildren();root.append(el('h3','Announcement to members'),el('p','Choose approved members, review your announcement, then send. It appears under Select Providers → Announcements for you. No email or text message is sent.'))
 if(profile.verificationStatus!=='approved'){root.append(el('p','Your provider account must be verified before sending member announcements.'));return{updateMembers(){},selectOnly(){return false},focus(){}}}
 const form=el('form');form.className='provider-news-form';const group=el('div'),count=el('p'),titleLabel=el('label','Title'),title=el('input'),bodyLabel=el('label','Announcement'),body=el('textarea'),send=el('button','Send to selected members'),status=el('p')
 title.id='provider-news-title';titleLabel.htmlFor=title.id;title.maxLength=120;body.id='provider-news-body';bodyLabel.htmlFor=body.id;body.maxLength=2000;body.rows=4;send.id='provider-news-send';send.type='submit';send.className='verification-link';send.disabled=true;status.id='provider-news-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');count.setAttribute('role','status')
 form.append(group,count,titleLabel,title,bodyLabel,body,send,status);root.append(form)
 let members=[],known=false,selected=new Set(),boxes=[],all,busy=false,pending=null
 function update(){
  const locked=busy||!!pending
  for(const box of boxes)box.disabled=locked||!known
  if(all){all.disabled=locked||!known||!boxes.length;all.checked=boxes.length>0&&boxes.every(b=>b.checked);all.indeterminate=boxes.some(b=>b.checked)&&!all.checked}
  title.disabled=body.disabled=locked;send.disabled=busy||!known||(!pending&&!selected.size);send.textContent=pending?'Retry same announcement':'Send to selected members';count.textContent=known?selected.size+' member(s) selected':'Members could not be confirmed. Refresh Applicants/Members before sending.'
 }
 function recipients(){
  group.replaceChildren();boxes=[];const label=el('label');all=el('input');all.type='checkbox';all.id='provider-news-all';label.append(all,document.createTextNode(' Select all approved members'));group.append(label)
  const rows=pending?.members||members
  for(const m of rows){const label=el('label'),box=el('input');box.type='checkbox';box.className='provider-news-recipient';box.value=m.id;box.checked=selected.has(m.id);label.append(box,document.createTextNode(' '+(m.seniorName||'Senior')));group.append(label);boxes.push(box);box.addEventListener('change',()=>{if(busy||pending||!known)return;if(box.checked)selected.add(m.id);else selected.delete(m.id);update()})}
  all.addEventListener('change',()=>{if(busy||pending||!known)return;selected=new Set(all.checked?rows.map(m=>m.id):[]);boxes.forEach(b=>b.checked=selected.has(b.value));update()})
  if(known&&!rows.length)group.append(el('p','No approved provider members are available yet.'))
  update()
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!known)return
  try{if(!pending){const draft=cleanMemberNews({title:title.value,body:body.value},[...selected]);pending={campaign:crypto.randomUUID(),draft,members:members.filter(m=>selected.has(m.id))}}}catch(error){status.textContent=error.message;return}
  busy=true;update();status.textContent='Sending to selected members…'
  try{const n=await sendProviderNews(fs,db,user.uid,pending.campaign,pending.draft);pending=null;selected.clear();title.value=body.value='';status.textContent='Sent to '+n+' member(s). They can read it under Select Providers → Announcements for you.'}
  catch{status.textContent='Delivery is not fully confirmed. Some members may already have it. Retry this same announcement to finish without duplicates. If membership changed, refresh and review before sending a new announcement.'}
  finally{busy=false;recipients()}
 })
 recipients()
 return{
  updateMembers(rows,confirmed){if(confirmed)members=eligibleProviderMembers(rows,user.uid);known=confirmed;if(confirmed&&!pending)selected=new Set([...selected].filter(id=>members.some(m=>m.id===id)));recipients()},
  selectOnly(id){if(busy||pending||!known||title.value.trim()||body.value.trim()||selected.size||!members.some(m=>m.id===id))return false;selected=new Set([id]);recipients();return true},
  focus(){form.scrollIntoView?.({block:'center'});title.focus?.()}
 }
}
