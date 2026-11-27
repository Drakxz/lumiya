const test=require("node:test");
const assert=require("node:assert/strict");
const sharp=require("sharp");
const {createModeration,interpret,IMAGE_CATEGORIES}=require("../media-moderation/openai");
const {createProcessor,normalizeImage,frameBuffers,execBin}=require("../media-moderation/processor");
const {DatabaseSync}=require("node:sqlite");
const {createStore}=require("../media-moderation/store");
const {DEFAULT_RULES}=require("../media-moderation/store");
function result(flag=null,modality="image"){
  const categories=Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,k===flag]));
  return {id:"modr-test",model:"omni-moderation-latest",results:[{flagged:Boolean(flag),categories,category_scores:Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,k===flag?.toString()?0.99:0.001])),category_applied_input_types:Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,[modality]]))}]};
}
const rules={sexual:true,graphicViolence:true,hate:false,targetedHarassment:false,scams:false,personalData:false,allowGameWeapons:true};
test("official SDK uses moderation endpoint and real data URLs (mock HTTP, no API)",async()=>{
  const OpenAI=require("openai");let calls=0;
  const client=new OpenAI({apiKey:"test-key",maxRetries:0,fetch:async(url,options)=>{
    calls++;assert.match(String(url),/\/v1\/moderations$/);const body=JSON.parse(options.body);assert.equal(body.model,"omni-moderation-latest");assert.match(body.input[0].image_url.url,/^data:image\/jpeg;base64,/);return new Response(JSON.stringify(result()),{headers:{"content-type":"application/json"}});
  }});
  const processor=createProcessor({moderation:createModeration({client})});
  const image=await sharp({create:{width:20,height:20,channels:3,background:"white"}}).png().toBuffer();
  assert.equal((await processor.moderate(image,"image/png",{rules})).decision,"approved");assert.equal(calls,1);
});
test("real Sharp JPG, PNG and WEBP decoding; corrupt images reject",async()=>{
  for(const format of ["jpeg","png","webp"]){const data=await sharp({create:{width:24,height:24,channels:3,background:"white"}})[format]().toBuffer();assert.equal((await sharp(await normalizeImage(data)).metadata()).format,"jpeg");}
  await assert.rejects(normalizeImage(Buffer.from("corrupt")),/converter/);
});
test("regression: all default protections enabled still approve clean images and benign historical text",async()=>{
  let calls=0;
  const processor=createProcessor({moderation:createModeration({client:{moderations:{async create({input}){calls++;return result(null,typeof input==="string"?"text":"image");}}}})});
  const image=await sharp({create:{width:24,height:24,channels:3,background:"white"}}).png().toBuffer();
  const decision=await processor.moderate(image,"image/png",{rules:{...DEFAULT_RULES}},"Documentário histórico sobre nazismo");
  assert.equal(decision.decision,"approved");assert.equal(decision.requiresHumanReview,false);assert.equal(calls,2);
  assert.ok(decision.rawResults.length);assert.equal(decision.coverage.complete,true);
});
test("retry transient failures with backoff; permanent errors and secrets never escape",async()=>{
  for(const status of [429,503,401,400]){let calls=0;const waits=[];const api=createModeration({client:{moderations:{async create(){calls++;throw Object.assign(new Error("SECRET"),{status});}}},sleep:async n=>waits.push(n),random:()=>0});await assert.rejects(api.classify([],"image"),e=>!e.message.includes("SECRET"));assert.equal(calls,status===429||status===503?3:1);assert.ok(waits.every(n=>n>=500));}
  for(const name of ["APIConnectionError","APIConnectionTimeoutError"]){let calls=0;const api=createModeration({client:{moderations:{async create(){if(++calls===1)throw Object.assign(new Error("secret"),{name});return result();}}},sleep:async()=>{}});await api.classify([],"image");assert.equal(calls,2);}
});
test("missing key, absent results and missing image coverage fail closed",async()=>{
  await assert.rejects(createModeration({apiKey:""}).classify([],"image"),/OPENAI_API_KEY/);
  for(const response of [{results:[]},result(null,"text"),{results:[{}]}])await assert.rejects(createModeration({client:{moderations:{create:async()=>response}}}).classify([],"image"));
});
test("policy approves clean analyses even with unsupported legacy rules; incomplete coverage stays held",()=>{
  const r={...result().results[0],modality:"image"};assert.equal(interpret([r],rules).decision,"approved");
  assert.equal(interpret([r],{...rules,scams:true}).decision,"approved");assert.equal(interpret([r],rules,{complete:false}).decision,"review");
  const flagged={...result("sexual").results[0],modality:"image"};assert.equal(interpret([flagged],rules).decision,"blocked");
  flagged.category_applied_input_types.sexual=[];assert.equal(interpret([flagged],rules).decision,"review");
});
test("settings migrate model without deleting historical provider records",()=>{
  const db=new DatabaseSync(":memory:");try{const store=createStore(db),s=store.settings("g");store.saveSettings("g",{...s,enabled:true,visionModel:"gemini-legacy"});assert.equal(store.settings("g").visionModel,"omni-moderation-latest");assert.equal(store.settings("g").enabled,true);assert.equal(store.settings("g").rules.scams,true);}finally{db.close();}
});
test("real FFmpeg samples allowed local video and animated GIF across duration",async t=>{
  const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"opencode","moderation-test-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const ext of ["mp4","gif"]){const file=path.join(dir,`fixture.${ext}`);await execBin(require("ffmpeg-static"),["-v","error","-f","lavfi","-i","testsrc=size=64x64:rate=4","-t","2","-threads","1","-y",file]);const sampled=await frameBuffers(await fs.readFile(file),ext==="gif"?"image/gif":"video/mp4",10);assert.ok(sampled.frames.length>=3);assert.equal(sampled.complete,true);
    const allowed=createProcessor({moderation:createModeration({client:{moderations:{create:async()=>result()}}})});assert.equal((await allowed.moderate(await fs.readFile(file),ext==="gif"?"image/gif":"video/mp4",{rules,maxVideoSeconds:10})).decision,"approved");
    const processor=createProcessor({moderation:createModeration({client:{moderations:{create:async()=>result(ext==="mp4"?"sexual":null)}}})});const verdict=await processor.moderate(await fs.readFile(file),ext==="gif"?"image/gif":"video/mp4",{rules,maxVideoSeconds:10});assert.equal(verdict.decision,ext==="mp4"?"blocked":"approved");
  }
});
test("real video audio extraction, mocked transcription, incomplete sampling and conversion failure",async t=>{
  const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"opencode","moderation-audio-test-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"audio.mp4");await execBin(require("ffmpeg-static"),["-v","error","-f","lavfi","-i","color=c=white:s=64x64:r=4","-f","lavfi","-i","sine=frequency=440:sample_rate=16000","-t","2","-threads","1","-y",file]);
  const bytes=await fs.readFile(file),modalities=[];
  const moderation={configured:true,model:"omni-moderation-latest",transcribe:async file=>{assert.ok(file.size>0);return "mock transcription";},classify:async(input,modality)=>{modalities.push(modality);return {...result(null,modality).results[0],modality};}};
  const processor=createProcessor({moderation});
  const keys=["MEDIA_MODERATION_AUDIO_ENABLED","MEDIA_MODERATION_MAX_FRAMES","MEDIA_MODERATION_FRAME_INTERVAL_SECONDS","MEDIA_MODERATION_MAX_FRAME_GAP_SECONDS","MEDIA_MODERATION_REQUIRE_AUDIO"],previous=new Map(keys.map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,val] of previous)if(val===undefined)delete process.env[key];else process.env[key]=val;});
  process.env.MEDIA_MODERATION_REQUIRE_AUDIO="false";
  process.env.MEDIA_MODERATION_AUDIO_ENABLED="false";const visual=await processor.moderate(bytes,"video/mp4",{rules,maxVideoSeconds:10});assert.equal(visual.decision,"approved");assert.equal(visual.coverage.audio,"disabled");assert.match(visual.reason,/Áudio não analisado/);
  process.env.MEDIA_MODERATION_AUDIO_ENABLED="true";assert.equal((await processor.moderate(bytes,"video/mp4",{rules,maxVideoSeconds:10})).decision,"approved");assert.ok(modalities.includes("text"));assert.ok(modalities.includes("image"));
  process.env.MEDIA_MODERATION_MAX_FRAMES="3";process.env.MEDIA_MODERATION_FRAME_INTERVAL_SECONDS="0.25";process.env.MEDIA_MODERATION_MAX_FRAME_GAP_SECONDS="0.25";assert.equal((await processor.moderate(bytes,"video/mp4",{rules,maxVideoSeconds:10})).decision,"review");
  await assert.rejects(frameBuffers(Buffer.from("broken video"),"video/mp4",10));await assert.rejects(frameBuffers(bytes,"video/mp4",1),/Duração/);
});
test("streaming download caps bytes and rejects truncation and redirected SSRF",async t=>{
  const {downloadAttachment}=require("../media-moderation/processor"),previous=global.fetch;t.after(()=>{global.fetch=previous;});
  global.fetch=async()=>new Response("oversized");await assert.rejects(downloadAttachment("https://cdn.discordapp.com/a",3));
  let calls=0;global.fetch=async()=>{calls++;return new Response("short",{headers:{"content-length":"10"}});};await assert.rejects(downloadAttachment("https://cdn.discordapp.com/a",20));assert.equal(calls,3);
  global.fetch=async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/"}});await assert.rejects(downloadAttachment("https://cdn.discordapp.com/a",20),/Host/);
});
