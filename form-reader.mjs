// Keep the printed form intact; only remove answer-line decoration from speech.
export function questionForSpeech(label){
 const text=String(label||'').replace(/[_＿﹍﹎]+/g,' ').replace(/[.·…─━—–-]{3,}/g,' ').replace(/\s+/g,' ').trim()
 return /[\p{L}\p{N}]/u.test(text)?text:'Please answer this question.'
}
export function createQuestionReader({speech=globalThis.speechSynthesis,Utterance=globalThis.SpeechSynthesisUtterance,onState=()=>{},setTimer=setTimeout,clearTimer=clearTimeout,maxMs=60000}={}){
 let active=null,timer,generation=0
 function stop(){generation++;clearTimer(timer);timer=undefined;const old=active;active=null;if(old!==null)onState(old,false);try{speech?.cancel()}catch{}}
 function read(label,key){
  stop();if(!speech?.speak||!Utterance)return false
  const at=generation;active=key;onState(key,true)
  const finish=()=>{if(at!==generation)return;clearTimer(timer);timer=undefined;active=null;onState(key,false)}
  try{const utterance=new Utterance(questionForSpeech(label));utterance.lang='en-US';utterance.onend=finish;utterance.onerror=finish;timer=setTimer(()=>{if(at===generation)stop()},maxMs);speech.speak(utterance);return true}
  catch{stop();return false}
 }
 return {read,stop,isReading:key=>active!==null&&active===key}
}
