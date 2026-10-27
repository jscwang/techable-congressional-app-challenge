import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {uploadVerificationFiles,deleteVerificationFiles} from './verification-storage.js'
import {submitDocuments,validateDocuments,verificationRole} from './verification-workspace.mjs'
import {centerSetupState,mountCenterSetup} from './center-setup.mjs'
const $=id=>document.getElementById(id)
const setupParams=new URLSearchParams(window.location?.search||'')
window.TechableAuth.guardRole(['community_manager','service_provider'],async user=>{
 const db=fs.getFirestore();let role='',status='',known=false,busy=false,alive=true,generation=0,setupReady=true
 function controls(){const allowed=alive&&known&&setupReady&&!busy&&window.TECHABLE_CONFIG?.storageEnabled===true&&['not_submitted','rejected'].includes(status);$('documents').disabled=!allowed;$('submit').disabled=!allowed||!$('documents').files.length;$('refresh').disabled=busy}
 function fileList(){const files=Array.from($('documents').files);$('file-list').replaceChildren();for(const file of files){const item=document.createElement('li');item.textContent=file.name+' ('+Math.ceil(file.size/1024)+' KB)';$('file-list').append(item)}try{if(files.length)validateDocuments(files);$('status').textContent=''}catch(error){$('status').textContent=error.message;$('submit').disabled=true;return}controls()}
 async function refresh(){
  const at=++generation;known=false;controls();$('verification-state').textContent='Checking your latest status…';$('review-note').textContent=''
  try{
   const snapshot=await fs.getDocFromServer(fs.doc(db,'users',user.uid));if(!alive||at!==generation)return
   if(!snapshot.exists()||snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)throw Error('Could not confirm account')
   const profile=snapshot.data();role=verificationRole(profile.role);if(!['community_manager','service_provider'].includes(role))throw Error('Role changed')
   $('back').href=role==='community_manager'?'profile.html':'provider-dashboard.html';status=profile.verificationStatus||'not_submitted';known=['approved','pending','rejected','not_submitted'].includes(status)
   $('verification-state').textContent=({approved:'Approved. Your account is verified; no new upload is needed.',pending:'Pending Techable review. No new upload is needed while this submission is being reviewed.',rejected:'More information is needed. Review the note below, then submit updated documents.',not_submitted:'No verification documents submitted yet.'})[status]||'Unrecognized verification status. Contact Techable support.'
   if(role==='community_manager'&&setupParams.get('setup')==='center'){
    setupReady=false
    let centers=[],centersKnown=false
    try{const list=await fs.getDocsFromServer(fs.query(fs.collection(db,'communities'),fs.where('managerUid','==',user.uid)));if(!alive||at!==generation)return;centersKnown=!list.metadata.fromCache&&!list.metadata.hasPendingWrites;list.forEach(item=>centers.push({...item.data(),id:item.id}))}catch{}
    if(!alive||at!==generation)return
    const state=centerSetupState({user,centers,centersKnown,selectedId:setupParams.get('centre')||'',verificationStatus:status,storageEnabled:window.TECHABLE_CONFIG?.storageEnabled===true})
    const back='profile.html'+(state.center?'?centre='+encodeURIComponent(state.center.id):'')+'#center-details'
    $('back').href=back;setupReady=state.canOpenVerification
    const root=$('center-setup-progress');root.hidden=false
    mountCenterSetup(root,state,{onDetails:()=>{window.location.href=back},onVerification:()=>{$('verification-title').setAttribute('tabindex','-1');$('verification-title').focus()},onRetry:()=>void refresh()})
   }
   $('storage-status').textContent=window.TECHABLE_CONFIG?.storageEnabled===true?'Private document upload is configured.':'Document uploads are not configured for this preview. No files can be uploaded until private QA storage is enabled.'
   controls()
   if(status==='rejected'){try{const note=await fs.getDocFromServer(fs.doc(db,'verification_notes',user.uid));if(alive&&at===generation)$('review-note').textContent=note.exists()&&!note.metadata.fromCache?String(note.data().note||''):'Contact Techable for the review details.'}catch{if(alive&&at===generation)$('review-note').textContent='Could not load the private review note. Refresh or contact Techable.'}}
  }catch{if(alive&&at===generation){known=false;$('verification-state').textContent='Could not confirm your status. Refresh before uploading.';controls()}}
 }
 $('documents').addEventListener('change',fileList);$('refresh').addEventListener('click',()=>void refresh())
 $('submit').addEventListener('click',async()=>{
  if(busy||!known||!setupReady||!alive||window.TECHABLE_CONFIG?.storageEnabled!==true||!['not_submitted','rejected'].includes(status))return
  const files=Array.from($('documents').files);try{validateDocuments(files)}catch(error){$('status').textContent=error.message;return}
  busy=true;controls();$('status').textContent='Uploading documents for review. Please keep this page open…'
  try{const count=await submitDocuments({fs,db,user,role,files,upload:uploadVerificationFiles,cleanup:deleteVerificationFiles,isActive:()=>alive&&window.TechableAuth.currentUser?.uid===user.uid});if(!alive)return;$('documents').value='';$('file-list').replaceChildren();$('status').textContent=count+' document(s) submitted. Your account is pending Techable review; it is not approved yet.'}
  catch(error){if(alive)$('status').textContent=/cleanup|support/i.test(error.message)?'Submission was not confirmed. Contact Techable support before retrying.':'Could not confirm the submission. Your account has not been marked approved. Refresh your status before retrying.'}
  finally{busy=false;if(alive)await refresh()}
 })
 window.addEventListener('pageshow',event=>{if(event.persisted)window.location.reload()})
 window.addEventListener('pagehide',()=>{alive=false;generation++;$('documents').value='';$('file-list').replaceChildren()})
 await refresh()
})
