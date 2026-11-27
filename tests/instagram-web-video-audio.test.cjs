const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const ffmpeg=require("ffmpeg-static");
const ffprobe=require("ffprobe-static").path;
const {execBin}=require("../media-moderation/processor");
const {sanitizeVideo}=require("../instagram-web/images");

for(const [ext,mime] of [["mp4","video/mp4"],["mov","video/quicktime"],["webm","video/webm"]]){
  for(const audio of [true,false]){
    test(`${ext} upload preserves ${audio?"audio":"silent video"} without re-encoding`,async()=>{
      const root=process.platform==="win32"?path.join(os.tmpdir(),"opencode"):os.tmpdir();
      const dir=await fs.mkdtemp(path.join(root,"iw-audio-test-"));
      try{
        const input=path.join(dir,`input.${ext}`),output=path.join(dir,`output.${ext}`);
        const args=["-nostdin","-v","error","-f","lavfi","-i","color=c=blue:s=160x120:d=0.6"];
        if(audio)args.push("-f","lavfi","-i","sine=frequency=440:duration=0.6");
        args.push("-c:v",ext==="webm"?"libvpx-vp9":"libx264");
        if(audio)args.push("-c:a",ext==="webm"?"libopus":"aac");
        await execBin(ffmpeg,[...args,"-y",input],{timeout:30000,maxOutput:65536});
        const result=await sanitizeVideo(await fs.readFile(input),{
          filename:`input.${ext}`,mimetype:mime,maxBytes:10*1024*1024,maxSeconds:10,
        });
        await fs.writeFile(output,result.buffer);
        const probe=async file=>JSON.parse(await execBin(ffprobe,[
          "-v","error","-show_streams","-show_packets","-show_data_hash","sha256","-of","json",file,
        ],{timeout:20000,maxOutput:1024*1024}));
        const before=await probe(input),after=await probe(output);
        assert.equal(after.streams.filter(s=>s.codec_type==="audio").length,audio?1:0);
        assert.equal(after.streams.filter(s=>s.codec_type==="video").length,1);
        for(const type of audio?["video","audio"]:["video"]){
          const original=before.streams.find(s=>s.codec_type===type);
          const preserved=after.streams.find(s=>s.codec_type===type);
          assert.equal(preserved.codec_name,original.codec_name);
          assert.deepEqual(
            after.packets.filter(p=>p.stream_index===preserved.index).map(p=>p.data_hash),
            before.packets.filter(p=>p.stream_index===original.index).map(p=>p.data_hash),
            `${type} packets must remain unchanged`,
          );
        }
      }finally{await fs.rm(dir,{recursive:true,force:true});}
    });
  }
}
