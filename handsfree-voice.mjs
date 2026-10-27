import {createRecorder} from './audio-recorder.mjs'
// Speech energy followed by silence ends one recording; silence alone is discarded.
export function createSilenceGate({quietMs=1800,waitMs=12000,threshold=.025}={}){
 let voicedAt=null,lastVoice=null,heard=false
 return{sample(level,ms){
  if(level>=threshold){if(voicedAt===null)voicedAt=ms;if(ms-voicedAt>=200)heard=true;lastVoice=ms}
  else{voicedAt=null;if(heard&&ms-lastVoice>=quietMs)return 'finish'}
  return !heard&&ms>=waitMs?'empty':'wait'
 }}
}
export function createHandsfreeVoice({transcribe,onText,onState,media=globalThis.navigator?.mediaDevices,Recorder=globalThis.MediaRecorder,Context=globalThis.AudioContext||globalThis.webkitAudioContext,setLoop=setInterval,clearLoop=clearInterval,now=()=>performance.now()}={}){
 let context,source,loop,started=0,gate,analyser,recorder,generation=0
 function stopMonitor(){clearLoop(loop);loop=undefined;try{source?.disconnect()}catch{}source=null;analyser=null;const old=context;context=null;try{void old?.close()?.catch(()=>{})}catch{}}
 function cancel(){generation++;recorder?.cancel();stopMonitor()}
 async function start(){
  cancel();const at=generation
  if(!Recorder||!Context||!media?.getUserMedia){onState('unsupported');return}
  let resumeTimer
  try{context=new Context();await Promise.race([context.resume(),new Promise((_,reject)=>{resumeTimer=setTimeout(()=>reject(Error('Audio unavailable')),5000)})])}catch{if(at===generation){stopMonitor();onState('recording-error')}return}finally{clearTimeout(resumeTimer)}
  if(at!==generation)return
  recorder=createRecorder({Recorder,maxMs:30000,transcribe,
   getMedia:async()=>{
    const stream=await media.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false})
    if(at!==generation||!context){stream.getTracks().forEach(t=>t.stop());throw Error('Cancelled')}
    try{source=context.createMediaStreamSource(stream);analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);return stream}
    catch(error){stream.getTracks().forEach(t=>t.stop());throw error}
   },onText:text=>{if(at===generation)onText(text)},onState:state=>{
    if(at!==generation)return
    if(state==='recording'){
     gate=createSilenceGate();started=now();const samples=new Float32Array(analyser.fftSize)
     loop=setLoop(()=>{if(!analyser)return;analyser.getFloatTimeDomainData(samples);const rms=Math.sqrt(samples.reduce((sum,v)=>sum+v*v,0)/samples.length),action=gate.sample(rms,now()-started);if(action==='finish')recorder.finish();else if(action==='empty'){cancel();onState('no-speech')}},100)
    }
    if(!['starting','recording'].includes(state))stopMonitor()
    onState(state)
   }})
  await recorder.start()
 }
 return{start,cancel,state:()=>recorder?.state()||'idle'}
}
