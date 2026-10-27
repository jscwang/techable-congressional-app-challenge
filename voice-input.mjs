import { createRecorder } from './audio-recorder.mjs'
import {transcribeAudio} from './transcription-client.mjs'
await window._cfg?.catch(()=>null)
if(window.TECHABLE_CONFIG?.transcriptionEnabled){
const $=id=>document.getElementById(id)
let baseline='', context='',lastError='',checking=false,checkId=0
const messages={
  idle:'Tap to record. Wait for Listening, then speak. Tap Done talking, review, and Send.',
  starting:'Opening microphone…', recording:'Listening. Tap again when you have finished.',
  transcribing:'Turning your recording into words…',review:'Check the words below, then press Send.',
  empty:'I could not hear any words. Please try again or type your answer.',
  'permission-error':'Microphone access was denied. Allow microphone access, then try again.',
  'recording-error':'Could not open the microphone. Please check your microphone and try again.',
  'transcription-error':'Could not transcribe your recording. Please try again or type your answer.',
  'too-large':'That recording was too long. Please try a shorter answer.'
}
function show(state,message){
  const active=state==='recording',busy=['starting','transcribing'].includes(state)
  const label=active?'Done talking':busy?'Please wait…':'Tap to talk'
  const btn=$('talk-btn');if(btn){btn.disabled=state==='transcribing';btn.setAttribute('aria-pressed',String(active));btn.setAttribute('aria-label',label);btn.classList.toggle('active',active);btn.classList.toggle('starting',state==='starting')}
  if($('talk-lbl'))$('talk-lbl').textContent=label
  const text=message || messages[state] || ''
  if($('mic-status-text'))$('mic-status-text').textContent=text
  $('mic-status')?.classList.toggle('on',!!text)
}
const recorder=createRecorder({Recorder:window.MediaRecorder,
  getMedia:()=>navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false}),
  async transcribe(blob,signal){
    return transcribeAudio(blob,signal)
  },
  onState:state=>show(state,state==='transcription-error'?lastError:null),
  onText:text=>{
    const input=$('chat-input')
    if(!input || input.value!==baseline || (window.TechableCheckIn?.answerContext?.()||'')!==context)return
    input.value=baseline.trim()?baseline.trim()+' '+text:text
    window.grow?.(input);input.focus()
  }
})
const cancel=()=>{checkId++;checking=false;recorder.cancel()}
async function toggle(){
  if(checking){cancel();return}
  if(recorder.state()==='recording'){recorder.finish();return}
  if(recorder.state()!=='idle'){cancel();return}
  if(!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia){show('idle','Audio recording is unavailable in this browser. Please type your answer.');return}
  checking=true;const id=++checkId;show('starting','Checking voice connection…')
  try{
    const response=await fetch('/api/transcribe',{signal:AbortSignal.timeout(5000)})
    const status=await response.json()
    if(id!==checkId)return
    if(!response.ok || !status.enabled){show('idle','Voice input is unavailable right now. You can still type your answer.');return}
    baseline=$('chat-input')?.value||'';context=window.TechableCheckIn?.answerContext?.()||'';lastError=''
    window.TechableApp?.stopSpeaking?.()
    await recorder.start()
  }catch{if(id===checkId)show('idle','Cannot reach the voice service. Please try again or type your answer.')}
  finally{if(id===checkId)checking=false}
}
// Capture before the existing inline handler; no production app file changes.
document.addEventListener('click',event=>{
  const target=event.target.closest('button')
  if(target?.id==='talk-btn'){event.preventDefault();event.stopImmediatePropagation();void toggle();return}
  if(target?.id==='send-btn' || target?.id==='finish-btn' || target?.closest('.checkin-ctls') || target?.closest('#senior-nav') || target?.textContent==='New test game')cancel()
},true)
document.addEventListener('input',event=>{if(event.target.id==='chat-input' && recorder.state()!=='idle')cancel()},true)
document.addEventListener('keydown',event=>{if(event.target.id==='chat-input' && event.key==='Enter')cancel()},true)
window.addEventListener('pagehide',cancel)
document.addEventListener('techable:pause-chat-audio',cancel)
document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel()})
// This preview deliberately uses review-and-send rather than auto-reopening.
function install(){if(window.TechableApp)window.TechableApp.listen=()=>{}}
install();document.addEventListener('techable:ready',install)
show('idle')
}
