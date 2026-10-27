import {requestProviderMembership} from './provider-memberships.mjs'
export function createProviderApplications({fs,db,user}){
 let rows=[],known=false,loading=null
 async function reload(){known=false;loading=(async()=>{const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'provider_connections'),fs.where('seniorUid','==',user.uid)));if(snap.metadata.fromCache||snap.metadata.hasPendingWrites)throw Error('Not confirmed');rows=snap.docs.map(d=>({...d.data(),id:d.id}));known=true})().catch(()=>{known=false});await loading}
 function mount(root,provider){
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n},box=el('section');box.style.marginTop='18px';root.append(box)
  function render(){box.replaceChildren();const item=rows.find(r=>r.providerUid===provider.id);box.append(el('p',!known?'Provider application status unavailable. Refresh to retry.':item?({pending:'Application sent - awaiting provider review.',approved:'Approved provider member.',declined:'Application declined. Withdraw it before applying again.'})[item.status]:'Apply to appear in this provider’s Applicants list. Only your name and application are shared.'))
   const action=el('button',item?'Withdraw application / membership':'Apply to this provider');action.type='button';action.className='secondary';action.disabled=!known;box.append(action)
   action.addEventListener('click',async()=>{action.disabled=true;try{
    if(item){if(!window.confirm('Withdraw this provider application or membership? Program subscriptions and separate care assignments are unchanged.'))return;await fs.deleteDoc(fs.doc(db,'provider_connections',user.uid+'_'+provider.id))}
    else{const snap=await fs.getDocsFromServer(fs.query(fs.collection(db,'residents'),fs.where('ownerUid','==',user.uid)));if(snap.metadata.fromCache||snap.metadata.hasPendingWrites||snap.docs.length!==1)throw Error('Open your companion to finish your own senior profile first.');const resident={...snap.docs[0].data(),id:snap.docs[0].id};if(!window.confirm('Apply to '+(provider.organisation||provider.displayName||'this provider')+'? Your name and application will appear in Applicants, and the provider can approve you into Members and send you private in-app announcements. This does not share your private profile, health records, chat history or memories.'))return;await requestProviderMembership(fs,db,{user,resident,provider,consented:true})}
    await reload();render()
   }catch(error){box.append(el('p',error.message||'Could not confirm this change. Refresh before retrying.'))}finally{action.disabled=false}})
  }
  if(loading)void loading.then(render);else render()
 }
 void reload();return{mount,reload}
}
