import {createFormDemo,FIELDS} from './provider-demo-model.mjs'
import {createHandsfreeVoice} from './handsfree-voice.mjs'
import {transcribeAudio} from './transcription-client.mjs'
const $=id=>document.getElementById(id)
window.TechableAuth.guardRole(['resident'],()=>{
 const model=createFormDemo();let generation=0,utterance=null,running=false,speakingTimer,handsfree=true
 function cancel(){generation++;running=false;clearTimeout(speakingTimer);voice.cancel();utterance=null;window.speechSynthesis?.cancel();$('stop').disabled=true;$('retry').hidden=true}
 function stop(){cancel();model.pause();$('demo-status').textContent='Voice demo stopped. Your reviewed answers remain on this page. Start again to clear and restart.'}
 function render(){
  const state=model.snapshot();$('question').textContent=model.prompt();$('complete').hidden=state.phase!=='complete';$('values').replaceChildren()
  for(const field of FIELDS){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=field.label;dd.textContent=state.answers[field.id]||'Not confirmed';$('values').append(dt,dd)}
  $('start').textContent=state.phase==='idle'?'Start voice demo':'Reset and start voice demo'
 }
 const voice=createHandsfreeVoice({transcribe:transcribeAudio,onText:text=>{if(!running)return;$('transcript').textContent='You said: '+text;model.answer(text);if(model.snapshot().phase==='paused'){stop();return}render();void ask()},onState:state=>{
  if(!running)return
  const messages={starting:'Opening microphone…',recording:'Listening. Speak now, then pause. No extra click needed.',stopping:'Finishing your recording…',transcribing:'AI is turning your recording into words…'}
  if(messages[state]){$('demo-status').textContent=messages[state];return}
  if(['idle','review'].includes(state))return
  const errors={'no-speech':'No clear speech heard. Please choose Speak again, or type your answer.','permission-error':'Microphone permission was not granted. Allow it and choose Speak again, or type.','transcription-error':'Transcription failed. Your answer was not accepted. Choose Speak again or type.',unsupported:'Hands-free recording needs a supported browser such as Chrome or Edge. You can type instead.'}
  $('demo-status').textContent=errors[state]||'Recording could not continue. Choose Speak again, or type.';$('retry').hidden=false
 }})
 async function ask(){
  const at=++generation;voice.cancel();window.speechSynthesis?.cancel();clearTimeout(speakingTimer);render()
  const text=model.prompt(),done=model.snapshot().phase==='complete';$('retry').hidden=true;$('stop').disabled=false;$('demo-status').textContent='Reading the question…'
  if(!handsfree){$('demo-status').textContent=done?'Finished. Nothing was saved or submitted.':'Typing mode. Review the question, then type an answer or command. Choose Speak again to return to voice.';$('retry').hidden=done;if(done)cancel();return}
  if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){$('demo-status').textContent='Read the question on screen. Choose Speak again to answer, or type.';$('retry').hidden=done;return}
  let ended=false
  const fail=()=>{if(ended||at!==generation||!running)return;ended=true;clearTimeout(speakingTimer);window.speechSynthesis.cancel();$('demo-status').textContent='Audio could not finish. Read the question, then choose Speak again or type.';$('retry').hidden=done}
  utterance=new SpeechSynthesisUtterance(text);utterance.lang='en-US';utterance.rate=.95;utterance.onerror=fail
  utterance.onend=()=>{if(ended||at!==generation||!running)return;ended=true;clearTimeout(speakingTimer);utterance=null;if(done){cancel();$('demo-status').textContent='Finished. Nothing was saved or submitted.'}else void voice.start()}
  speakingTimer=setTimeout(fail,45000)
  try{window.speechSynthesis.speak(utterance)}catch{fail()}
 }
 $('start').addEventListener('click',()=>{cancel();model.start();running=true;handsfree=true;$('transcript').textContent='';$('answer').value='';void ask()})
 $('stop').addEventListener('click',stop)
 $('retry').addEventListener('click',()=>{if(!running)return;generation++;clearTimeout(speakingTimer);window.speechSynthesis?.cancel();handsfree=true;$('retry').hidden=true;void voice.start()})
 function useTyped(){if(!$('answer').value.trim())return;if(!running){if(model.snapshot().phase!=='idle')return;running=true;model.start()}generation++;handsfree=false;clearTimeout(speakingTimer);voice.cancel();window.speechSynthesis?.cancel();const text=$('answer').value;$('answer').value='';$('transcript').textContent='You entered: '+text;model.answer(text);if(model.snapshot().phase==='paused'){stop();return}void ask()}
 $('send').addEventListener('click',useTyped);$('answer').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();useTyped()}})
 window.addEventListener('pagehide',()=>{cancel();model.reset();$('answer').value='';$('transcript').textContent='';render();$('demo-status').textContent='Use fictional details only. Start the demo when ready.'})
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&running)stop()})
 render()
})
