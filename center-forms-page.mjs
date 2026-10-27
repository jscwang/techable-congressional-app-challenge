import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {cleanTemplate,PROFILE_KEYS,prefillAnswers,reviewAnswers,sendForms} from './center-forms-model.mjs'
import {eligibleMembers} from './member-news.mjs'
import {bindDictation} from './field-dictation.mjs'
import {createQuestionReader} from './form-reader.mjs'
const $=id=>document.getElementById(id)
let db,user,manager=false,voices=[],busy=false,generation=0,currentId='',memberNames=new Map()
const reader=createQuestionReader({onState:(button,on)=>{button.textContent=on?'Stop reading':'Read this question aloud';button.setAttribute('aria-pressed',String(on))}})
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function button(label,fn,cls='primary'){const b=el('button',label,cls);b.type='button';b.addEventListener('click',fn);return b}
function field(root,label,tag='input',value='',max=1000){const wrap=el('label',label,'form-field'),input=el(tag);input.value=value;input.maxLength=max;wrap.append(input);root.append(wrap);return input}
function check(root,label){const wrap=el('label',undefined,'form-check'),input=el('input');input.type='checkbox';wrap.append(input,document.createTextNode(' '+label));root.append(wrap);return input}
function stop(){voices.forEach(v=>v.cancel());reader.stop()}
function status(text=''){$('status').textContent=text}
function lock(root,on){root.querySelectorAll('input,textarea,select,button').forEach(n=>n.disabled=on);$('refresh').disabled=on;$('forms-list').querySelectorAll('button').forEach(n=>n.disabled=on)}
function templateOf(data){return cleanTemplate({title:data.title,questions:JSON.parse(data.questionsJson)})}
async function list(){
 const root=$('forms-list');root.replaceChildren(el('p','Loading forms…'))
 try{
  const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'center_forms'),fs.where(manager?'authorUid':'seniorUid','==',user.uid),fs.orderBy('createdAt','desc'),fs.limit(40)))
  root.replaceChildren();if(snap.empty)root.append(el('p',manager?'No forms sent yet.':'Your center has not sent you a form yet.'))
  snap.forEach(doc=>{const data=doc.data(),card=el('article',undefined,'news-item');card.append(el('h3',data.title));if(manager)card.append(el('p','Member: '+(memberNames.get(data.residentId)||'Former or unavailable member')));card.append(el('p',data.reviewed?'Reviewed answers saved':'Waiting for reviewed answers'));card.append(button(manager?'View answers':'Open form',()=>void open(doc.id)));root.append(card)})
 }catch{root.replaceChildren(el('p','Forms could not be loaded. Refresh to try again.'))}
}
async function open(id){
 if(busy)return;stop();voices=[];const at=++generation;currentId=id;const root=$('editor');root.hidden=false;root.replaceChildren(el('p','Loading the form…'))
 try{
  const snap=await fs.getDocFromServer(fs.doc(db,'center_forms',id));if(at!==generation)return;if(!snap.exists())throw Error('missing')
  const data=snap.data(),template=templateOf(data),saved=data.answersJson?JSON.parse(data.answersJson):{}
  root.replaceChildren(el('h2',template.title),el('p',manager?'Only this center’s sending account and the selected senior can read these answers.':'Your answers stay on this page until you explicitly save them for the center that sent this form. This digital copy does not modify or submit the original PDF.'))
  const inputs={},reviewed=manager?null:check(root,'I reviewed every answer and agree to save these answers for my center to read.')
  const actions=el('div',undefined,'form-actions'),msg=el('p','','form-status');msg.setAttribute('role','status')
  if(!manager)actions.append(button('Use my saved details',async()=>{
   stop();try{const resident=await fs.getDocFromServer(fs.doc(db,'residents',data.residentId));if(at!==generation)return;if(resident.data()?.ownerUid!==user.uid)throw Error('owner');const values=prefillAnswers(template,resident.data());for(const q of template.questions)if(!inputs[q.id].value)inputs[q.id].value=values[q.id];reviewed.checked=false;msg.textContent='Matching empty fields filled from your saved details. Review each answer. Other answers were left blank.'}
   catch{msg.textContent='Your saved details could not be loaded. You can type each answer.'}
  },'quiet'))
  root.append(actions)
  for(const q of template.questions){
   const block=el('section');block.append(el('h3',q.label+(q.required?' (required)':''),'form-question'));const input=field(block,'Your answer','textarea',String(saved[q.id]||''));input.id='answer-'+q.id;inputs[q.id]=input;input.readOnly=manager
   if(!manager){input.addEventListener('input',()=>{reviewed.checked=false});const row=el('div',undefined,'form-actions'),voice=button('Speak this answer',()=>reader.stop(),'quiet'),voiceStatus=el('p');voiceStatus.setAttribute('role','status');const read=button('Read this question aloud',()=>{const wasReading=reader.isReading(read);stop();if(!wasReading&&!reader.read(q.label,read))voiceStatus.textContent='Read-aloud is unavailable. You can read the question on screen.'},'quiet');row.append(read,voice);block.append(row,voiceStatus);const binding=bindDictation({button:voice,input,status:voiceStatus,context:()=>currentId+':'+q.id});voices.push(binding)}
   root.append(block)
  }
  if(!manager){
   const save=button('Save reviewed answers for my center',async()=>{
    if(busy)return;let answers
    try{answers=reviewAnswers(template,Object.fromEntries(template.questions.map(q=>[q.id,inputs[q.id].value])),reviewed.checked)}catch(error){msg.textContent=error.message;return}
    stop();busy=true;lock(root,true);msg.textContent='Saving your reviewed answers…'
    try{
     await fs.runTransaction(db,async tx=>{const ref=fs.doc(db,'center_forms',id),latest=await tx.get(ref);if(!latest.exists()||latest.data().answersJson!==data.answersJson||latest.data().questionsJson!==data.questionsJson)throw Error('changed');tx.update(ref,{answersJson:JSON.stringify(answers),reviewed:true,completedAt:fs.serverTimestamp()})})
     data.answersJson=JSON.stringify(answers);reviewed.checked=false;msg.textContent='Reviewed answers saved for your center. Nothing was submitted to an outside organization.';void list()
    }catch{msg.textContent='Saving could not be confirmed, or this form changed elsewhere. Refresh and check the saved answers before retrying.'}
    finally{busy=false;lock(root,false)}
   });actions.append(save)
  }
  actions.append(button('Print / save as PDF',()=>window.print(),'quiet'));root.append(msg);root.scrollIntoView({block:'start'})
 }catch{if(at===generation)root.replaceChildren(el('p','This form could not be opened. Refresh to try again.'))}
}
async function managerTools(profile){
 const root=$('tools');root.hidden=false;root.replaceChildren(el('h2','Upload a blank form'),el('p','Upload a blank PDF (up to 2 MB and 30 questions). It is sent to OpenAI to extract the questions. Do not upload a filled form or personal records. The original file is not retained in Techable; review the digital questions against your original before sharing.'))
 if(profile.verificationStatus!=='approved'){root.append(el('p','Your account must be verified before analyzing or sending forms.'));return}
 const upload=field(root,'Blank PDF','input');upload.type='file';upload.accept='application/pdf,.pdf';const msg=el('p');msg.setAttribute('role','status');const review=el('section');root.append(msg,review)
 const analyze=button('Analyze blank PDF with AI',async()=>{
  if(busy)return;const file=upload.files?.[0];if(!file||file.size>2*1024*1024||!file.name.toLowerCase().endsWith('.pdf')){msg.textContent='Choose a blank PDF under 2 MB.';return}
  busy=true;lock(root,true);msg.textContent='Extracting questions. Nothing has been shared with members.';review.replaceChildren()
  try{const token=await user.getIdToken(),response=await fetch('/api/form-extract',{method:'POST',headers:{'Content-Type':'application/pdf',Authorization:'Bearer '+token},body:file,signal:AbortSignal.timeout(30000)}),data=await response.json().catch(()=>({error:'Form analysis is unavailable. Please retry shortly.'}));if(!response.ok)throw Error(data.error||'Analysis failed.');renderReview(review,cleanTemplate(data));msg.textContent='Check every extracted question, choice, required setting and demographic mapping against the PDF. Add any missing question.'}
  catch(error){msg.textContent=error.message||'Could not analyze this form.'}
  finally{busy=false;lock(root,false)}
 });root.insertBefore(analyze,msg)
}
function renderReview(root,template){
 root.replaceChildren();const title=field(root,'Form title','input',template.title,120),questions=el('div');root.append(questions)
 const rows=[]
 function add(q={label:'',profileKey:'',required:false}){
  if(rows.length>=30)return;const block=el('section',undefined,'news-item'),label=field(block,'Question (include its choices and instructions)','textarea',q.label,500),mapping=field(block,'Fill from saved details (optional)','select')
  for(const key of PROFILE_KEYS){const option=el('option',key||'Do not prefill');option.value=key;mapping.append(option)}mapping.value=q.profileKey
  const required=check(block,'Required by the original form');required.checked=q.required
  const row={block,label,mapping,required};rows.push(row);block.append(button('Remove question',()=>{rows.splice(rows.indexOf(row),1);block.remove()},'quiet'));questions.append(block)
 }
 template.questions.forEach(add);root.append(button('Add missing question',()=>add(),'quiet'))
 const roster=el('div');root.append(el('h3','Send to members'),roster)
 const confirm=check(root,'I compared all questions with the blank PDF and reviewed the demographic mappings.'),msg=el('p');msg.setAttribute('role','status')
 const send=button('Send reviewed form to selected members',async()=>{
  if(busy)return
  try{if(!pending){if(!confirm.checked)throw Error('Review the questions and confirm before sending.');pending={campaign:crypto.randomUUID(),template:cleanTemplate({title:title.value,questions:rows.map(r=>({label:r.label.value,profileKey:r.mapping.value,required:r.required.checked}))}),ids:boxes.filter(b=>b.checked).map(b=>b.value)};if(!pending.ids.length){pending=null;throw Error('Select at least one member.')}}}catch(error){msg.textContent=error.message;return}
  busy=true;lock($('tools'),true);msg.textContent='Sending the reviewed form…'
  try{const n=await sendForms(fs,db,user.uid,pending.campaign,pending.template,pending.ids);pending=null;msg.textContent='Form sent to '+n+' member(s). They can review and answer it in Center Forms.';void list();lock($('tools'),false);send.disabled=true;uploadComplete=true}
  catch{msg.textContent='Delivery is not fully confirmed. Some members may already have it. Retry the same form to finish without duplicates.';send.disabled=false;send.textContent='Retry same form'}
  finally{busy=false}
 })
 let pending=null,boxes=[],uploadComplete=false
 questions.addEventListener('input',()=>{confirm.checked=false});title.addEventListener('input',()=>{confirm.checked=false})
 root.append(send,msg)
 fs.getDocsFromServer(fs.query(fs.collection(db,'residents'),fs.where('centreId','==',user.uid))).then(snap=>{
  if(!root.isConnected)return;const people=eligibleMembers(snap.docs.map(d=>({id:d.id,...d.data()})),user.uid)
  const all=check(roster,'Select all available members');boxes=people.map(m=>{const box=check(roster,m.preferredName||m.name||'Unnamed member');box.value=m.id;box.addEventListener('change',()=>{all.checked=boxes.every(b=>b.checked);all.indeterminate=boxes.some(b=>b.checked)&&!all.checked});return box});all.addEventListener('change',()=>boxes.forEach(b=>b.checked=all.checked))
  if(!people.length){roster.append(el('p','No active members with personal sign-ins are available.'));send.disabled=true}
 }).catch(()=>{roster.append(el('p','Members could not be loaded. Refresh before sending.'));send.disabled=true})
 // After a confirmed send, analyze a file again to start a new reviewed campaign.
 root.addEventListener('input',()=>{if(uploadComplete)msg.textContent='This reviewed form has already been sent. Analyze a file again to start another delivery.'})
}
async function boot(u,role){
 user=u;db=window.TechableAuth.db;manager=['community_manager','centre'].includes(role);$('back').href=manager?'profile.html':'app.html';$('back').textContent=manager?'Back to Members':'Back to your app'
 $('intro').textContent=manager?'Upload, review and share forms with selected members.':'Read or listen to each question, answer, then review before sharing with your center.'
 if(manager){const profile=await fs.getDocFromServer(fs.doc(db,'users',user.uid));const roster=await fs.getDocsFromServer(fs.query(fs.collection(db,'residents'),fs.where('centreId','==',user.uid)));memberNames=new Map(roster.docs.map(d=>[d.id,d.data().preferredName||d.data().name||'Unnamed member']));await managerTools(profile.data()||{})}
 $('refresh').addEventListener('click',()=>{if(busy)return;stop();generation++;currentId='';$('editor').hidden=true;void list()});await list()
}
window.addEventListener('pagehide',stop);document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()})
window.TechableAuth.guardRole(['resident','community_manager'],(u,r)=>void boot(u,r).catch(()=>status('Forms could not be loaded. Refresh to retry.')))
