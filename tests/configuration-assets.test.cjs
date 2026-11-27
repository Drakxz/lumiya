const test=require("node:test"),assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {PassThrough}=require("node:stream");
const {download,publicIP}=require("../configuration/assets");
function requestFactory({status=200,headers={},body=Buffer.from("image"),onOptions=()=>{}}={}){
  return (url,options,callback)=>{
    onOptions(url,options);
    const request=new EventEmitter();
    request.destroy=error=>{request.emit("error",error);request.emit("close");};
    request.end=()=>queueMicrotask(()=>{
      const response=new PassThrough();response.statusCode=status;response.headers=headers;
      callback(response);response.end(body);response.on("end",()=>request.emit("close"));
    });
    return request;
  };
}
test("URL downloader validates every address and pins the DNS answer used for TLS",async()=>{
  let lookups=0,pinned;
  const bytes=await download("https://public.example/image.png",{
    lookup:async()=>{lookups++;return [{address:"1.1.1.1",family:4}];},
    request:requestFactory({onOptions:(url,options)=>{
      assert.equal(url.protocol,"https:");
      options.lookup("public.example",{all:true},(_error,addresses)=>{pinned=addresses[0].address;});
    }})
  });
  assert.equal(bytes.toString(),"image");assert.equal(lookups,1);assert.equal(pinned,"1.1.1.1");
  await assert.rejects(()=>download("https://rebind.example/image",{
    lookup:async()=>[{address:"1.1.1.1",family:4},{address:"127.0.0.1",family:4}],
    request:()=>{throw new Error("must not connect");}
  }),/privados/);
});
test("redirects cannot reach metadata, localhost or alternative protocols",async()=>{
  for(const target of ["https://169.254.169.254/secret","https://[::ffff:127.0.0.1]/secret","http://public.example/image"]){
    await assert.rejects(()=>download("https://public.example/image",{
      lookup:async()=>[{address:"1.1.1.1",family:4}],
      request:requestFactory({status:302,headers:{location:target}})
    }));
  }
});
test("oversized, truncated and failed downloads are refused",async()=>{
  const lookup=async()=>[{address:"1.1.1.1",family:4}];
  await assert.rejects(()=>download("https://public.example/image",{lookup,request:requestFactory({headers:{"content-length":6*1024*1024}})}),/5 MB/);
  await assert.rejects(()=>download("https://public.example/image",{lookup,request:requestFactory({headers:{"content-length":100}})}),/incompleta/);
  await assert.rejects(()=>download("https://public.example/image",{lookup,request:requestFactory({status:404})}),/404/);
  for(const ip of ["2001:0000:0000::1","2001:db8:0::1","2002:7f00:1::","3fff::1"])assert.equal(publicIP(ip),false);
});
