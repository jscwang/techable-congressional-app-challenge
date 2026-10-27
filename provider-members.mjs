import {providerMembershipRows,reviewProviderMembership} from './provider-memberships.mjs'
import {createPersonDetails,loadPersonRecord} from './person-details.mjs'
import {mountProviderComposer} from './provider-news.mjs'
export function mountProviderMembers(root,{fs,db,user,profile}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
 const button=(label,fn)=>{const b=el('button',label);b.type='button';b.className='verification-link';b.addEventListener('click',fn);return b}
 root.replaceChildren();const listRoot=el('div'),composerRoot=el('section');root.append(listRoot,composerRoot)
 const details=createPersonDetails(),composer=mountProviderComposer(composerRoot,{fs,db,user,profile})
 let rows=[],known=false,busy=false,selected='pending',generation=0
 function render(){
  const root=listRoot
  root.replaceChildren();root.append(el('h2','Applicants and Members'),el('p','Review people who chose to apply to your services. Membership shares their name and application only. Assigned care profiles remain separate below.'))
  const bar=el('div');bar.style.cssText='display:flex;gap:12px;flex-wrap:wrap;margin:16px 0'
  for(const [status,title]of [['pending','Applicants'],['approved','Members']]){const b=button(title+(known?' ('+providerMembershipRows(rows,user.uid,status).length+')':''),()=>{selected=status;render()});b.setAttribute('aria-pressed',String(selected===status));bar.append(b)}
  bar.append(button('Refresh applicants and members',()=>void load()));root.append(bar)
  if(profile.verificationStatus!=='approved'){root.append(el('p','Your provider account needs Techable verification before you can review applicants.'));return}
  if(!known){root.append(el('p','Applicants and members could not be confirmed yet. Refresh to retry.'));return}
  const list=providerMembershipRows(rows,user.uid,selected);if(!list.length)root.append(el('p',selected==='pending'?'No pending applicants.':'No approved members yet.'))
  for(const item of list){const card=el('article');card.style.cssText='padding:16px 0;border-bottom:1px solid #ddd'
   const name=button(item.seniorName||'Senior',()=>void details.open({kind:'provider-connection',managerUid:user.uid,opener:name,fallback:()=>listRoot.querySelector('button'),load:()=>loadPersonRecord({fs,db,collection:'provider_connections',id:item.id}),review:async(_row,decision)=>{await reviewProviderMembership(fs,db,user.uid,item.id,decision);await load()},onAnnounce:row=>composer.selectOnly(row.id),afterAnnounce:()=>composer.focus()}));name.className='person-link';name.setAttribute('aria-label','View '+(selected==='pending'?'applicant':'member')+' details for '+(item.seniorName||'Senior'));name.disabled=busy
   const heading=el('h3');heading.append(name);card.append(heading,el('p',selected==='pending'?'Application awaiting your review.':'Approved provider member. Private care records are not shared by this membership.'))
   if(selected==='pending')for(const [decision,title]of [['approved','Approve'],['declined','Decline']]){const b=button(title+' '+(item.seniorName||'applicant'),async()=>{if(busy)return;busy=true;render();try{await reviewProviderMembership(fs,db,user.uid,item.id,decision);await load()}catch(error){known=false;composer.updateMembers([],false);render();root.append(el('p',error.message||'Could not confirm review. Refresh before retrying.'))}finally{busy=false;render()}});b.disabled=busy;card.append(b)}root.append(card)}
 }
 async function load(){const at=++generation;known=false;composer.updateMembers([],false);render();try{const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'provider_connections'),fs.where('providerUid','==',user.uid)));if(at!==generation)return;if(snap.metadata.fromCache||snap.metadata.hasPendingWrites)throw Error('Not confirmed');rows=snap.docs.map(d=>({...d.data(),id:d.id}));known=true}catch{if(at!==generation)return;known=false}composer.updateMembers(rows,known);render()}
 render();if(profile.verificationStatus==='approved')void load()
 return{reload:load}
}
