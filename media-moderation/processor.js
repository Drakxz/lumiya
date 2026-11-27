const fs=require("node:fs/promises");
const path=require("node:path");
const os=require("node:os");
const {spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {createModeration,interpret}=require("./openai");
const {childSafetySignal}=require("./safety");
const sharp=require("sharp");
const {toFile}=require("openai");
const {setTimeout:delay}=require("node:timers/promises");
const {createLimiter}=require("./limits");
const limitDownloads=createLimiter(4,50);
const ffmpeg=require("ffmpeg-static");
const ffprobe=require("ffprobe-static").path;

const MIME_EXT={"image/png":"png","image/jpeg":"jpg","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm"};
const MAX_REDIRECTS=2;
const FRAME_SCALE="scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
function validateDecision(value){
  if(!value||!(["approved","blocked","review"].includes(value.decision))||typeof value.reason!=="string"||value.reason.length>500||!Array.isArray(value.categories)||value.categories.length>20||!value.categories.every(x=>typeof x==="string"&&x.length<80)||typeof value.requiresHumanReview!=="boolean"||!(value.confidence===null||Number.isFinite(value.confidence)&&value.confidence>=0&&value.confidence<=1))throw new Error("Resposta estruturada inválida");
  return value;
}
function execBin(bin,args,{timeout=30000,maxOutput=2*1024*1024}={}){return new Promise((resolve,reject)=>{
  if(!bin)return reject(new Error("Ferramenta de mídia indisponível"));
  const child=spawn(bin,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});let out="",err="",done=false;
  const timer=setTimeout(()=>{child.kill("SIGKILL");finish(new Error("Timeout ao processar mídia"));},timeout);timer.unref();
  function finish(error,result){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(result);}
  child.stdout.on("data",chunk=>{out+=chunk;if(out.length>maxOutput){child.kill("SIGKILL");finish(new Error("Saída excessiva do processador"));}});
  child.stderr.on("data",chunk=>{err+=chunk;if(err.length>maxOutput)err=err.slice(-maxOutput);});
  child.on("error",()=>finish(new Error("FFmpeg indisponível")));
  child.on("close",code=>code===0?finish(null,out):finish(new Error(`Falha no processamento de mídia (${code}): ${err.slice(-500)}`)));
});}
async function downloadOnce(url,maxBytes,target=null){
  let current=new URL(url);
  for(let redirect=0;redirect<=MAX_REDIRECTS;redirect++){
    if(current.protocol!=="https:"||current.username||current.password||current.port&&!['443'].includes(current.port)||!(/^(?:cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/i.test(current.hostname)))throw new Error("Host de anexo não permitido");
    const response=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(20000),headers:{"User-Agent":"MDS-Media-Moderation/1.0"}});
    if(response.status>=300&&response.status<400){await response.body?.cancel();if(redirect===MAX_REDIRECTS)throw new Error("Redirecionamentos excessivos");const location=response.headers.get("location");if(!location)throw new Error("Redirecionamento inválido");current=new URL(location,current);continue;}
    if(!response.ok){await response.body?.cancel();throw Object.assign(new Error(`Download de anexo falhou (${response.status})`),{transient:response.status===429||response.status>=500});}
    const length=Number(response.headers.get("content-length")||0);if(length>maxBytes){await response.body?.cancel();throw new Error("Arquivo excede o tamanho máximo");}
    const reader=response.body.getReader(),chunks=[];let total=0,file;
    try{
      if(target)file=await fs.open(target,"wx",0o600);
      while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>maxBytes)throw new Error("Arquivo excede o tamanho máximo");if(file)await file.writeFile(value);else chunks.push(Buffer.from(value));}
      if(!total||length&&total!==length)throw new Error("Download incompleto");
      return target||Buffer.concat(chunks,total);
    }catch(error){await reader.cancel().catch(()=>{});if(file){await file.close();file=null;await fs.rm(target,{force:true}).catch(()=>{});}throw error;}
    finally{await file?.close();}
  }
  throw new Error("Download inválido");
}
function downloadAttachment(url,maxBytes,target=null){return limitDownloads(async()=>{
  for(let attempt=0;;attempt++)try{return await downloadOnce(url,maxBytes,target);}catch(error){
    if(attempt>=2||!(error.transient||["TimeoutError","AbortError","TypeError"].includes(error.name)||/Download incompleto/.test(error.message)))throw new Error("Não foi possível capturar o anexo: "+(/Host de anexo/.test(error.message)?"Host de anexo não permitido":"download inválido, indisponível ou fora dos limites"));
    await delay(300*2**attempt+Math.random()*200);
  }
});}
function imageMime(type){return type?.mime&&MIME_EXT[type.mime]&&!type.mime.startsWith("video/")?type.mime:null;}
function samplingPlan(duration,gifPages=0){
  const interval=Math.max(.25,Math.min(10,Number(process.env.MEDIA_MODERATION_FRAME_INTERVAL_SECONDS)||2));
  const maxFrames=Math.max(3,Math.min(64,Number(process.env.MEDIA_MODERATION_MAX_FRAMES)||24));
  const maxGap=Math.max(.25,Math.min(30,Number(process.env.MEDIA_MODERATION_MAX_FRAME_GAP_SECONDS)||10));
  const desired=Math.max(3,gifPages,Math.ceil(duration/interval));
  const count=Math.min(maxFrames,desired),gap=duration/count;
  return {count,maxFrames,gap,maxGap,gifComplete:!gifPages||gifPages<=maxFrames};
}
async function frameBuffers(buffer,mime,maxSeconds,{audio=false,superficial=false}={}){
  if(!ffmpeg||!ffprobe)throw new Error("FFmpeg/ffprobe indisponível");
  const root=process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir();
  const dir=await fs.mkdtemp(path.join(root,"mds-media-"));const input=path.join(dir,`input.${MIME_EXT[mime]}`);
  try{
    await fs.writeFile(input,buffer,{flag:"wx",mode:0o600});
    const info=JSON.parse(await execBin(ffprobe,["-v","error","-protocol_whitelist","file,pipe","-show_entries","format=duration:stream=codec_type,width,height,duration","-of","json",input],{timeout:15000,maxOutput:65536}));
    const video=info.streams?.find(s=>s.codec_type==="video");
    if(!video||!Number.isFinite(video.width*video.height)||video.width*video.height<=0||video.width*video.height>40000000)throw new Error("Dimensões de vídeo inválidas");
    const formatDuration=Number(info.format?.duration);
    let duration=Number(video.duration)||formatDuration,gifPages=0;
    if(mime==="image/gif"){const metadata=await sharp(buffer,{limitInputPixels:40000000}).metadata();gifPages=metadata.pages||1;duration=(metadata.delay||[]).reduce((sum,ms)=>sum+Math.max(10,ms),0)/1000;if(gifPages===1)return {frames:[await normalizeImage(buffer)],duration:0,complete:true,hasAudio:false,coverage:{method:"static-gif",warnings:[]}};}
    if(!Number.isFinite(duration)||duration<=0||duration>maxSeconds||Number.isFinite(formatDuration)&&formatDuration>maxSeconds)throw Object.assign(new Error("Duração inválida ou acima do limite; requer revisão"),{kind:"video_duration"});
    if(superficial){
      const frames=[];
      for(const [index,at] of [0,duration/2,Math.max(0,duration-.5)].entries()){
        const target=path.join(dir,`quick-${index}.jpg`);
        await execBin(ffmpeg,["-nostdin","-v","error","-threads","1","-protocol_whitelist","file,pipe","-ss",String(at),"-i",input,"-vf",FRAME_SCALE,"-frames:v","1","-threads","1","-y",target],{timeout:15000,maxOutput:65536});
        frames.push(await fs.readFile(target));
      }
      return {frames,duration,complete:false,hasAudio:info.streams.some(s=>s.codec_type==="audio"),audioBuffer:null,
        coverage:{method:"superficial-three-samples",duration,warnings:["superficial_sampling"]}};
    }
    const plan=samplingPlan(duration,gifPages),{count,maxFrames}=plan;const pattern=path.join(dir,"frame-%03d.jpg");
    const base=["-nostdin","-v","error","-threads","1","-protocol_whitelist","file,pipe","-i",input];
    const filter=gifPages&&gifPages<=maxFrames?FRAME_SCALE:`fps=${count}/${duration}:round=up,${FRAME_SCALE}`;
    await execBin(ffmpeg,[...base,"-vf",filter,"-fps_mode","vfr","-frames:v",String(count),"-threads","1","-y",pattern],{timeout:60000,maxOutput:65536});
    const sceneLimit=Math.max(1,Math.min(32,Number(process.env.MEDIA_MODERATION_SCENE_FRAMES)||16));
    await execBin(ffmpeg,[...base,"-vf",`select='gt(scene,0.3)',${FRAME_SCALE}`,"-fps_mode","vfr","-frames:v",String(sceneLimit+1),"-threads","1","-y",path.join(dir,"scene-%03d.jpg")],{timeout:60000,maxOutput:65536});
    const files=(await fs.readdir(dir)).filter(name=>/^frame-\d+\.jpg$/.test(name)).sort();
    if(files.length<Math.min(3,gifPages||3))throw new Error("Amostragem insuficiente do vídeo; requer revisão");
    const scenes=(await fs.readdir(dir)).filter(name=>/^scene-\d+\.jpg$/.test(name)).sort();
    // Explicit end coverage in addition to uniform samples and scene changes.
    if(!gifPages)await execBin(ffmpeg,["-nostdin","-v","error","-threads","1","-protocol_whitelist","file,pipe","-ss",String(Math.max(0,duration-1)),"-i",input,"-vf",`${FRAME_SCALE},fps=12:round=up,reverse`,"-frames:v","1","-threads","1","-y",path.join(dir,"end.jpg")],{timeout:30000,maxOutput:65536});
    const endPresent=!gifPages&&(await fs.readdir(dir)).includes("end.jpg");
    const warnings=[];
    if(!plan.gifComplete)warnings.push("gif_frame_limit");
    if(files.length<(gifPages&&gifPages<=maxFrames?gifPages:Math.max(3,Math.floor(count*.8))))warnings.push("uniform_frames_missing");
    if(plan.gap>plan.maxGap)warnings.push("interval_too_wide");
    const sceneOverflow=scenes.length>sceneLimit;
    // Scene frames supplement uniform coverage. A capped scene list is not a
    // failure when the full timeline already has dense (<=2s) uniform samples.
    if(sceneOverflow&&plan.gap>Math.min(2,plan.maxGap))warnings.push("scene_sampling_limited");
    if(!gifPages&&!endPresent)warnings.push("end_frame_missing");
    let audioBuffer=null;const hasAudio=info.streams.some(s=>s.codec_type==="audio");
    if(audio&&hasAudio){const target=path.join(dir,"audio.mp3");await execBin(ffmpeg,[...base,"-vn","-ac","1","-ar","16000","-b:a","32k","-y",target],{timeout:60000,maxOutput:65536});audioBuffer=await fs.readFile(target);if(audioBuffer.length>20*1024*1024)throw new Error("Áudio excede limite");}
    return {frames:await Promise.all([...files,...scenes.slice(0,sceneLimit),...(endPresent?["end.jpg"]:[])].map(name=>fs.readFile(path.join(dir,name)))),duration,complete:!warnings.length,hasAudio,audioBuffer,
      coverage:{method:gifPages?"gif-frames":"uniform-scenes-end",duration,uniformFrames:files.length,sceneFrames:Math.min(scenes.length,sceneLimit),sceneOverflow,endFrame:endPresent,gapSeconds:plan.gap,maxGapSeconds:plan.maxGap,warnings}};
  }finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function normalizeImage(buffer,maxSize=2048){
  try{
    const image=sharp(buffer,{limitInputPixels:40000000,failOn:"warning"});
    const metadata=await image.metadata();if((metadata.pages||1)>1)throw new Error("Imagem animada não normalizada integralmente");
    const data=await image.rotate().resize({width:maxSize,height:maxSize,fit:"inside",withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
    if(data.length>20*1024*1024)throw new Error("Imagem excede limite");return data;
  }catch{throw new Error("Falha ao decodificar ou converter imagem; revisão necessária");}
}
function createProcessor({moderation=createModeration()}={}){
  async function moderate(buffer,mime,settings,caption=""){
    if(childSafetySignal(caption))throw Object.assign(new Error("Sinalização de segurança infantil; procedimento especializado, sem envio à API"),{kind:"child_safety"});
    if(!moderation.configured)throw Object.assign(new Error("OPENAI_API_KEY não configurada"),{kind:"configuration"});
    const start=Date.now(),results=[];let images,complete=true,coverage={method:"static-image",audio:"not-applicable",warnings:[]};
    if(mime==="image/gif"||mime.startsWith("video/")){
      const sampled=await frameBuffers(buffer,mime,settings.maxVideoSeconds,{audio:!settings.superficial&&process.env.MEDIA_MODERATION_AUDIO_ENABLED==="true",superficial:settings.superficial===true});
      images=sampled.frames;complete=sampled.complete;coverage={...sampled.coverage,audio:sampled.hasAudio?(sampled.audioBuffer?"pending":"disabled"):"absent"};
      if(sampled.hasAudio){
        if(sampled.audioBuffer){const transcript=await moderation.transcribe(await toFile(sampled.audioBuffer,"audio.mp3"),settings.onRequest);if(childSafetySignal(transcript))throw Object.assign(new Error("Sinalização de segurança infantil na transcrição; procedimento especializado"),{kind:"child_safety"});if(transcript.trim())results.push(await moderation.classify(transcript,"text",settings.onRequest));coverage.audio=transcript.trim()?"transcribed-and-moderated":"transcribed-empty";}
        else if(!settings.superficial&&process.env.MEDIA_MODERATION_REQUIRE_AUDIO==="true"){complete=false;coverage.warnings.push("audio_required_but_disabled");}
      }
    }else images=[await normalizeImage(buffer,settings.superficial?768:2048)];
    const sampledFrames=images.length;
    images=[...new Map(images.map(image=>[createHash("sha256").update(image).digest("hex"),image])).values()];
    for(const image of images)results.push(await moderation.classify([{type:"image_url",image_url:{url:`data:image/jpeg;base64,${image.toString("base64")}`}}],"image",settings.onRequest));
    if(caption.trim())results.push(await moderation.classify(caption,"text",settings.onRequest));
    const decision=interpret(results,settings.rules,{complete});
    const warningLabels={gif_frame_limit:"limite de quadros do GIF",uniform_frames_missing:"quadros esperados ausentes",interval_too_wide:"intervalo excessivo entre amostras",scene_sampling_limited:"cenas numerosas sem cobertura suficiente",end_frame_missing:"não foi possível analisar o final do vídeo",audio_required_but_disabled:"áudio obrigatório, mas transcrição desativada"};
    if(decision.decision==="review"&&!complete)decision.reason=`Análise incompleta: ${coverage.warnings.map(w=>warningLabels[w]||"cobertura visual insuficiente").join(", ")}. Revisão necessária.`;
    if(decision.decision==="approved"&&coverage.audio==="disabled")decision.reason="Análise visual por amostragem concluída sem violação. Áudio não analisado (desativado).";
    return {...decision,analysisMs:Date.now()-start,coverage:{...coverage,complete,visualComplete:!coverage.warnings.some(w=>w!=="audio_required_but_disabled"),sampledFrames,frames:images.length},model:moderation.model};
  }
  return {configured:moderation.configured,model:moderation.model,moderate};
}
module.exports={createProcessor,downloadAttachment,validateDecision,frameBuffers,MIME_EXT,imageMime,normalizeImage,execBin,samplingPlan};
