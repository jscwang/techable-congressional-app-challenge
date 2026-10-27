const nav=document.getElementById('senior-nav')
if(nav&&!document.getElementById('center-directory-nav')){
  const button=document.createElement('button');button.type='button';button.className='sn-item';button.id='center-directory-nav'
  const icon=document.createElement('span');icon.className='sn-ico';icon.textContent='🏘️';icon.setAttribute('aria-hidden','true')
  const label=document.createElement('span');label.className='sn-lbl';label.textContent='Centers';button.append(icon,label)
  button.addEventListener('click',()=>{window.TechableApp?.pauseChatAudio?.();window.location.href='/senior-centers.html'});nav.append(button)
}
