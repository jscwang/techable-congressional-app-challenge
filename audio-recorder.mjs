// Injectable controller: no dependency on browser SpeechRecognition.
export function createRecorder({Recorder,getMedia,transcribe,onState,onText,maxMs=60000,maxBytes=2*1024*1024,permissionMs=20000}) {
  let state='idle',generation=0,current=null
  const emit=s=>onState(s)
  const release=s=>{clearTimeout(s.timer);s.stream?.getTracks().forEach(t=>t.stop());s.stream=null}
  const cancel=()=>{
    generation++;state='idle'
    if(current){current.abort.abort();release(current);if(current.rec?.state==='recording')current.rec.stop();current=null}
    emit('idle')
  }
  async function start(){
    if(state!=='idle')return
    const s={id:++generation,abort:new AbortController(),chunks:[],size:0};current=s;state='starting';emit('starting')
    try {
      const media=getMedia()
      media.then(stream=>{if(s.id!==generation)stream.getTracks().forEach(t=>t.stop())},()=>{})
      s.stream=await Promise.race([media,new Promise((_,reject)=>{s.timer=setTimeout(()=>reject(Error('permission timeout')),permissionMs)})])
      clearTimeout(s.timer)
      if(s.id!==generation)return
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>Recorder.isTypeSupported(t))
      if(!mime)throw Error('unsupported recording')
      s.rec=new Recorder(s.stream,{mimeType:mime,audioBitsPerSecond:32000})
      s.rec.onstart=()=>{if(s.id!==generation)return;state='recording';emit('recording')}
      s.rec.ondataavailable=e=>{
        if(s.id!==generation || !e.data.size)return
        s.size+=e.data.size
        if(s.size>maxBytes){cancel();emit('too-large');return}
        s.chunks.push(e.data)
      }
      s.rec.onerror=()=>{if(s.id!==generation)return;cancel();emit('recording-error')}
      s.rec.onstop=async()=>{
        release(s)
        if(s.id!==generation)return
        state='transcribing';emit('transcribing')
        try{
          const blob=new Blob(s.chunks,{type:s.rec.mimeType})
          if(!blob.size){state='idle';emit('empty');return}
          const text=await transcribe(blob,s.abort.signal)
          if(s.id!==generation)return
          state='idle';current=null
          if(!text?.trim()){emit('empty');return}
          onText(text.trim());emit('review')
        }catch{if(s.id===generation){state='idle';current=null;emit('transcription-error')}}
      }
      s.rec.start(500)
      s.timer=setTimeout(finish,maxMs)
    }catch(err){
      release(s)
      if(s.id!==generation)return
      generation++;state='idle';current=null
      emit(err?.name==='NotAllowedError'?'permission-error':'recording-error')
    }
  }
  function finish(){if(state!=='recording')return;state='stopping';clearTimeout(current.timer);current.rec.stop()}
  return {start,finish,cancel,state:()=>state}
}
