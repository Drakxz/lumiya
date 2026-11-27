const https=require("node:https");
const dns=require("node:dns/promises");
const net=require("node:net");
const {createHash}=require("node:crypto");
const sharp=require("sharp");
const MAX=5*1024*1024;
let processing=0;
let downloads=0;
const reservedIPv6=new net.BlockList();
for(const [address,prefix]of [["2001::",23],["2001:db8::",32],["2002::",16],["3ffe::",16],["3fff::",20]])
  reservedIPv6.addSubnet(address,prefix,"ipv6");
function publicIP(address){
  if(net.isIP(address)===4){
    const [a,b]=address.split(".").map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||
      a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51)||a===203&&b===0);
  }
  if(net.isIP(address)===6){
    const ip=address.toLowerCase();
    // Somente o espaço unicast global; exclui IPv4 mapeado, loopback,
    // local, multicast, documentação e mecanismos de tradução/túnel.
    return /^[23]/.test(ip)&&!reservedIPv6.check(ip,"ipv6");
  }
  return false;
}
function safeURL(input){
  let url;try{url=new URL(input);}catch{throw new Error("Informe uma URL HTTPS válida.");}
  if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443"||
    url.hostname.endsWith(".local")||url.hostname==="localhost")
    throw new Error("Use uma URL HTTPS pública, sem credenciais ou portas alternativas.");
  return url;
}
async function download(input,options={}){
  if(downloads>=4)throw new Error("Há outras imagens sendo recebidas. Aguarde alguns segundos e tente novamente.");
  downloads++;
  try{return await downloadRequest(input,options);}finally{downloads--;}
}
async function downloadRequest(input,{lookup=dns.lookup,request=https.request,redirects=0}={}){
  const url=safeURL(input),host=url.hostname.replace(/^\[|\]$/g,"");
  let lookupTimer;
  const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await Promise.race([
    lookup(host,{all:true,verbatim:true}),
    new Promise((_,reject)=>{lookupTimer=setTimeout(()=>reject(new Error("Não foi possível resolver o endereço da imagem a tempo.")),10000);lookupTimer.unref?.();})
  ]).finally(()=>clearTimeout(lookupTimer));
  if(!addresses.length||addresses.some(item=>!publicIP(item.address)))throw new Error("Endereços locais, privados ou reservados não são permitidos.");
  const selected=addresses[0];
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:"GET",headers:{"User-Agent":"Lumiya-Panel-Images/1.0","Accept":"image/png,image/jpeg,image/webp,image/gif"},
      lookup:(_host,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family)},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){
        res.resume();
        if(redirects>=3||!res.headers.location)return reject(new Error("Redirecionamento de imagem inválido."));
        return resolve(downloadRequest(new URL(res.headers.location,url).href,{lookup,request,redirects:redirects+1}));
      }
      if(res.statusCode!==200){res.resume();return reject(new Error(`Não foi possível baixar a imagem (HTTP ${res.statusCode}).`));}
      if(Number(res.headers["content-length"])>MAX){res.destroy();return reject(new Error("A imagem deve ter até 5 MB."));}
      let size=0;const chunks=[];
      res.on("data",chunk=>{size+=chunk.length;if(size>MAX){res.destroy();reject(new Error("A imagem deve ter até 5 MB."));}else chunks.push(chunk);});
      res.on("end",()=>{
        if(res.complete===false||res.headers["content-length"]!==undefined&&Number(res.headers["content-length"])!==size)
          return reject(new Error("A imagem foi recebida de forma incompleta."));
        resolve(Buffer.concat(chunks));
      });res.on("error",reject);
    });
    const timeout=setTimeout(()=>req.destroy(new Error("A imagem demorou demais para responder.")),15000);timeout.unref?.();
    req.on("close",()=>clearTimeout(timeout));req.on("error",reject);req.end();
  });
}
async function sanitize(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX)throw new Error("Envie uma imagem de até 5 MB.");
  const type=await (await import("file-type")).fileTypeFromBuffer(bytes);
  if(!type||!["image/png","image/jpeg","image/webp","image/gif"].includes(type.mime))throw new Error("Envie PNG, JPG, WebP ou GIF. SVG e arquivos disfarçados não são aceitos.");
  if(processing>=1)throw new Error("Outra imagem está sendo processada. Aguarde alguns segundos e tente novamente.");
  processing++;
  try{
    const image=sharp(bytes,{limitInputPixels:25_000_000,failOn:"warning",animated:false});
    const meta=await image.metadata();
    if(!meta.width||!meta.height||meta.width>10000||meta.height>10000)throw new Error();
    const clean=await image.rotate().resize({width:2560,height:2560,fit:"inside",withoutEnlargement:true}).png().toBuffer();
    if(clean.length>MAX)throw new Error();
    return {bytes:clean,mime:"image/png",hash:createHash("sha256").update(clean).digest("hex")};
  }catch{throw new Error("Imagem inválida ou com resolução excessiva. GIFs são convertidos para uma prévia estática.");}
  finally{processing--;}
}
module.exports={MAX,publicIP,safeURL,download,sanitize};
