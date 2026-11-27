const fs=require("node:fs/promises");
const path=require("node:path");
const {spawn}=require("node:child_process");
const {randomBytes,createCipheriv,createDecipheriv}=require("node:crypto");

function dpapi(value,decrypt=false){
  if(process.platform!=="win32")return Promise.reject(new Error("O cofre de tokens requer Windows (DPAPI)."));
  const input=decrypt?'[Convert]::FromBase64String($inputData)':'[Text.Encoding]::UTF8.GetBytes($inputData)';
  const operation=decrypt?"Unprotect":"Protect";
  const output=decrypt?'[Text.Encoding]::UTF8.GetString($bytes)':'[Convert]::ToBase64String($bytes)';
  const script=`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $inputData=[Console]::In.ReadToEnd(); $bytes=[Security.Cryptography.ProtectedData]::${operation}(${input},$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write(${output})`;
  return new Promise((resolve,reject)=>{
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let out="",size=0,done=false;
    const timeout=setTimeout(()=>{child.kill();finish(new Error("Tempo limite do cofre de credenciais."));},15000);
    function finish(error){if(done)return;done=true;clearTimeout(timeout);error?reject(error):resolve(out);}
    child.stdout.on("data",data=>{size+=data.length;if(size>1024*1024){child.kill();finish(new Error("Resposta inválida do cofre."));}else out+=data.toString("utf8");});
    // Não exibe stderr: mensagens do PowerShell podem conter dados sensíveis.
    child.stderr.resume();
    child.on("error",()=>finish(new Error("Não foi possível abrir o cofre do Windows.")));
    child.on("close",code=>finish(code===0?null:new Error("Não foi possível acessar o cofre. Use o mesmo usuário do Windows que salvou os tokens.")));
    child.stdin.on("error",()=>{});
    child.stdin.end(value);
  });
}
async function portable(value,decrypt=false,keyFile){
  if(!keyFile)throw new Error("Caminho da chave do cofre não configurado.");
  let key;
  try{key=await fs.readFile(keyFile);}
  catch(error){
    if(error.code!=="ENOENT"||decrypt)throw error;
    await fs.mkdir(path.dirname(keyFile),{recursive:true,mode:0o700});
    try{await fs.writeFile(keyFile,randomBytes(32),{mode:0o600,flag:"wx"});}
    catch(writeError){if(writeError.code!=="EEXIST")throw writeError;}
    key=await fs.readFile(keyFile);
  }
  if(key.length!==32)throw new Error("Chave inválida do cofre.");
  if(decrypt){
    const envelope=JSON.parse(value);
    if(envelope.version!==1||envelope.algorithm!=="aes-256-gcm")throw new Error("Formato inválido do cofre.");
    const iv=Buffer.from(envelope.iv,"base64"),tag=Buffer.from(envelope.tag,"base64");
    if(iv.length!==12||tag.length!==16)throw new Error("Formato inválido do cofre.");
    const cipher=createDecipheriv("aes-256-gcm",key,iv);
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(envelope.data,"base64")),cipher.final()]).toString("utf8");
  }
  const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);
  const data=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return JSON.stringify({version:1,algorithm:"aes-256-gcm",iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:data.toString("base64")});
}
function createStore(filename,options={}){
  const keyFile=options.keyFile||process.env.CALL_PANEL_KEY_FILE||path.join(path.dirname(filename),"call-vault.key");
  const crypt=(value,decrypt=false)=>process.platform==="win32"?dpapi(value,decrypt):portable(value,decrypt,keyFile);
  const {protect=value=>crypt(value),unprotect=value=>crypt(value,true)}=options;
  return {
    async load(){
      let encrypted;
      try{encrypted=await fs.readFile(filename,"utf8");}catch(error){if(error.code==="ENOENT")return [];throw error;}
      const accounts=JSON.parse(await unprotect(encrypted));
      if(!Array.isArray(accounts))throw new Error("Cofre inválido.");
      return accounts;
    },
    async save(accounts){
      const encrypted=await protect(JSON.stringify(accounts));
      await fs.mkdir(path.dirname(filename),{recursive:true});
      const temporary=`${filename}.tmp`;
      try{await fs.writeFile(temporary,encrypted,{mode:0o600});await fs.rename(temporary,filename);}
      finally{await fs.unlink(temporary).catch(()=>{});}
    }
  };
}
module.exports={createStore,dpapi,portable};
