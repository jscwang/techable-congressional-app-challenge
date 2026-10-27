export const PROVIDER_MEMBERSHIP_CONSENT='2026-10-27-provider-membership'
export async function requestProviderMembership(fs,db,{user,resident,provider,consented=false}){
 if(!consented)throw Error('Review and confirm sharing your name with this provider first.')
 if(!user?.uid||!resident?.id||resident.ownerUid!==user.uid||!String(resident.name||'').trim()||!provider?.id)throw Error('Open your own senior profile before applying.')
 const item={seniorUid:user.uid,residentId:resident.id,seniorName:String(resident.name).slice(0,120),providerUid:provider.id,status:'pending',consentVersion:PROVIDER_MEMBERSHIP_CONSENT,createdAt:fs.serverTimestamp()}
 await fs.setDoc(fs.doc(db,'provider_connections',user.uid+'_'+provider.id),item);return item
}
export async function reviewProviderMembership(fs,db,providerUid,id,decision){
 if(!['approved','declined'].includes(decision))throw Error('Choose Approve or Decline.')
 return fs.runTransaction(db,async tx=>{const ref=fs.doc(db,'provider_connections',id),snap=await tx.get(ref);if(!snap.exists())throw Error('This application was withdrawn. Refresh Applicants.');const row=snap.data();if(row.providerUid!==providerUid||row.status!=='pending')throw Error('This application is no longer available to review.');tx.update(ref,{status:decision,reviewedBy:providerUid,reviewedAt:fs.serverTimestamp()})})
}
export function providerMembershipRows(rows,providerUid,status){return rows.filter(row=>row.providerUid===providerUid&&row.status===status).sort((a,b)=>String(a.seniorName).localeCompare(String(b.seniorName)))}
