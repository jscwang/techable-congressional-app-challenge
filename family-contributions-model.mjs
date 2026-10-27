function checkedText(raw){const text=String(raw||'').trim();if(!text||text.length>2000)throw Error('Write a story or photo/video caption of up to 2,000 characters.');return text}
function checkedId(id){if(typeof id!=='string'||!id||id.includes('/'))throw Error('Invalid contribution reference.')}
export function draftContribution(target,uid,raw,photo=''){
 if(!target||!['residentId','seniorUid','familyUid'].every(k=>typeof target[k]==='string'&&target[k]&&!target[k].includes('/'))||uid!==target.familyUid)throw Error('Choose an approved senior connection.')
 if(typeof photo!=='string'||photo.length>350000||(photo&&!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo)))throw Error('Choose a supported photo; large photos must be reduced before sending.')
 return{residentId:target.residentId,seniorUid:target.seniorUid,familyUid:target.familyUid,text:checkedText(raw),photo,kind:photo?'photo':'story',status:'pending',reviewedText:''}
}
export async function submitContribution(fs,db,id,target,uid,text,photo){
 checkedId(id);const draft=draftContribution(target,uid,text,photo)
 return fs.runTransaction(db,async tx=>{const ref=fs.doc(db,'family_contributions',id),snap=await tx.get(ref);if(snap.exists()){const old=snap.data();if(!['residentId','seniorUid','familyUid','text','photo','kind'].every(k=>old[k]===draft[k]))throw Error('This reference belongs to a different draft. Reload before starting another.');return}tx.set(ref,{...draft,createdAt:fs.serverTimestamp()})})
}
export async function reviewContribution(fs,db,id,uid,decision,raw,{videoReviewed=false}={}){
 checkedId(id);if(!['approved','declined'].includes(decision))throw Error('Choose approve or decline.')
 const text=decision==='approved'?checkedText(raw):'';if(text.length>500)throw Error('Keep the approved AI memory to 500 characters or fewer.')
 return fs.runTransaction(db,async tx=>{
  const ref=fs.doc(db,'family_contributions',id),snap=await tx.get(ref);if(!snap.exists())throw Error('Contribution no longer available.');const item=snap.data()
  if(item.seniorUid!==uid)throw Error('Only the senior can review this contribution.')
  if(item.kind==='video'&&decision==='approved'&&!videoReviewed)throw Error('Review the video and edited text before approving.')
  if(item.status!=='pending'){if(item.status===decision&&item.reviewedText===text)return;throw Error('Already reviewed. Refresh to see the saved decision.')}
  if(decision==='approved'){
   const residentRef=fs.doc(db,'residents',item.residentId),resident=await tx.get(residentRef)
   if(!resident.exists()||resident.data().ownerUid!==uid)throw Error('Your profile could not be confirmed.')
   const memories=resident.data().memories||[];if(memories.length>=1000)throw Error('Your memory list is full. Remove an old memory before approving another.')
   if(memories.some(m=>m.id==='family-'+id))throw Error('Memory reference already exists. Refresh before reviewing.')
   tx.update(residentRef,{memories:[{id:'family-'+id,text,tag:'family'},...memories],updatedAt:fs.serverTimestamp()})
  }
  tx.update(ref,{status:decision,reviewedText:text,reviewedAt:fs.serverTimestamp(),...(item.kind==='video'&&decision==='approved'?{videoReviewed:true}:{})})
 })
}
// Decode and re-encode pixels: no original filename, EXIF, SVG or GPS metadata is saved.
export async function prepareContributionPhoto(file){
 if(!file||!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>10000000)throw Error('Choose a JPEG, PNG or WebP photo under 10 MB.')
 const url=URL.createObjectURL(file)
 try{const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('This photo could not be opened.'));image.src=url})
  for(const side of [1000,750,500]){const ratio=Math.min(1,side/Math.max(image.naturalWidth,image.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);for(const quality of [.8,.6,.4]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<=350000)return data}}
  throw Error('This photo is too large. Choose a smaller photo.')
 }finally{URL.revokeObjectURL(url)}
}
