import {transcribeAudio} from './transcription-client.mjs'
import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {createDirectory,voiceIntent,dayKey} from './centre-directory-model.mjs'
import {createRecorder} from './audio-recorder.mjs'
import {safeLink} from './announcements.js'
import {mountMemberInbox} from './member-news.mjs'
import {createQuestionReader} from './form-reader.mjs'
import {connectionConsent} from './center-connections.mjs'
const $=id=>document.getElementById(id),selected=new URLSearchParams(location.search).get('centre')
const centerIntro='Here is a list of the senior centers. Do you want to check out your connected senior centers? Or do you want to be connected to a new senior center?'
const introReader=createQuestionReader({onState:(_key,on)=>{$('read-center-intro').textContent=on?'Stop reading':'Read this page aloud'}})
let model,tab='attendance',version=0,recorder,heard='',voiceReady=false,reviewCenter=''
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
function button(text,fn,className='primary'){const node=el('button',text,className);node.type='button';node.addEventListener('click',fn);return node}
function status(text=''){$('status').textContent=text}
function message(error){return error?.message?.startsWith('Connect')||error?.message?.startsWith('Please wait')||error?.message?.startsWith('Reload')?error.message:'Could not confirm this change. Refresh to check your connection and try again.'}
function center(){return model.state.centers.find(c=>c.id===selected)}
function connectionControls(c){
  const row=el('div',undefined,'button-row'),on=model.state.connected.has(c.id),application=model.state.applications.get(c.id),busy=model.state.busy.has(c.id),known=model.state.known
  const connect=button(application?(application.status==='pending'?'Request sent':application.status==='approved'?'Connected':'Request declined'):on?'Send connection request':'Connect',()=>reviewConnect(c.id));connect.disabled=!known||!!application||busy;connect.setAttribute('aria-label','Connect to '+c.name)
  const disconnect=button('Disconnect',()=>change(c.id,false),'disconnect');disconnect.disabled=!known||!on||busy;disconnect.setAttribute('aria-label','Disconnect from '+c.name)
  row.append(connect,disconnect);return row
}
function reviewConnect(id){
 introReader.stop();recorder?.cancel();heard='';reviewCenter=id;const c=model.state.centers.find(c=>c.id===id);if(!c)return
 $('connection-explanation').textContent=connectionConsent(c.name);$('connection-consent').checked=false;$('connection-confirm').disabled=true;$('connection-dialog').showModal();$('connection-cancel').focus()
}
function applicationState(c){const a=model.state.applications.get(c.id);return a?(a.status==='approved'?'✓ Approved member':a.status==='pending'?'Application sent — waiting for the center manager.':'The center declined this request. Disconnect first if you want to send a new request.'):(model.state.connected.has(c.id)?'News connection only. Send a connection request to appear in Applicants.':'')}
async function change(id,on){
  recorder?.cancel();heard='';const op=on?model.connect(id,{consented:true}):model.disconnect(id);render()
  try{await op;status(on?'Connected. Your request is in the center’s Applicants list. You can read news and sign in for visits while waiting for approval.':'Disconnected. Your connection request or directory membership was withdrawn. News and attendance are off for this center. Past attendance and separate care-center membership are unchanged.')}
  catch(error){status(message(error))}render()
}
function address(c){return [c.address,c.city,c.country].filter(Boolean).join(', ')}
function renderDirectory(){
  $('page-title').textContent='Senior Centers';$('intro').textContent=centerIntro;$('search-area').hidden=false
  const root=$('content');root.replaceChildren();const grid=el('div',undefined,'center-grid'),filter=$('search').value.trim().toLowerCase()
  for(const c of model.state.centers.filter(c=>!filter||[c.name,c.address,c.city].join(' ').toLowerCase().includes(filter))){
    const card=el('article',undefined,'center-card'+(model.state.connected.has(c.id)&&model.state.known?' connected':''))
    const link=el('a',c.name+' →','center-name');link.href='/senior-centers.html?centre='+encodeURIComponent(c.id);card.append(link)
    const body=el('div',undefined,'center-info');body.append(el('p',model.state.known?(model.state.connected.has(c.id)?'✓ Connected':'Not connected'):'Connection status unavailable','connection-state'))
    if(c.previewExample)body.append(el('p','Example from Annie’s brief · QA only','example'))
    body.append(el('p',address(c)));if(applicationState(c))body.append(el('p',applicationState(c),'hint'));if(c.upcomingActivities)body.append(el('p',c.upcomingActivities,'hint'));body.append(connectionControls(c));card.append(body);grid.append(card)
  }
  root.append(grid);if(!grid.childElementCount)root.append(el('p',model.state.centers.length?'No centers match your search.':'No verified centers are available right now.'))
}
function renderDetail(){
  const c=center(),root=$('content');root.replaceChildren();$('search-area').hidden=true;$('read-center-intro').hidden=true
  const back=el('a','← All senior centers','back');back.href='/senior-centers.html';root.append(back)
  if(!c){$('page-title').textContent='Center unavailable';root.append(el('p','This center is not currently available. Return to the directory or refresh.'));return}
  $('page-title').textContent=c.name;$('intro').textContent=address(c)
  const top=el('section',undefined,'detail-top');top.append(el('p',model.state.known?(model.state.connected.has(c.id)?'✓ Connected for news and attendance':'Not connected'):'Connection status unavailable','connection-state'))
  if(c.previewExample)top.append(el('p','Example from Annie’s brief · QA only','example'))
  if(c.details)top.append(el('p',c.details))
  const contact=[typeof c.contactPersonName==='string'?c.contactPersonName.slice(0,120):'',typeof c.contactPersonTitle==='string'?c.contactPersonTitle.slice(0,80):''].filter(Boolean).join(' · ')
  if(contact)top.append(el('p','Contact: '+contact,'hint'))
  if(applicationState(c))top.append(el('p',applicationState(c),'hint'))
  const url=safeLink(c.website);if(url){const link=el('a','Visit center website','back');link.href=url;link.target='_blank';link.rel='noopener noreferrer';top.append(link)}
  top.append(connectionControls(c));root.append(top)
  const tabs=el('div',undefined,'detail-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Center services')
  for(const [id,label]of [['attendance','Sign in'],['news','News / Events']]){const b=button(label,()=>{recorder?.cancel();heard='';tab=id;render()},'');b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab===id));b.setAttribute('aria-controls','center-panel');tabs.append(b)}root.append(tabs)
  const panel=el('section',undefined,'feature-panel');panel.id='center-panel';panel.setAttribute('role','tabpanel');root.append(panel)
  if(!model.state.known||!model.state.connected.has(c.id)){panel.append(el('h2',tab==='attendance'?'Sign in for a visit':'News / Events'),el('p','Connect to this center to use this feature. Connecting does not give the center access to your private profile.'));return}
  if(tab==='attendance')renderAttendance(c,panel);else void renderNews(c,panel,version)
}
function render(){version++;$('content').setAttribute('aria-busy','false');if(selected)renderDetail();else renderDirectory()}
function renderAttendance(c,panel){
  const current=version
  panel.append(el('h2','Welcome. Let’s sign you in.'),el('p','Use this when you arrive at the center. One sign-in is recorded per day.'))
  const result=el('p','Checking today’s sign-in…','attendance-status');result.id='attendance-result';result.setAttribute('role','status');panel.append(result)
  const actions=el('div',undefined,'attendance-actions')
  const push=button('I’m here — sign in',()=>signIn(c.id,'centre_button'));push.id='attendance-button';push.disabled=true
  const voice=button('Speak to sign in',()=>record(c.id),'voice');voice.id='attendance-voice';voice.disabled=true;actions.append(push,voice);panel.append(actions)
  panel.append(el('p','For voice: tap Speak to sign in, say “Sign me in,” then tap Done speaking. Review the words before confirming. Your recording is sent to OpenAI for transcription.','hint'))
  const voiceStatus=el('p','','hint');voiceStatus.id='voice-status';voiceStatus.setAttribute('role','status');panel.append(voiceStatus)
  const review=el('div');review.id='voice-review';panel.append(review)
  model.attendanceStatus(c.id).then(row=>{
    if(current!==version)return
    result.textContent=row?'✓ You are signed in for today.':'Ready to sign in for today.';if(row)result.classList.add('success')
    const disabled=!!row||model.state.busy.has(c.id)||!model.state.resident;push.disabled=disabled;voice.disabled=disabled
    if(!model.state.resident)result.textContent='Open your companion to finish setting up your profile first.'
  }).catch(()=>{if(current===version)result.textContent='Could not check today’s attendance. Please refresh before signing in.'})
}
async function signIn(id,method){
  recorder?.cancel();heard='';const op=model.signIn(id,method)
  $('attendance-button')?.setAttribute('disabled','');$('attendance-voice')?.setAttribute('disabled','');$('voice-confirm')?.setAttribute('disabled','')
  try{const r=await op;status(r.already?'You are already signed in for today.':'✓ You are signed in. Enjoy your visit!')}catch(error){status(message(error))}render()
}
async function renderNews(c,panel,current){
  panel.append(el('h2','News / Events'),el('p','Announcements and activities from '+c.name+'.'));const list=el('div','Loading news…','news-list');panel.append(list)
  try{
    const posts=await model.news(c.id);if(current!==version)return;list.replaceChildren()
    if(!posts.length)list.append(el('p','This center has not posted news or events yet. Check back soon.'))
    for(const post of posts){const item=el('article',undefined,'news-item');if(post.eventDate)item.append(el('p',formatDate(post.eventDate),'event-date'));const details=el('details'),summary=el('summary',post.title||'Center announcement');details.append(summary,el('p',post.body||'More details will be shared by the center.'));const link=safeLink(post.link);if(link){const a=el('a','More information →');a.href=link;a.target='_blank';a.rel='noopener noreferrer';details.append(a)}item.append(details);list.append(item)}
  }catch{if(current===version)list.textContent='News could not be loaded. Refresh to try again.'}
}
function formatDate(value){const [y,m,d]=String(value).split('-').map(Number),date=new Date(y,m-1,d);return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}
function voiceState(value){
  const b=$('attendance-voice'),s=$('voice-status');if(!b||!s)return
  b.textContent=value==='recording'?'Done speaking':['starting','stopping','transcribing'].includes(value)?'Please wait…':'Speak to sign in'
  b.disabled=['starting','stopping','transcribing'].includes(value)
  const messages={starting:'Opening microphone…',recording:'Listening. Say “Sign me in,” then tap Done speaking.',transcribing:'Turning your recording into words…',review:'Review the words, then confirm your sign-in.','permission-error':'Allow microphone access to use voice, or use the sign-in button.','recording-error':'Could not open the microphone. You can use the sign-in button.','transcription-error':'Could not transcribe this recording. Try again or use the sign-in button.',empty:'No words were heard. Please try again.','too-large':'Please try a shorter recording.'};s.textContent=messages[value]||''
}
function setupRecorder(){
  recorder=createRecorder({Recorder:window.MediaRecorder,getMedia:()=>navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}),
    async transcribe(blob,signal){return transcribeAudio(blob,signal)},onState:voiceState,
    onText:text=>{heard=text;const review=$('voice-review');if(!review)return;review.replaceChildren(el('p','You said: “'+text+'”','transcript'));if(voiceIntent(text)==='sign-in'){const confirm=button('Confirm sign-in at this center',()=>signIn(selected,'centre_voice'));confirm.id='voice-confirm';review.append(confirm)}else review.append(el('p','That was not a clear sign-in request. Nothing has been recorded. Try saying “Sign me in,” or use the sign-in button.'))}
  })
}
async function record(id){
  introReader.stop()
  if(!model.state.connected.has(id))return
  if(recorder?.state()==='recording'){recorder.finish();return}
  if(recorder?.state()!=='idle')return
  heard='';$('voice-review')?.replaceChildren()
  if(!window.MediaRecorder||!navigator.mediaDevices?.getUserMedia){$('voice-status').textContent='Recording is unavailable in this browser. Use the sign-in button.';return}
  const current=version
  try{if(!voiceReady){const r=await fetch('/api/transcribe',{signal:AbortSignal.timeout(5000)});voiceReady=r.ok&&(await r.json()).enabled}if(current!==version)return;if(!voiceReady){$('voice-status').textContent='Voice is unavailable right now. Use the sign-in button.';return}await recorder.start()}catch{if(current===version)$('voice-status').textContent='Could not reach the voice service. Use the sign-in button.'}
}
async function reload(){recorder?.cancel();heard='';$('refresh').disabled=true;status('Loading your centers…');try{await model.load();status()}catch{status('Could not load your center connections. Refresh to retry. No change is confirmed.')}finally{$('refresh').disabled=false;render()}}
function bootstrap(user){
 $('connection-consent').addEventListener('change',()=>{$('connection-confirm').disabled=!$('connection-consent').checked})
 $('connection-cancel').addEventListener('click',()=>{$('connection-dialog').close();reviewCenter=''})
 $('connection-confirm').addEventListener('click',()=>{if(!$('connection-consent').checked||!reviewCenter)return;const id=reviewCenter;reviewCenter='';$('connection-dialog').close();void change(id,true)})
 $('read-center-intro').addEventListener('click',()=>{if(introReader.isReading('centers'))introReader.stop();else introReader.read(centerIntro,'centers')})
 if(!selected)introReader.read(centerIntro,'centers')
 const inbox=el('section',undefined,'feature-panel');inbox.id='member-announcements';$('content').after(inbox)
 const news=()=>mountMemberInbox(inbox,{fs,db:window.TechableAuth.db,user})
 model=createDirectory({fs,db:window.TechableAuth.db,user});setupRecorder();$('refresh').addEventListener('click',()=>{void reload();void news()});$('search').addEventListener('input',renderDirectory);void reload();void news()
}
window.addEventListener('pagehide',()=>{introReader.stop();recorder?.cancel()});document.addEventListener('visibilitychange',()=>{if(document.hidden){introReader.stop();recorder?.cancel();heard='';$('voice-review')?.replaceChildren()}})
window.TechableAuth.guardRole(['resident'],bootstrap)
