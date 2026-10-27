export function createUpdatesController({request,onAnswer,onStatus}){
 let selected='',generation=0,busy=false
 return{
  select(id){selected=id;generation++;busy=false;onAnswer('');onStatus('')},
  async ask(question,consented){
   if(!selected||!String(question||'').trim()||question.length>1000||!consented)throw Error('Select your senior, review AI sharing, and enter a question first.')
   if(busy)throw Error('Please wait for this answer.')
   const at=++generation;busy=true;onStatus('Loading saved updates…')
   try{const data=await request({residentId:selected,question:question.trim(),consented:true});if(at!==generation)return;onAnswer(data.answer);onStatus('Based on saved updates; not a live check-in.')}
   catch(error){if(at!==generation)return;onAnswer('');onStatus(error.message||'Could not load updates. Please try again.');throw error}
   finally{if(at===generation)busy=false}
  }
 }
}
export function mountFamilyUpdates(root,{user,residents,fetchImpl=fetch}){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n}
 root.replaceChildren();root.append(el('h2','How has my senior been doing?'),el('p','Select someone who has approved your family connection. Ask about their saved updates; this is not a companion chatbot or a live check-in.'))
 const label=el('label','Your linked senior'),select=el('select');select.id='family-updates-senior';select.className='msg-select';label.htmlFor=select.id
 const option=el('option','Select a senior');option.value='';select.append(option)
 for(const resident of residents){const o=el('option',resident.name||resident.preferredName||'Senior');o.value=resident.id;select.append(o)}
 const relationLabel=el('label','They are my…'),relation=el('select');relation.id='family-updates-relation';relation.className='msg-select';relationLabel.htmlFor=relation.id
 for(const value of ['Family member','Dad','Mom','Uncle','Aunt','Grandpa','Grandma','Partner','Friend','Other']){const o=el('option',value);o.value=value;relation.append(o)}
 const questionLabel=el('label','Ask about their saved updates'),question=el('textarea');question.id='family-updates-question';question.maxLength=1000;question.rows=3;question.className='msg-textarea';questionLabel.htmlFor=question.id;question.placeholder='For example: What did they enjoy recently?'
 const consentLabel=el('label'),consent=el('input');consent.type='checkbox';consent.id='family-updates-consent';consentLabel.append(consent,document.createTextNode(' Use the selected senior’s shared summaries/check-ins and my question with OpenAI to prepare this answer.'))
 const ask=el('button','Ask about this senior');ask.type='button';ask.className='send-btn';ask.disabled=true
 const status=el('p'),answer=el('div');status.setAttribute('role','status');status.setAttribute('aria-live','polite');answer.style.whiteSpace='pre-wrap';answer.style.lineHeight='1.7';answer.setAttribute('aria-live','polite')
 root.append(label,select,relationLabel,relation,questionLabel,question,consentLabel,el('br'),ask,status,answer)
 const model=createUpdatesController({onAnswer:text=>answer.textContent=text,onStatus:text=>status.textContent=text,request:async payload=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);try{const token=await user.getIdToken();const response=await fetchImpl('/api/family-updates',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload),signal:controller.signal});const data=await response.json();if(!response.ok)throw Error(data.error||'Updates unavailable');return data}finally{clearTimeout(timer)}}})
 function pick(id){if(!residents.some(r=>r.id===id))id='';select.value=id;consent.checked=false;question.value='';model.select(id);ask.disabled=!id}
 select.addEventListener('change',()=>pick(select.value));ask.addEventListener('click',async()=>{ask.disabled=true;try{await model.ask(question.value,consent.checked)}catch(error){status.textContent=error.name==='AbortError'?'Updates timed out. Try again.':error.message}finally{ask.disabled=!select.value}})
 return{select(id){pick(id);root.scrollIntoView({block:'start',behavior:'smooth'});select.focus()}}
}
