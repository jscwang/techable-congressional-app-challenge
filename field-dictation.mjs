import {createRecorder} from './audio-recorder.mjs'
import {transcribeAudio} from './transcription-client.mjs'
import {mergeDictation,spokenField} from './senior-actions-model.mjs'
let activeCancel=null
// One explicit field at a time. Dictation changes a draft, never submits a form.
export function bindDictation({button,input,status,anonymous=false,context=()=>'',replace=false}){
 let recorder,recognition,baseline='',at='',generation=0,timer
 const label=button.textContent
 function show(text,active=false,busy=false){status.textContent=text;button.textContent=active?'Done speaking':busy?'Please wait…':label;button.disabled=busy;button.setAttribute('aria-pressed',String(active))}
 function cancel(){generation++;clearTimeout(timer);recorder?.cancel();try{recognition?.abort()}catch{}recognition=null;show('')}
 function accept(text){
  let value=mergeDictation({baseline,current:input.value,text,context:at,currentContext:context()})
  if(value===null){show('Your field changed. The recording was not inserted. Please try again.');return}
  if(anonymous)value=spokenField(input.id,text)
  else if(replace)value=String(text||'').trim()
  if(!value){show('No words were heard. Please try again or type.');return}
  if(value.length>(input.maxLength>0?input.maxLength:4000)){show('That answer is too long. Please try a shorter recording or type.');return}
  input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();show('Review the words. Nothing has been submitted or saved.')
 }
 async function toggle(){
  if(recorder?.state()==='recording'){recorder.finish();return}
  if(recognition){recognition.stop();return}
  activeCancel?.();cancel();activeCancel=cancel;baseline=input.value;at=context();const id=++generation
  window.TechableApp?.stopSpeaking?.()
  if(anonymous){
   const Speech=window.SpeechRecognition||window.webkitSpeechRecognition
   if(!Speech){show('Voice registration needs a browser with speech recognition. You can type or use Google sign-in.');return}
   recognition=new Speech();recognition.lang='en-US';recognition.interimResults=false;recognition.continuous=false
   recognition.onstart=()=>{if(id===generation)show('Listening. Speak only the selected field.',true)}
   recognition.onresult=e=>{if(id===generation)accept(Array.from(e.results).map(r=>r[0].transcript).join(' '))}
   recognition.onerror=e=>{if(id===generation)show(e.error==='not-allowed'?'Allow microphone access or type this field.':'Browser speech recognition is unavailable. Please type this field or use Google sign-in.')}
   recognition.onend=()=>{if(id!==generation)return;clearTimeout(timer);recognition=null;button.textContent=label;button.disabled=false;button.setAttribute('aria-pressed','false')}
   try{show('Opening microphone…',false,true);recognition.start();timer=setTimeout(()=>recognition?.stop(),30000)}catch{recognition=null;show('Could not start speech recognition. Please type this field.')}
   return
  }
  if(!window.MediaRecorder||!navigator.mediaDevices?.getUserMedia){show('Recording is unavailable. Please type your entry.');return}
  recorder=createRecorder({Recorder:window.MediaRecorder,getMedia:()=>navigator.mediaDevices.getUserMedia({audio:true,video:false}),transcribe:transcribeAudio,
   onState:s=>{if(id!==generation)return;const states={starting:'Opening microphone…',recording:'Listening. Tap Done speaking when finished.',transcribing:'Turning your recording into words…','permission-error':'Allow microphone access or type your entry.','recording-error':'Could not open the microphone. Please type your entry.','transcription-error':'Could not transcribe this recording. Please try again or type.',empty:'No words were heard. Please try again.','too-large':'Please try a shorter recording.'};if(s!=='review')show(states[s]||'',s==='recording',['starting','stopping','transcribing'].includes(s))},onText:text=>{if(id===generation)accept(text)}})
  await recorder.start()
 }
 button.addEventListener('click',()=>void toggle())
 input.addEventListener('input',()=>{if((recorder&&recorder.state()!=='idle')||recognition)cancel()})
 window.addEventListener('pagehide',cancel);document.addEventListener('visibilitychange',()=>{if(document.hidden)cancel()})
 return {cancel}
}
// Signup dictation never listens to passwords, consent or the Google button.
for(const button of document.querySelectorAll('[data-dictate]')){
 const input=document.getElementById(button.dataset.dictate),status=document.getElementById('registration-voice-status')
 if(input&&status&&['first-name','last-name','email'].includes(input.id))bindDictation({button,input,status,anonymous:true,replace:true,context:()=>String(window.isSignUp)})
}
