const sharp=require("sharp");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {randomUUID,createHash}=require("node:crypto");
const {fileTypeFromBuffer}=require("file-type");
const ffmpeg=require("ffmpeg-static");
const ffprobe=require("ffprobe-static").path;
const {execBin}=require("../media-moderation/processor");
const {fault}=require("./access");
const hash=buffer=>createHash("sha256").update(buffer).digest("hex");
const VIDEO_MIME={ "video/mp4":"mp4","video/quicktime":"mov","video/webm":"webm" };
async function sanitize(buffer,{filename,mimetype,maxBytes}){
  if(buffer.length>maxBytes)throw fault(413,"Fotografia acima do limite de tamanho.");
  const ext=path.extname(filename).toLowerCase();
  const detected=await (await import("file-type")).fileTypeFromBuffer(buffer);
  const allowed={jpg:"image/jpeg",png:"image/png",webp:"image/webp"};
  if(!detected||!allowed[detected.ext]||detected.mime!==mimetype||
    !({jpg:[".jpg",".jpeg"],png:[".png"],webp:[".webp"]}[detected.ext]||[]).includes(ext))throw fault(415,"Envie apenas JPG, PNG ou WebP estático.");
  try{
    const image=sharp(buffer,{limitInputPixels:25_000_000,failOn:"warning",animated:false});
    const meta=await image.metadata();
    if((meta.pages||1)>1||!meta.width||!meta.height||meta.width>12000||meta.height>12000)throw new Error();
    // rotate applies EXIF orientation; Sharp strips metadata unless explicitly retained.
    const {data,info}=await image.rotate().resize({width:4096,height:4096,fit:"inside",withoutEnlargement:true})
      .jpeg({quality:90,mozjpeg:true}).toBuffer({resolveWithObject:true});
    if(data.length>maxBytes)throw fault(413,"A imagem processada excede o limite.");
    return {buffer:data,filename:`${randomUUID()}.jpg`,hash:hash(data),bytes:data.length,width:info.width,height:info.height,kind:"image",mime:"image/jpeg",duration:0};
  }catch(e){if(e.statusCode)throw e;throw fault(415,"Fotografia inválida, animada ou com resolução excessiva.");}
}
async function sanitizeVideo(buffer,{filename,mimetype,maxBytes,maxSeconds}){
  if(buffer.length>maxBytes)throw fault(413,"Vídeo acima do limite de tamanho.");
  const detected=await fileTypeFromBuffer(buffer),ext=detected&&VIDEO_MIME[detected.mime];
  if(!ext||detected.mime!==mimetype||path.extname(filename).toLowerCase()!==`.${ext}`)throw fault(415,"Envie apenas MP4, MOV ou WebM.");
  const root=process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir();
  const dir=await fs.mkdtemp(path.join(root,"iw-video-"));
  const input=path.join(dir,`input.${ext}`),output=path.join(dir,`output.${ext}`);
  try{
    await fs.writeFile(input,buffer,{flag:"wx",mode:0o600});
    if(!ffmpeg||!ffprobe)throw fault(503,"Processamento de vídeo indisponível.");
    const info=JSON.parse(await execBin(ffprobe,["-v","error","-count_frames","-show_entries","format=duration:stream=codec_type,width,height,nb_read_frames,avg_frame_rate,duration","-of","json",input],{timeout:20000,maxOutput:65536}));
    const video=info.streams?.find(s=>s.codec_type==="video");
    const rate=String(video?.avg_frame_rate||"").split("/").map(Number);
    const frames=Number(video?.nb_read_frames)||0;
    const duration=Number(info.format?.duration)||Number(video?.duration)||
      (frames&&Number.isFinite(rate[0])&&rate[1]&&rate[0]>0?frames*rate[1]/rate[0]:0);
    if(!video||!Number.isFinite(video.width*video.height)||video.width*video.height<=0||video.width*video.height>40_000_000||
      !Number.isFinite(duration)||duration<=0||duration>maxSeconds)throw fault(415,"Vídeo inválido ou acima do limite de duração.");
    const args=["-nostdin","-v","error","-threads","1","-i",input,"-map","0:v:0","-map","0:a:0?","-c","copy","-map_metadata","-1"];
    if(ext==="mp4"||ext==="mov")args.push("-movflags","+faststart");
    await execBin(ffmpeg,[...args,"-y",output],{timeout:60000,maxOutput:65536});
    const data=await fs.readFile(output);
    if(!data.length||data.length>maxBytes)throw fault(413,"Vídeo processado acima do limite de tamanho.");
    return {buffer:data,filename:`${randomUUID()}.${ext}`,hash:hash(data),bytes:data.length,
      width:video.width,height:video.height,kind:"video",mime:detected.mime,duration:Math.round(duration*1000)};
  }catch(e){if(e.statusCode)throw e;throw fault(415,"Vídeo inválido, sem duração válida ou com metadados incompatíveis.");}
  finally{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});}
}
async function sanitizeAny(buffer,options){
  const kind=Object.keys(VIDEO_MIME).includes(options.mimetype)?"video":"image";
  return kind==="video"?sanitizeVideo(buffer,{...options,maxBytes:options.maxVideoBytes,maxSeconds:options.maxVideoSeconds}):sanitize(buffer,options);
}
module.exports={sanitize,sanitizeVideo,sanitizeAny,hash,
  async save(root,image){await fs.mkdir(root,{recursive:true,mode:0o700});await fs.writeFile(path.join(root,image.filename),image.buffer,{flag:"wx",mode:0o600});},
  async read(root,image){const data=await fs.readFile(path.join(root,image.filename));if(hash(data)!==image.hash)throw fault(409,"Integridade da fotografia inválida.");return data;},
  async remove(root,images){await Promise.all(images.map(i=>fs.unlink(path.join(root,i.filename)).catch(e=>{if(e.code!=="ENOENT")throw e;})));}};
