// Directory memberships share only the name/request. Care-profile access is separate.
export const CONNECTION_CONSENT='2026-10-26-center-connection'
export function connectionConsent(name){return `Connect to ${name}? Your name and connection request will appear in this center’s Applicants list. Its manager can approve you into Members and send you member announcements. You can read news and sign in for visits while waiting. This does not share your private profile, health records, chat history or memories, or move you from another care center.`}
export async function requestConnection(fs,db,{user,resident,center,following=false,existing=null,consented=false}){
 if(!consented)throw Error('Please review and confirm your connection consent.')
 if(!user?.uid||!resident?.id||resident.ownerUid!==user.uid)throw Error('Open your companion to finish setting up your own profile first.')
 if(!center?.id||!center.managerUid||!center.verified||!center.isPublic)throw Error('This center is unavailable.')
 if(existing){if(!following||existing.seniorUid!==user.uid||existing.residentId!==resident.id||existing.communityId!==center.id)throw Error('Reload to check this connection.');if(existing.status==='declined')throw Error('Disconnect before sending a new request.');return existing}
 const item={seniorUid:user.uid,residentId:resident.id,seniorName:String(resident.name||resident.preferredName||'Senior').trim().slice(0,120),communityId:center.id,communityName:String(center.name||'').slice(0,200),managerUid:center.managerUid,status:'pending',consentVersion:CONNECTION_CONSENT,createdAt:fs.serverTimestamp()}
 const batch=fs.writeBatch(db)
 if(!following)batch.set(fs.doc(db,'follows',user.uid+'_'+center.id),{uid:user.uid,communityId:center.id,communityName:String(center.name||'').slice(0,120),createdAt:fs.serverTimestamp()})
 batch.set(fs.doc(db,'center_connections',user.uid+'_'+center.id),item);await batch.commit();return item
}
export async function withdrawConnection(fs,db,{user,center,following,existing}){
 const batch=fs.writeBatch(db);if(following)batch.delete(fs.doc(db,'follows',user.uid+'_'+center.id));if(existing)batch.delete(fs.doc(db,'center_connections',user.uid+'_'+center.id));await batch.commit()
}
export async function reviewConnection(fs,db,managerUid,id,decision){
 if(!['approved','declined'].includes(decision))throw Error('Choose Approve or Decline.')
 return fs.runTransaction(db,async tx=>{const ref=fs.doc(db,'center_connections',id),snap=await tx.get(ref);if(!snap.exists())throw Error('This connection was withdrawn. Refresh Applicants.');const row=snap.data();if(row.managerUid!==managerUid)throw Error('This is not your center’s request.');if(row.status===decision)return;if(row.status!=='pending')throw Error('This request has already been reviewed.');const follow=await tx.get(fs.doc(db,'follows',row.seniorUid+'_'+row.communityId));if(!follow.exists())throw Error('This senior has disconnected. Refresh Applicants.');tx.update(ref,{status:decision,reviewedBy:managerUid,reviewedAt:fs.serverTimestamp()})})
}
export function connectionMembers(rows,managerUid){
 const seen=new Set();return rows.filter(r=>r.managerUid===managerUid&&r.status==='approved').sort((a,b)=>String(a.id).localeCompare(String(b.id))).flatMap(r=>{if(seen.has(r.residentId))return [];seen.add(r.residentId);return[{id:r.residentId,ownerUid:r.seniorUid,name:r.seniorName,managerUid,communityId:r.communityId,communityName:r.communityName,status:'active',connectionId:r.id,connectionOnly:true}]})
}
