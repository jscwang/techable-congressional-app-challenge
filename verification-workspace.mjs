const types={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
export function validateDocuments(files){
 if(!Array.isArray(files)||!files.length||files.length>10)throw Error('Choose between 1 and 10 documents.')
 return files.map(file=>{
  const ext=String(file.name||'').toLowerCase().split('.').at(-1),type=types[ext]
  if(!type||(file.type&&file.type!==type))throw Error('Use PDF, PNG, JPG, WebP, DOC or DOCX with the matching file type.')
  if(!Number.isFinite(file.size)||file.size<=0||file.size>10*1024*1024)throw Error('Each document must contain data and be 10 MB or smaller.')
  return{file,type}
 })
}
export function verificationRole(role){return role==='centre'?'community_manager':role==='provider'?'service_provider':role}
function eligible(profile,role){
 if(!profile||verificationRole(profile.role)!==role||!['community_manager','service_provider'].includes(role))throw Error('Only your manager or provider account can submit these documents.')
 if(!['not_submitted','rejected'].includes(profile.verificationStatus||'not_submitted'))throw Error('Your verification status changed or is already under review. Refresh before continuing.')
}
export async function submitDocuments({fs,db,user,role,files,upload,cleanup,isActive=()=>true}){
 const validated=validateDocuments(files),ref=fs.doc(db,'users',user.uid),snapshot=await fs.getDocFromServer(ref)
 if(!isActive())throw Error('Submission cancelled.')
 if(!snapshot.exists()||snapshot.metadata?.fromCache||snapshot.metadata?.hasPendingWrites)throw Error('Could not confirm your current account. Refresh and try again.')
 const before=snapshot.data();eligible(before,role)
 const documents=await upload(user,role,files,file=>validated.find(item=>item.file===file)?.type||'')
 try{
  if(!Array.isArray(documents)||documents.length!==files.length)throw Error('The complete document upload could not be confirmed.')
  if(!isActive())throw Error('Submission cancelled.')
  await fs.runTransaction(db,async transaction=>{
   const current=await transaction.get(ref)
   if(!current.exists())throw Error('Your account changed. Please sign in again.')
   const profile=current.data();eligible(profile,role)
   if((profile.verificationStatus||'not_submitted')!==(before.verificationStatus||'not_submitted')||!isActive())throw Error('Your verification status changed. Refresh before continuing.')
   transaction.update(ref,{verificationStatus:'pending',verificationDocumentCount:documents.length,verificationSubmittedAt:fs.serverTimestamp(),updatedAt:fs.serverTimestamp()})
  })
  return documents.length
 }catch(error){
  if(documents?.length)try{await cleanup(user,role,documents)}catch{throw Error('Submission was not confirmed and cleanup could not be completed. Contact Techable support before retrying.')}
  throw error
 }
}
