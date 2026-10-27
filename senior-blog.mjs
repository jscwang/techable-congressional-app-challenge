import {bindDictation} from './field-dictation.mjs'
import {blogEntries,cleanBlogDraft} from './senior-actions-model.mjs'
const $=id=>document.getElementById(id),app=()=>window.TechableApp,context=()=>app()?.getSelected()?.id||''
let editingContext='',saving=false,uncertain=false
const voice=bindDictation({button:$('blog-dictate'),input:$('blog-text'),status:$('blog-status'),context})
function status(text){$('blog-status').textContent=text}
function reset(){voice.cancel();$('blog-id').value='';$('blog-title').value='';$('blog-text').value='';editingContext=context();status('')}
function button(label,action){const b=document.createElement('button');b.type='button';b.className='btn btn-s story-btn';b.textContent=label;b.addEventListener('click',action);return b}
function render(){
 const root=$('blog-entries');root.replaceChildren()
 const rows=blogEntries(app()?.getSelected()?.lifeStory)
 if(!rows.length){const p=document.createElement('p');p.textContent='No blog entries yet. Your first entry starts above.';root.append(p)}
 for(const entry of rows){const card=document.createElement('article');card.className='story-entry';const title=document.createElement('h3'),date=document.createElement('p'),text=document.createElement('p'),actions=document.createElement('div');title.textContent=entry.title;date.textContent=entry.createdAt?new Date(entry.createdAt).toLocaleDateString():'';text.className='story-text';text.textContent=entry.text;actions.className='story-btns'
  actions.append(button('Edit entry',()=>{if(saving||uncertain)return;reset();$('blog-id').value=entry.id;$('blog-title').value=entry.title;$('blog-text').value=entry.text;$('blog-title').focus()}),button('Remove entry',async()=>{if(saving||uncertain)return;voice.cancel();if(await app()._story.remove(entry.id)){if($('blog-id').value===entry.id)reset();render()}}));card.append(title,date,text,actions);root.append(card)
 }
}
function open(){window.switchTab('story');if(editingContext!==context())reset();render();$('personal-blog').scrollIntoView({block:'start'});$('blog-title-heading').focus()}
$('senior-blog-open').addEventListener('click',open)
$('blog-open-story').addEventListener('click',open)
$('blog-new').addEventListener('click',()=>{if(!saving&&!uncertain){reset();$('blog-title').focus()}})
$('blog-save').addEventListener('click',async()=>{
 if(saving||uncertain)return
 if(editingContext!==context()){reset();status('The selected profile changed. Please enter this person’s own words.');return}
 const draft=cleanBlogDraft({id:$('blog-id').value,title:$('blog-title').value,text:$('blog-text').value})
 if(!draft){status('Add a title (up to 120 characters) and your words (up to 4,000 characters).');return}
 voice.cancel();saving=true;for(const id of ['blog-save','blog-new','blog-dictate'])$(id).disabled=true;for(const id of ['blog-title','blog-text'])$(id).readOnly=true;status('Saving your entry…');let timer
 try{const result=await Promise.race([app()._story.saveBlog(draft),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),12000)})]);if(result){reset();render();status('Entry saved to your life story.')}else status('Your entry was not saved. Your words are still here; please retry.')}
 catch{uncertain=true;status('Could not confirm saving. Your words are still here. Refresh and check your entries before trying again.')}
 finally{clearTimeout(timer);saving=false;for(const id of ['blog-save','blog-new','blog-dictate'])$(id).disabled=uncertain;for(const id of ['blog-title','blog-text'])$(id).readOnly=false}
})
document.addEventListener('techable:ready',()=>{editingContext=context();render()})
document.addEventListener('click',event=>{if(event.target.closest('#senior-nav')||event.target.closest('.hub-tile'))voice.cancel()},true)
editingContext=context();render()
