const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const sharp=require("sharp");
const ffmpeg=require("ffmpeg-static");
const {execBin,frameBuffers,samplingPlan,createProcessor}=require("../media-moderation/processor");
const {DEFAULT_RULES}=require("../media-moderation/store");
const {IMAGE_CATEGORIES}=require("../media-moderation/openai");
function verdict(flag=null,modality="image"){
  return {modality,flagged:Boolean(flag),categories:Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,k===flag])),
    category_scores:Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,k===flag?0.99:0.001])),
    category_applied_input_types:Object.fromEntries(IMAGE_CATEGORIES.map(k=>[k,[modality]]))};
}
async function fixture(t){
  const keys=["MEDIA_MODERATION_AUDIO_ENABLED","MEDIA_MODERATION_REQUIRE_AUDIO","MEDIA_MODERATION_MAX_FRAMES","MEDIA_MODERATION_FRAME_INTERVAL_SECONDS","MEDIA_MODERATION_MAX_FRAME_GAP_SECONDS","MEDIA_MODERATION_SCENE_FRAMES"];
  const previous=new Map(keys.map(k=>[k,process.env[k]]));for(const key of keys)delete process.env[key];
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"opencode","video-moderation-regression-"));
  t.after(async()=>{for(const [key,val] of previous)if(val===undefined)delete process.env[key];else process.env[key]=val;await fs.rm(dir,{recursive:true,force:true});});
  const file=path.join(dir,"video.mp4");
  const settings={rules:{...DEFAULT_RULES},maxVideoSeconds:120};
  return {file,settings,async generate(duration=2,audio=true){
    const args=["-v","error","-f","lavfi","-i","color=c=white:s=64x64:r=4"];
    if(audio)args.push("-f","lavfi","-i","sine=frequency=440:sample_rate=16000");
    await execBin(ffmpeg,[...args,"-t",String(duration),"-threads","1","-pix_fmt","yuv420p","-y",file]);return fs.readFile(file);
  }};
}
test("regression: a real 60-second video with audio is automatically approved visually, not held by the 24-frame cap",async t=>{
  const f=await fixture(t),bytes=await f.generate(60);let calls=0;
  const p=createProcessor({moderation:{configured:true,model:"mock",async classify(){calls++;return verdict();},async transcribe(){assert.fail("Paid transcription must not be enabled implicitly");}}});
  const r=await p.moderate(bytes,"video/mp4",f.settings);assert.equal(r.decision,"approved");assert.equal(r.coverage.complete,true);assert.equal(r.coverage.visualComplete,true);assert.equal(r.coverage.audio,"disabled");
  assert.equal(r.coverage.endFrame,true);assert.ok(r.coverage.duration>=59);assert.ok(r.coverage.uniformFrames>=20);assert.ok(r.coverage.gapSeconds<=10);assert.ok(r.coverage.frames<r.coverage.sampledFrames);assert.equal(calls,r.coverage.frames);
});
test("audio can be explicitly required, while enabled transcription failures still fail closed",async t=>{
  const f=await fixture(t),bytes=await f.generate();
  const moderation={configured:true,model:"mock",classify:async()=>verdict(),transcribe:async()=>{throw new Error("mock transcription failure");}},p=createProcessor({moderation});
  process.env.MEDIA_MODERATION_REQUIRE_AUDIO="true";const r=await p.moderate(bytes,"video/mp4",f.settings);assert.equal(r.decision,"review");assert.equal(r.coverage.visualComplete,true);assert.match(r.reason,/áudio obrigatório/);
  process.env.MEDIA_MODERATION_AUDIO_ENABLED="true";await assert.rejects(p.moderate(bytes,"video/mp4",f.settings),/transcription failure/);
});
test("insufficient configured temporal coverage still requires review, with a precise reason",async t=>{
  const f=await fixture(t),bytes=await f.generate(8,false);process.env.MEDIA_MODERATION_MAX_FRAMES="3";process.env.MEDIA_MODERATION_MAX_FRAME_GAP_SECONDS="1";
  const p=createProcessor({moderation:{configured:true,model:"mock",classify:async()=>verdict()}}),r=await p.moderate(bytes,"video/mp4",f.settings);
  assert.equal(r.decision,"review");assert.equal(r.coverage.visualComplete,false);assert.ok(r.coverage.warnings.includes("interval_too_wide"));assert.match(r.reason,/intervalo excessivo/);
});
test("end-of-video sample catches a synthetic red marker classified as blocked by a mock (not real AI)",async t=>{
  const f=await fixture(t);await execBin(ffmpeg,["-v","error","-f","lavfi","-i","color=c=white:s=64x64:r=10:d=2.8","-f","lavfi","-i","color=c=red:s=64x64:r=10:d=0.2","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0[v]","-map","[v]","-threads","1","-pix_fmt","yuv420p","-y",f.file]);
  let redSeen=false;
  const p=createProcessor({moderation:{configured:true,model:"mock",async classify(input){
    const data=Buffer.from(input[0].image_url.url.split(",")[1],"base64"),stats=await sharp(data).stats();
    const red=stats.channels[0].mean>150&&stats.channels[1].mean<80;redSeen=redSeen||red;
    return verdict(red?"violence/graphic":null);
  }}});
  const r=await p.moderate(await fs.readFile(f.file),"video/mp4",f.settings);assert.equal(redSeen,true);assert.equal(r.decision,"blocked");assert.ok(r.categories.includes("violence/graphic"));
});
test("adaptive video plan covers the entire allowed duration without treating the target frame count as a failure",async t=>{
  await fixture(t);const plan=samplingPlan(120);assert.equal(plan.count,24);assert.equal(plan.gap,5);assert.ok(plan.gap<=plan.maxGap);
  const gif=samplingPlan(2,80);assert.equal(gif.gifComplete,false);
});
test("superficial video mode takes only 3 samples, never transcribes and does not claim full coverage",async t=>{
  const f=await fixture(t),bytes=await f.generate(4);
  process.env.MEDIA_MODERATION_AUDIO_ENABLED="true";
  const sampled=await frameBuffers(bytes,"video/mp4",120,{superficial:true,audio:true});
  assert.equal(sampled.frames.length,3);
  assert.equal(sampled.complete,false);
  assert.equal(sampled.audioBuffer,null);
  const p=createProcessor({moderation:{configured:true,model:"mock",classify:async()=>verdict(),
    transcribe:async()=>assert.fail("Superficial mode must never transcribe")}});
  const r=await p.moderate(bytes,"video/mp4",{...f.settings,superficial:true});
  assert.equal(r.decision,"review");
  assert.equal(r.coverage.sampledFrames,3);
  assert.equal(r.coverage.complete,false);
  assert.equal(r.coverage.audio,"disabled");
});
test("full Discord intake approves a benign audio/video mock result instead of creating a review case",async t=>{
  const f=await fixture(t),bytes=await f.generate(),{DatabaseSync}=require("node:sqlite"),{EventEmitter}=require("node:events"),{randomUUID}=require("node:crypto");
  const db=new DatabaseSync(":memory:"),client=new EventEmitter(),guildId=randomUUID(),sent=[];
  const previous=global.fetch;global.fetch=async()=>new Response(bytes);
  t.after(()=>{global.fetch=previous;db.close();});
  const guild={id:guildId,members:{fetch:async()=>({user:{bot:false}})}},channel={guildId,isTextBased:()=>true,async send(p){sent.push(p);return {id:"repost"};}};
  client.channels={fetch:async()=>channel};
  const moderationProcessor=createProcessor({moderation:{configured:true,model:"mock",classify:async()=>verdict()}});
  const system=require("../media-moderation")({client,db,registry:{register(){},preserveMessage(){}},moderationProcessor});
  const settings=system.store.settings(guildId);settings.enabled=true;system.store.saveSettings(guildId,settings);system.store.setChannel(guildId,"watched","channel",true);
  let deleted=false;await system.onMessage({id:randomUUID(),guild,guildId,channelId:"watched",author:{id:"user"},content:"",attachments:new Map([["video",{url:"https://cdn.discordapp.com/video.mp4",name:"video.mp4",contentType:"video/mp4",size:bytes.length}]]),async delete(){deleted=true;}});
  const row=db.prepare("SELECT * FROM media_moderation_cases").get();assert.equal(deleted,true);assert.equal(row.status,"approved");assert.equal(row.filePath,null);assert.equal(sent.length,1);assert.deepEqual(sent[0].files[0].attachment,bytes);
  assert.equal(JSON.parse(row.analysisData).coverage.audio,"disabled");assert.match(row.reason,/Áudio não analisado/);
});
