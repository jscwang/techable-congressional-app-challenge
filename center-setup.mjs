const value=(center,key)=>typeof center?.[key]==='string'?center[key].trim():''
const fields=[['name','Center name',120],['address','Street address',300],['city','City',120],['contactPersonName','Contact person name',120],['contactPersonTitle','Contact person title',80],['contactEmail','Contact email',254],['phone','Phone',40]]
export function centerDetailsIssues(center){
 const issues=fields.filter(([key,,max])=>{const text=value(center,key);return !text||text.length>max||/[\u0000-\u001f\u007f]/.test(text)}).map(([,label])=>label)
 if(!issues.includes('Contact email')&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value(center,'contactEmail')))issues.push('Contact email')
 const phone=value(center,'phone'),digits=phone.replace(/\D/g,'')
 if(!issues.includes('Phone')&&(!/^\+?[\d\s().-]+$/.test(phone)||digits.length<7||digits.length>15))issues.push('Phone')
 return issues
}
export function centerSetupState({user,centers=[],centersKnown=false,selectedId='',verificationStatus='',storageEnabled=false}={}){
 const owned=centersKnown&&user?centers.filter(c=>c.managerUid===user.uid):[],center=(selectedId?owned.find(c=>c.id===selectedId):owned[0])||null
 const issues=center?centerDetailsIssues(center):[],detailsReady=!!center&&!issues.length,complete=!!user&&detailsReady&&verificationStatus==='approved'&&center.verified===true
 let verification='Your verification status could not be confirmed. Refresh your status.',verificationLabel='Check status'
 if(verificationStatus==='approved'){
  verificationLabel=center?.verified===true?'Approved':center?'Center review needed':'Save center details'
  verification=center?.verified===true?(!detailsReady?'Your account and this center are approved. Complete the missing center details in Step 2.':center.isPublic===true?'Your account and this center are approved. This center is public.':'Your account and this center are approved. This center is private.'):center?'Your account is approved. This center still needs Techable review; saving its profile does not verify it.':'Your account is approved. Save your center details next; new centers need separate Techable review.'
 }else if(verificationStatus==='pending'){verificationLabel='In review';verification='Your documents are awaiting Techable review. You can return later to check the status.'}
 else if(verificationStatus==='rejected'){verificationLabel='Action needed';verification='Review Techable’s private note and submit updated documents when uploads are available.'}
 else if(verificationStatus==='not_submitted'){verificationLabel=storageEnabled?'Ready for documents':'Uploads unavailable';verification=storageEnabled?'Continue to upload organization documents for Techable review.':'Private document uploads are not configured for this QA preview. Your saved details are kept; check verification status for the next step.'}
 return{center,issues,complete,current:!user?1:!detailsReady?2:3,canOpenVerification:detailsReady,centersKnown,
  steps:[{title:'Account',status:user?'Complete':'Sign in',detail:user?'Signed in as a Community Manager.':'Create an account or sign in as a Community Manager.'},
   {title:'Center details',status:!centersKnown?'Checking':detailsReady?'Saved':center?'Needs details':'Not started',detail:!centersKnown?'Could not confirm your saved centers yet. Refresh setup before continuing.':center?(detailsReady?center.name+' — required details saved.':'Add or correct: '+issues.join(', ')+'.'):selectedId?'Choose one of your own saved centers to continue.':'Create your center profile, including a business contact.'},
   {title:'Verification',status:verificationLabel,detail:verification}]
 }
}
export function mountCenterSetup(root,state,{onDetails,onVerification,onRetry}={}){
 const document=root.ownerDocument||globalThis.document,el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node}
 root.replaceChildren();root.className='center-setup';root.append(el('h2','Center registration'),el('p','Save your center details, then continue to verification. Progress comes from your saved records.','setup-hint'))
 const list=el('ol',undefined,'setup-steps')
 state.steps.forEach((step,index)=>{const item=el('li',undefined,'setup-step');if(index+1===state.current)item.setAttribute('aria-current','step');item.append(el('h3',(index+1)+'. '+step.title),el('strong',step.status),el('p',step.detail));list.append(item)})
 root.append(list);const actions=el('div',undefined,'setup-actions')
 const action=(text,handler,primary=false)=>{if(!handler)return;const button=el('button',text,'setup-action'+(primary?' primary':''));button.type='button';button.addEventListener('click',handler);actions.append(button)}
 if(!state.centersKnown)action('Refresh setup',onRetry,true)
 else action(state.canOpenVerification?'Edit center details':'Continue center details',onDetails,state.current===2)
 if(state.canOpenVerification)action(state.complete?'View verification status':'Continue to verification',onVerification,state.current===3)
 root.append(actions)
}
