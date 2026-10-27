import {draftContribution} from './family-contributions-model.mjs'
const PART=500000,MAX=3000000
function idCheck(id){if(typeof id!=='string'||!id||id.includes('/'))throw Error('Invalid contribution reference.')}
function magic(bytes,mime){return mime==='video/webm'?bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163:bytes.length>=12&&String.fromCharCode(...bytes.slice(4,8))==='ftyp'}
export function packVideo(bytes,mime,duration){
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>MAX||!['video/mp4','video/webm'].includes(mime)||!Number.isFinite(duration)||duration<=0||duration>60||!magic(bytes,mime))throw Error('Choose a playable MP4 or WebM clip, up to 3 MB and 60 seconds.')
 let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));const data=btoa(binary),parts=[];for(let at=0;at<data.length;at+=PART)parts.push(data.slice(at,at+PART))
 return{meta:{mime,bytes:bytes.length,duration,chunks:parts.length,length:data.length},parts}
}
export function validateVideo(video){
 const m=video?.meta,p=video?.parts
 if(!m||Object.keys(m).sort().join(',')!=='bytes,chunks,duration,length,mime'||!['video/mp4','video/webm'].includes(m.mime)||!Number.isInteger(m.bytes)||m.bytes<1||m.bytes>MAX||!Number.isFinite(m.duration)||m.duration<=0||m.duration>60||!Number.isInteger(m.length)||m.length!==4*Math.ceil(m.bytes/3)||!Array.isArray(p)||!Number.isInteger(m.chunks)||m.chunks<1||m.chunks>8||p.length!==m.chunks||m.chunks!==Math.ceil(m.length/PART)||p.some((part,i)=>typeof part!=='string'||!part||part.length!==(i===p.length-1?m.length-i*PART:PART)||!/^[A-Za-z0-9+/]+=*$/.test(part)))throw Error('The video data is incomplete or too large. Select the clip again.')
 return video
}
export function videoBytes(video){validateVideo(video);const bytes=Uint8Array.from(atob(video.parts.join('')),c=>c.charCodeAt(0));if(bytes.length!==video.meta.bytes||!magic(bytes,video.meta.mime))throw Error('This video is damaged or not a supported format.');return bytes}
export async function prepareVideo(file){
 if(!file||file.size<1||file.size>MAX||!['video/mp4','video/webm'].includes(file.type))throw Error('Choose MP4 or WebM, up to 3 MB and 60 seconds. Shorten or compress larger videos first.')
 const player=document.createElement('video');if(!player.canPlayType(file.type))throw Error('This browser cannot play that video format. Try MP4 or WebM in Chrome.');const url=URL.createObjectURL(file)
 try{player.preload='metadata';player.muted=true;const duration=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clean();reject(Error('Could not read this clip. Choose another file.'))},10000);function clean(){clearTimeout(timer);player.onloadedmetadata=null;player.onerror=null}player.onloadedmetadata=()=>{const seconds=player.duration;clean();resolve(seconds)};player.onerror=()=>{clean();reject(Error('This video could not be opened.'))};player.src=url});return packVideo(new Uint8Array(await file.arrayBuffer()),file.type,duration)}finally{player.pause();player.removeAttribute('src');player.load();URL.revokeObjectURL(url)}
}
export async function submitVideo(fs,db,id,target,uid,text,video){
 idCheck(id);validateVideo(video);videoBytes(video);const base=draftContribution(target,uid,text,'');const item={...base,kind:'video',video:video.meta}
 return fs.runTransaction(db,async tx=>{const ref=fs.doc(db,'family_contributions',id),old=await tx.get(ref)
  if(old.exists()){
   const previous=old.data();if(!['residentId','familyUid','seniorUid','text','kind','photo'].every(k=>previous[k]===item[k])||!Object.keys(video.meta).every(k=>previous.video?.[k]===video.meta[k]))throw Error('This reference belongs to another draft. Reload before starting again.')
   for(let i=0;i<video.parts.length;i++){const part=await tx.get(fs.doc(db,'family_contribution_media',id+'_'+i));if(!part.exists()||part.data().data!==video.parts[i])throw Error('The saved clip changed. Refresh before retrying.')}return
  }
  tx.set(ref,{...item,createdAt:fs.serverTimestamp()});video.parts.forEach((data,index)=>tx.set(fs.doc(db,'family_contribution_media',id+'_'+index),{contributionId:id,familyUid:target.familyUid,seniorUid:target.seniorUid,index,data,createdAt:fs.serverTimestamp()}))
 })
}
export async function loadVideo(fs,db,id,meta){idCheck(id);const rows=await Promise.all(Array.from({length:Math.min(8,meta.chunks)},(_,i)=>fs.getDocFromServer(fs.doc(db,'family_contribution_media',id+'_'+i))));if(rows.some(r=>!r.exists()))throw Error('This clip is unavailable. Refresh before trying again.');return new Blob([videoBytes({meta,parts:rows.map(r=>r.data().data)})],{type:meta.mime})}
export async function deleteContribution(fs,db,id,uid){idCheck(id);const ref=fs.doc(db,'family_contributions',id),snap=await fs.getDocFromServer(ref);if(!snap.exists())return;const item=snap.data();if(![item.seniorUid,item.familyUid].includes(uid))throw Error('This contribution is private.');const batch=fs.writeBatch(db);if(item.kind==='video'){for(let i=0;i<Math.min(8,item.video.chunks);i++)batch.delete(fs.doc(db,'family_contribution_media',id+'_'+i))}batch.delete(ref);await batch.commit()}
