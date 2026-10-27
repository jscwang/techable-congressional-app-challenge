import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {draftContribution,submitContribution,reviewContribution,prepareContributionPhoto} from './family-contributions-model.mjs'
import {prepareVideo,submitVideo,loadVideo,deleteContribution} from './family-video.mjs'
import {canChat} from './family-chat-model.mjs'
const $=id=>document.getElementById(id)
let video=null,videoVersion=0,videoBusy=false;const playback=new Set()
let db,user,senior=false,connections=[],photo='',photoVersion=0,photoBusy=false,busy=false,pending=null
function el(tag,text){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
function status(text=''){$('status').textContent=text}
function lock(on){for(const node of document.querySelectorAll('button,input,textarea,select'))node.disabled=on}
function clearPhoto(){photoVersion++;photoBusy=false;photo='';$('photo').value='';$('photo-preview').hidden=true;$('photo-preview').removeAttribute('src');$('remove-photo').hidden=true;$('photo-status').textContent='';$('submit').disabled=false}
function stopPlayback(){for(const {player,url}of playback){player.pause();player.removeAttribute('src');player.load();URL.revokeObjectURL(url)}playback.clear()}
function clearVideo(){videoVersion++;videoBusy=false;video=null;$('video').value='';$('video-preview').pause();if($('video-preview').src?.startsWith('blob:'))URL.revokeObjectURL($('video-preview').src);$('video-preview').removeAttribute('src');$('video-preview').load();$('video-preview').hidden=true;$('remove-video').hidden=true;$('video-status').textContent='';$('submit').disabled=photoBusy||videoBusy}
$('remove-video').addEventListener('click',clearVideo)
$('video').addEventListener('change',async()=>{
 const file=$('video').files[0];clearVideo();clearPhoto();if(!file)return;const at=videoVersion;videoBusy=true;$('submit').disabled=true;$('video-status').textContent='Checking the clip size, format and duration…'
 try{const prepared=await prepareVideo(file);if(at!==videoVersion)return;video=prepared;$('video-preview').src=URL.createObjectURL(new Blob([file],{type:file.type}));$('video-preview').hidden=false;$('remove-video').hidden=false;$('video-status').textContent='Video ready. Watch it and review the caption before sending.'}catch(error){if(at===videoVersion)$('video-status').textContent=error.message}finally{if(at===videoVersion){videoBusy=false;$('submit').disabled=false}}
})
window.addEventListener('pagehide',()=>{stopPlayback();clearVideo()})
document.addEventListener('visibilitychange',()=>{if(document.hidden){for(const {player}of playback)player.pause();$('video-preview').pause()}})
$('remove-photo').addEventListener('click',clearPhoto)
$('photo').addEventListener('change',async()=>{
 const file=$('photo').files[0];clearPhoto();clearVideo();if(!file)return;const at=photoVersion;photoBusy=true;$('submit').disabled=true;$('photo-status').textContent='Preparing a private, reduced-size photo…'
 try{const result=await prepareContributionPhoto(file);if(at!==photoVersion)return;photo=result;$('photo-preview').src=result;$('photo-preview').hidden=false;$('remove-photo').hidden=false;$('photo-status').textContent='Photo ready. Review its caption before sending.'}catch(error){if(at===photoVersion)$('photo-status').textContent=error.message}finally{if(at===photoVersion){photoBusy=false;$('submit').disabled=false}}
})
async function refresh(){
 stopPlayback()
 const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'family_contributions'),fs.where(senior?'seniorUid':'familyUid','==',user.uid),fs.orderBy('createdAt','desc'),fs.limit(20)))
 const root=$('items');root.replaceChildren();if(!snap.size)root.append(el('p','No contributions yet.'))
 for(const doc of snap.docs){const item={id:doc.id,...doc.data()},card=el('article');card.append(el('h3',(item.kind==='video'?'Video & caption':item.kind==='photo'?'Photo & caption':'Story')+' — '+item.status),el('p',senior?'Shared by '+(connections.find(c=>c.familyUid===item.familyUid&&c.residentId===item.residentId)?.familyName||'your family connection'):'For '+(connections.find(c=>c.residentId===item.residentId)?.name||'your previous senior connection')),el('p',item.text))
  if(item.createdAt?.toDate)card.append(el('small',item.createdAt.toDate().toLocaleString()))
  if(item.photo){const image=el('img');image.className='contribution-photo';image.alt='Photo shared by family; see caption above';image.src=item.photo;card.append(image)}
  if(item.kind==='video'){
   const player=el('video');player.hidden=true;player.controls=true;player.preload='none';player.playsInline=true;player.className='contribution-video';player.setAttribute('aria-label','Private family video');const load=el('button','Load private video'),notice=el('p','Up to 60 seconds. Playback starts only when you press Play.');let loading=false;load.className='quiet';load.addEventListener('click',async()=>{if(loading||busy)return;loading=true;load.disabled=true;notice.textContent='Loading private clip…';try{const blob=await loadVideo(fs,db,item.id,item.video);if(!card.isConnected)return;const url=URL.createObjectURL(blob);playback.add({player,url});player.src=url;player.hidden=false;player.load();load.hidden=true;notice.textContent='Clip ready. Press Play to watch; then review the caption.'}catch{notice.textContent='Could not load this clip. Refresh to check your access, then try again.'}finally{loading=false;load.disabled=false}});card.append(load,player,notice)
  }
  if(item.status==='approved')card.append(el('strong','Approved AI memory'),el('p',item.reviewedText))
  if(senior&&item.status==='pending'){
   const label=el('label','Review and edit the facts Techable may remember'),input=el('textarea');input.maxLength=500;input.value=item.text;label.append(input);card.append(label,el('p','Keep the approved memory to 500 characters. Check names and details. Remove anything you do not want the AI to use. Approval saves only this edited text, not the photo or video.'))
   const reviewed=el('input');reviewed.type='checkbox';if(item.kind==='video'){const reviewLabel=el('label');reviewLabel.append(reviewed,el('span',' I reviewed this video and the edited text.'));card.append(reviewLabel)}
   const actions=el('div');actions.className='actions'
   for(const [decision,title]of [['approved','Approve text for AI memory'],['declined','Decline — do not add to AI']]){const button=el('button',title);button.className=decision==='approved'?'primary':'quiet';button.addEventListener('click',()=>perform(async()=>{if(item.kind==='video'&&decision==='approved'&&!reviewed.checked){throw Error('Review the video and edited text, then tick the review box before approving.')}await reviewContribution(fs,db,item.id,user.uid,decision,input.value,{videoReviewed:reviewed.checked});status(decision==='approved'?'Approved text saved in your memories. Return to your app to use it in new conversations.':'Declined. No AI memory was added.')}));actions.append(button)}card.append(actions)
  }
  const remove=el('button','Delete contribution');remove.className='quiet';remove.addEventListener('click',()=>{if(!confirm('Delete this contribution and its photo or video? Any text already approved remains in the senior’s memories until they remove it there.'))return;void perform(async()=>{await deleteContribution(fs,db,item.id,user.uid);status('Contribution deleted. Previously approved memories are managed separately by the senior.')})});card.append(remove);root.append(card)
 }
}
async function perform(action){if(busy||pending)return;for(const {player}of playback)player.pause();busy=true;lock(true);try{await action();await refresh()}catch(error){status(['Your memory list','Keep the approved','Write a story','Review the video'].some(prefix=>error.message?.startsWith(prefix))?error.message:'Could not confirm this change. Refresh to check the saved status before retrying.')}finally{busy=false;lock(false);$('submit').disabled=photoBusy||videoBusy}}
$('connection').addEventListener('change',()=>{if(busy||pending)return;$('story').value='';clearPhoto();clearVideo();status('New recipient selected. Write a fresh contribution for this person.')})
$('refresh').addEventListener('click',()=>perform(async()=>{status('');await loadConnections()}))
async function loadConnections(){
 if(senior){const links=await fs.getDocsFromServer(fs.query(fs.collection(db,'family_links'),fs.where('seniorUid','==',user.uid)));connections=links.docs.map(d=>({...d.data(),key:d.id}));return}
 const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'family_links'),fs.where('familyUid','==',user.uid)));connections=[]
 for(const row of snap.docs){const link=row.data();if(link.status!=='active')continue;const r=await fs.getDocFromServer(fs.doc(db,'residents',link.residentId));if(r.exists()&&canChat(link,{id:r.id,...r.data()}))connections.push({...link,name:r.data().preferredName||r.data().name||'Senior',key:row.id})}
 const previous=$('connection').value;$('connection').replaceChildren();for(const c of connections){const option=el('option',c.name);option.value=c.key;$('connection').append(option)}if(connections.some(c=>c.key===previous))$('connection').value=previous;else if(previous){$('story').value='';clearPhoto()}
 $('submit-panel').hidden=!connections.length;if(!connections.length)status('An approved family connection and the senior’s message permission are required. Check Family Chat or Link accounts first.')
}
$('composer').addEventListener('submit',async event=>{
 event.preventDefault();if(busy||photoBusy||videoBusy||senior)return
 try{if(!pending){const target=connections.find(c=>c.key===$('connection').value);draftContribution(target,user.uid,$('story').value,photo);pending={id:crypto.randomUUID(),target:{...target},text:$('story').value,photo,video}}}catch(error){status(error.message);return}
 busy=true;lock(true);status('Sending for review…')
 try{if(pending.video)await submitVideo(fs,db,pending.id,pending.target,user.uid,pending.text,pending.video);else await submitContribution(fs,db,pending.id,pending.target,user.uid,pending.text,pending.photo);pending=null;$('story').value='';clearPhoto();clearVideo();$('submit').textContent='Send for senior review';status('Sent for senior review. No AI memory was added.');await refresh()}catch{if(pending){$('submit').textContent='Retry same contribution';status('Sending could not be confirmed. Your original draft is retained; retry the same contribution to avoid duplicates. Reload to abandon it.')}else status('Sent, but the list could not refresh. Refresh to see the saved contribution.')}
 finally{busy=false;if(pending)$('submit').disabled=false;else lock(false)}
})
window.TechableAuth.guardRole(['family','resident'],async(u,role)=>{user=u;db=window.TechableAuth.db;senior=role==='resident';$('back').href=senior?'app.html':'family-dashboard.html';$('back').textContent=senior?'Back to your app':'Back to family dashboard';$('list-heading').textContent=senior?'Review family contributions':'Your contributions';busy=true;lock(true);try{await loadConnections();await refresh()}catch{status('Contributions could not be loaded. Refresh to retry.')}finally{busy=false;lock(false)}})
