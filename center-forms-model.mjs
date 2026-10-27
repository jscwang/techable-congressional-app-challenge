import {eligibleMembers} from './member-news.mjs'
export const PROFILE_KEYS=['','fullName','dob','phone','email','address','city','postalCode','emergencyName','emergencyPhone']
export function cleanTemplate(raw){
 const title=String(raw?.title||'').trim()
 if(!title||title.length>120||!Array.isArray(raw.questions)||!raw.questions.length||raw.questions.length>30)throw Error('Use a title up to 120 characters and between 1 and 30 questions.')
 const questions=raw.questions.map((q,i)=>{
  const label=String(q?.label||'').trim(),profileKey=q?.profileKey??''
  if(!label||label.length>500||!PROFILE_KEYS.includes(profileKey)||typeof q.required!=='boolean')throw Error('Check each question, required setting and demographic mapping.')
  return {id:'q'+(i+1),label,profileKey,required:q.required}
 })
 return {title,questions}
}
export function prefillAnswers(template,resident){
 const details={...resident?.myDetails,fullName:resident?.myDetails?.fullName||resident?.name||''}
 return Object.fromEntries(template.questions.map(q=>[q.id,q.profileKey?String(details[q.profileKey]??'').slice(0,1000):'']))
}
export function reviewAnswers(template,answers,reviewed){
 if(!reviewed)throw Error('Review every answer and confirm sharing with your center before saving.')
 return Object.fromEntries(template.questions.map(q=>{const value=String(answers[q.id]??'').trim();if(value.length>1000||q.required&&!value)throw Error('Answer required questions and keep each answer under 1,000 characters.');return[q.id,value]}))
}
export async function sendForms(fs,db,authorUid,campaign,raw,selected){
 const template=cleanTemplate(raw),ids=[...new Set(selected||[])]
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(campaign)||!ids.length||ids.some(x=>typeof x!=='string'||!x||x.includes('/')))throw Error('Select at least one eligible member.')
 const questionsJson=JSON.stringify(template.questions)
 for(let start=0;start<ids.length;start+=10){
  const group=ids.slice(start,start+10)
  await fs.runTransaction(db,async tx=>{
   const refs=group.map(id=>fs.doc(db,'center_forms',campaign+'_'+id)),old=await Promise.all(refs.map(ref=>tx.get(ref))),people=await Promise.all(group.map(id=>tx.get(fs.doc(db,'residents',id))))
   group.forEach((id,i)=>{
    if(old[i].exists()){const d=old[i].data();if(d.authorUid!==authorUid||d.residentId!==id||d.title!==template.title||d.questionsJson!==questionsJson)throw Error('Delivery reference already used.');return}
    const person=people[i].exists()?{id,...people[i].data()}:null
    if(!person||!eligibleMembers([person],authorUid).length)throw Error('A selected member is no longer active on your roster.')
    tx.set(refs[i],{authorUid,residentId:id,seniorUid:person.ownerUid,title:template.title,questionsJson,answersJson:'',reviewed:false,createdAt:fs.serverTimestamp(),completedAt:null})
   })
  })
 }
 return ids.length
}
