import * as fs from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js'
import {createProviderConnections} from './senior-actions-model.mjs'
import {createProviderApplications} from './provider-applications.mjs'
import {mountMemberInbox} from './member-news.mjs'
import {safeLink} from './announcements.js'
const $=id=>document.getElementById(id),selected=new URLSearchParams(location.search).get('provider')
let model,applications,currentUser,version=0
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function button(label,fn,cls='primary'){const b=node('button',label,cls);b.type='button';b.addEventListener('click',fn);return b}
function status(text){$('status').textContent=text||''}
function controls(p){
 const row=node('div',undefined,'button-row'),on=model.state.connected.has(p.id),locked=!model.state.known||model.state.busy.has(p.id)
 const connect=button(on?'Connected':'Connect',()=>change(p.id,true));connect.disabled=locked||on;connect.setAttribute('aria-label','Connect to '+name(p))
 const disconnect=button('Disconnect',()=>change(p.id,false),'disconnect');disconnect.disabled=locked||!on;disconnect.setAttribute('aria-label','Disconnect from '+name(p));row.append(connect,disconnect);return row
}
function name(p){return p.organisation||p.displayName||'Provider'}
async function change(id,on){const pending=on?model.connect(id):model.disconnect(id);render();try{await pending;status(on?'Connected. Open Programs & news to read this provider’s posts. Your private records are not shared.':'Disconnected. Your private records and care assignments are unchanged.')}catch{status('Could not confirm this change. The provider may no longer be available. Refresh to check before trying again.')}render()}
function render(){
 const root=$('content');root.replaceChildren();root.setAttribute('aria-busy','false')
 $('search-area').hidden=Boolean(selected)
 const list=model.state.providers.filter(p=>(!selected||p.id===selected)&&[p.displayName,p.organisation,p.providerType].join(' ').toLowerCase().includes($('search').value.trim().toLowerCase()))
 if(selected){const back=node('a','← All providers','back');back.href='senior-providers.html';root.append(back)}
 if(!list.length){root.append(node('p',selected?'This provider is unavailable. Return to the list or refresh.':model.state.known?'No providers are listed yet. Please check again later.':'Provider connections are unavailable. Refresh to retry.'));return}
 const grid=node('div',undefined,'center-grid')
 for(const p of list){const card=node('article',undefined,'center-card'+(model.state.known&&model.state.connected.has(p.id)?' connected':'')),link=node('a',name(p)+' →','center-name');link.href='senior-providers.html?provider='+encodeURIComponent(p.id);card.append(link);const body=node('div',undefined,'center-info');body.append(node('p',model.state.known?(model.state.connected.has(p.id)?'✓ Connected':'Not connected'):'Connection status unavailable','connection-state'));if(p.displayName)body.append(node('p',p.displayName));if(p.providerType)body.append(node('p',p.providerType));body.append(controls(p));applications.mount(body,p);if(!selected){const details=node('a','Programs & news','secondary');details.href=link.href;body.append(details)}card.append(body);grid.append(card)}root.append(grid)
 if(selected){const p=list[0],panel=node('section',undefined,'feature-panel');panel.append(node('h2','Programs & news'));if(!model.state.known||!model.state.connected.has(p.id)){panel.append(node('p','Connect to this provider to view its programs here.'));root.append(panel);return}const target=node('div','Loading programs…');panel.append(target);root.append(panel);void loadNews(p.id,target,++version)}
}
async function loadNews(id,target,v){
 try{const snap=await fs.getDocsFromServer(fs.query(fs.collection(window.TechableAuth.db,'announcements'),fs.where('authorUid','==',id),fs.orderBy('createdAt','desc'),fs.limit(40)));if(v!==version||!target.isConnected)return;target.replaceChildren();const rows=snap.docs.map(d=>d.data()).filter(d=>d.source==='provider');if(!rows.length)target.append(node('p','No programs have been posted by this provider yet.'));for(const r of rows){const article=node('article',undefined,'news-item');article.append(node('h3',r.title),node('p',r.body));const href=safeLink(r.link);if(href){const a=node('a','Read program details and application instructions','back');a.href=href;a.target='_blank';a.rel='noopener noreferrer';article.append(a)}target.append(article)}}catch{if(v===version&&target.isConnected)target.textContent='Could not load programs. Refresh to try again.'}
}
async function reload(){version++;$('refresh').disabled=true;status('Loading providers and your connections…');const inbox=mountMemberInbox($('provider-member-inbox'),{fs,db:window.TechableAuth.db,user:currentUser,providerOnly:true});try{await model.load();await applications.reload();status()}catch{status('Could not load providers or confirm your connections. Refresh to retry; no change is confirmed.')}finally{await inbox;$('refresh').disabled=false;render()}}
window.TechableAuth.guardRole(['resident'],user=>{currentUser=user;model=createProviderConnections({fs,db:window.TechableAuth.db,user});applications=createProviderApplications({fs,db:window.TechableAuth.db,user});$('refresh').addEventListener('click',reload);$('search').addEventListener('input',render);void reload()})
