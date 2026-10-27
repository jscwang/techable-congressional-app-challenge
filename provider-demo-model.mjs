// Deliberately a small, reviewed demo of Section A, not a benefit application.
export const FIELDS=[
 {id:'first',label:'Legal first name',command:'first name',example:'Grace'},
 {id:'last',label:'Legal last name',command:'last name',example:'Example'},
 {id:'phone',label:'Primary phone',command:'phone',example:'212 555 0100'},
 {id:'language',label:'Language you speak',command:'language',example:'English'},
 {id:'address',label:'Home address, city, state and ZIP code',command:'address',example:'123 Example Street, New York, New York, 10001'}
]
const clean=text=>String(text||'').trim().replace(/[.!?]+$/,'').toLowerCase()
const digitWords={zero:'0',oh:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9'}
function phoneAnswer(text){
 const value=text.toLowerCase().replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g,word=>digitWords[word])
 if(!/^[\d\s()+.,-]+$/.test(value))return null
 let digits=value.replace(/\D/g,'');if(digits.length===11&&digits[0]==='1')digits=digits.slice(1)
 return digits.length===10?digits.slice(0,3)+' '+digits.slice(3,6)+' '+digits.slice(6):null
}
const spokenValue=(field,value)=>field.id==='phone'?String(value).replace(/\D/g,'').split('').join(' '):value
export function createFormDemo(){
 let phase='idle',index=0,pending='',answers={},editing=false,error=''
 const snapshot=()=>({phase,index,pending,answers:{...answers}})
 function start(){phase='answer';index=0;pending='';answers={};editing=false;error=''}
 function reset(){phase='idle';index=0;pending='';answers={};editing=false;error=''}
 function pause(){if(phase!=='complete'&&phase!=='idle')phase='paused'}
 function prompt(){
  const field=FIELDS[index]
  if(phase==='answer')return error||(field.id==='language'?'Which language does the fictional applicant speak? For example, English.':`What is the fictional applicant’s ${field.label.toLowerCase()}? For example, ${spokenValue(field,field.example)}.`)
  if(phase==='confirm')return `I heard: ${spokenValue(field,pending)}. Is that correct? Say yes to keep it, or no to try again.`
  if(phase==='review')return `Please review the demo. ${FIELDS.map(f=>f.label+': '+spokenValue(f,answers[f.id])).join('. ')}. Say confirm demo to finish, or change followed by first name, last name, phone, language, or address.`
  if(phase==='complete')return 'Demo complete. Your reviewed answers are shown here only. Nothing was submitted or saved. Thank you.'
  return 'Start the voice demo when you are ready. Use fictional details only.'
 }
 function answer(raw){
  const text=String(raw||'').trim(),cmd=clean(text)
  if(['idle','paused','complete'].includes(phase))return
  if(/^(stop|stop demo|pause|cancel|cancel demo)$/.test(cmd)){pause();return}
  if(/^(repeat|repeat question|say that again)$/.test(cmd)||!text||text.length>300)return
  if(phase==='answer'){
   const value=FIELDS[index].id==='phone'?phoneAnswer(text):text.replace(/[.!?]+$/,'').trim()
   if(!value){error='Please say a ten-digit fictional phone number, one digit at a time. For example, 2 1 2 5 5 5 0 1 0 0. Say yes only when I ask you to confirm the number.';return}
   error='';pending=value;phase='confirm';return
  }
  if(phase==='confirm'){
   if(/^(no|nope|no thank you|that is wrong|that's wrong)$/.test(cmd)){pending='';phase='answer';return}
   if(!/^(yes|yes please|yes that is correct|yes that's correct|correct|that is correct|that's correct)$/.test(cmd))return
   answers[FIELDS[index].id]=pending;pending=''
   if(editing){editing=false;phase='review'}else if(index===FIELDS.length-1)phase='review';else{index++;phase='answer'}
   return
  }
  if(phase==='review'){
   if(cmd==='confirm demo'){phase='complete';return}
   const target=FIELDS.findIndex(f=>cmd==='change '+f.command)
   if(target!==-1){index=target;editing=true;error='';phase='answer'}
  }
 }
 return{start,reset,pause,answer,prompt,snapshot}
}
