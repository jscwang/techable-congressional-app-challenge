export function canChat(link,resident){
 return !!(link?.status==='active'&&resident?.id===link.residentId&&resident.ownerUid===link.seniorUid&&Array.isArray(resident.messageFrom)&&resident.messageFrom.includes(link.familyUid)&&!(resident.messageBlocked||[]).includes(link.familyUid))
}
export function cleanChatMessage(target,senderUid,raw){
 const text=String(raw||'').trim()
 if(!text||text.length>1000)throw Error('Write or dictate a message of up to 1,000 characters, then review it before sending.')
 if(!target||!['residentId','seniorUid','familyUid'].every(k=>typeof target[k]==='string'&&target[k]&&!target[k].includes('/'))||![target.seniorUid,target.familyUid].includes(senderUid))throw Error('Choose an approved family connection.')
 return {residentId:target.residentId,seniorUid:target.seniorUid,familyUid:target.familyUid,senderUid,text}
}
function millis(value){return value?.toMillis?.()??(typeof value?.seconds==='number'?value.seconds*1000:0)}
export function mergeChatMessages(rows){return [...new Map(rows.map(row=>[row.id,row])).values()].sort((a,b)=>millis(a.createdAt)-millis(b.createdAt)||a.id.localeCompare(b.id))}
export async function sendChatMessage(fs,db,id,target,senderUid,text){
 const message=cleanChatMessage(target,senderUid,text)
 if(typeof id!=='string'||!id||id.includes('/'))throw Error('Invalid message reference.')
 return fs.runTransaction(db,async tx=>{
  const ref=fs.doc(db,'family_chat',id),existing=await tx.get(ref)
  if(existing.exists()){
   const previous=existing.data()
   if(!Object.keys(message).every(k=>previous[k]===message[k]))throw Error('This message reference was already used. Refresh and review the thread.')
   return id
  }
  tx.set(ref,{...message,createdAt:fs.serverTimestamp()});return id
 })
}
