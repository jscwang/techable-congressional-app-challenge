import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {canChat,cleanChatMessage,mergeChatMessages,sendChatMessage} from './family-chat-model.mjs'
import {bindDictation} from './field-dictation.mjs'
const $=id=>document.getElementById(id),drafts=new Map()
let db,user,senior=false,connections=[],current=null,version=0,busy=false,pending=null
const voice=bindDictation({button:$('dictate'),input:$('message'),status:$('dictation-status'),context:()=>current?.key||''})
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
function status(text=''){$('status').textContent=text}
function lock(on){$('connection').disabled=on;$('refresh').disabled=on;$('message').readOnly=on;$('dictate').disabled=on;$('send').disabled=on}
async function currentResident(){const snap=await fs.getDocFromServer(fs.doc(db,'residents',current.residentId));if(!snap.exists())throw Error('missing');return{id:snap.id,...snap.data()}}
async function showThread(){
 const at=++version;voice.cancel();$('composer').hidden=true;$('permission').replaceChildren();$('thread').replaceChildren(el('p','Loading conversation…'));if(!current){$('thread').replaceChildren(el('p','Choose an approved connection to chat.'));return}
 const target=current
 try{
  const [resident,linkSnap]=await Promise.all([currentResident(),fs.getDocFromServer(fs.doc(db,'family_links',target.familyUid+'_'+target.residentId))]);if(at!==version)return
  const link=linkSnap.exists()?linkSnap.data():null
  if(!canChat(link,resident)){
   $('thread').replaceChildren(el('p','Chat is unavailable until the family connection is approved and the senior allows messages.'))
   if(senior&&link?.status==='active'&&resident.ownerUid===user.uid&&!(resident.messageBlocked||[]).includes(target.familyUid)){
    const allow=el('button','Allow '+target.name+' to chat with me');allow.type='button';allow.className='primary';allow.addEventListener('click',async()=>{if(busy)return;busy=true;lock(true);allow.disabled=true;try{await fs.updateDoc(fs.doc(db,'residents',target.residentId),{messageFrom:fs.arrayUnion(target.familyUid)});status('Messages allowed for this connection.');await showThread()}catch{status('Could not confirm permission. Refresh to check before retrying.')}finally{busy=false;lock(false)}});$('permission').append(el('p','Allow this person only if you recognize them. This lets them exchange private messages with you.'),allow)
   }
   return
  }
  const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'family_chat'),fs.where('residentId','==',target.residentId),fs.where('seniorUid','==',target.seniorUid),fs.where('familyUid','==',target.familyUid),fs.orderBy('createdAt','desc'),fs.limit(80)))
  if(at!==version)return
  const rows=mergeChatMessages(snap.docs.map(d=>({id:d.id,...d.data()}))),root=$('thread');root.replaceChildren()
  if(!rows.length)root.append(el('p','No messages yet. Start with a hello.'))
  for(const row of rows){const card=el('article');if(row.senderUid===user.uid)card.className='mine';card.append(el('strong',row.senderUid===user.uid?'You':target.name),el('p',row.text));if(row.createdAt?.toDate)card.append(el('small',row.createdAt.toDate().toLocaleString()));root.append(card)}
  $('composer').hidden=false;root.scrollTop=root.scrollHeight
 }catch{if(at===version){$('thread').replaceChildren(el('p','Conversation could not be loaded. The connection may have changed. Refresh to retry.'));status('Could not refresh the conversation. Previously confirmed messages remain saved.')}}
}
async function loadConnections(){
 const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'family_links'),fs.where(senior?'seniorUid':'familyUid','==',user.uid))),rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(l=>l.status==='active')
 const out=[]
 for(const link of rows){try{const resident=await fs.getDocFromServer(fs.doc(db,'residents',link.residentId));if(!resident.exists()||!resident.data().ownerUid)continue;out.push({...link,seniorUid:resident.data().ownerUid,name:senior?(link.familyName||'Family member'):(resident.data().preferredName||resident.data().name||'Senior'),key:link.familyUid+'_'+link.residentId})}catch{status('Some connections could not be loaded. Refresh before sending to anyone missing.')}}
 connections=out;const select=$('connection');select.replaceChildren()
 if(!out.length){version++;voice.cancel();$('permission').replaceChildren();const option=el('option','No approved connections yet');option.value='';select.append(option);$('thread').replaceChildren(el('p',senior?'Approve a family request on your app’s Family screen first.':'Use Link accounts in your family dashboard and wait for approval. Existing legacy links can still use dashboard notes.'));$('composer').hidden=true;current=null;return}
 out.forEach(c=>{const option=el('option',c.name);option.value=c.key;select.append(option)});const old=current?.key;current=out.find(c=>c.key===old)||out[0];select.value=current.key;$('message').value=drafts.get(current.key)||'';await showThread()
}
$('connection').addEventListener('change',()=>{if(busy||pending)return;status('');if(current)drafts.set(current.key,$('message').value);voice.cancel();current=connections.find(c=>c.key===$('connection').value)||null;$('message').value=drafts.get(current?.key)||'';void showThread()})
$('refresh').addEventListener('click',async()=>{if(busy||pending)return;status('');if(current)drafts.set(current.key,$('message').value);voice.cancel();busy=true;lock(true);try{await loadConnections()}catch{status('Connections could not be refreshed. Please reload the page.')}finally{busy=false;lock(false)}})
$('composer').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||!current)return
 try{if(!pending)pending={id:crypto.randomUUID(),target:{...current},text:cleanChatMessage(current,user.uid,$('message').value).text}}catch(error){status(error.message);return}
 voice.cancel();busy=true;lock(true);status('Sending your reviewed message…')
 try{
  await sendChatMessage(fs,db,pending.id,pending.target,user.uid,pending.text);drafts.delete(pending.target.key);$('message').value='';pending=null;status('Message sent. Refresh the chat to see new replies.');$('send').textContent='Send message';await showThread()
 }catch{status('Sending could not be confirmed. Your draft is retained. Retry the same message to avoid duplicates. If the connection was removed, reload to check it.');$('send').textContent='Retry same message'}
 finally{busy=false;if(pending)$('send').disabled=false;else lock(false)}
})
window.TechableAuth.guardRole(['family','resident'],async(u,role)=>{user=u;db=window.TechableAuth.db;senior=role==='resident';$('back').href=senior?'app.html':'family-dashboard.html';$('back').textContent=senior?'Back to your app':'Back to family dashboard';busy=true;lock(true);try{await loadConnections()}catch{status('Connections could not be loaded. Please refresh.');$('thread').replaceChildren();$('composer').hidden=true}finally{busy=false;lock(false)}})
