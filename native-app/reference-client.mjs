// Testa o contrato do app nativo sem depender do SDK ou de um app instalado.
// Uso: node native-app/reference-client.mjs --authorize
//      node native-app/reference-client.mjs --exchange <code> <verifier>
import {createHash,randomBytes} from "node:crypto";

const CLIENT_ID="1569908118698332191";
const SITE=process.env.SITE_URL||"https://3.12.169.220.nip.io";
const REDIRECT=`discord-${CLIENT_ID}:/authorize/callback`;

function verifier(){return randomBytes(32).toString("base64url");}
function challenge(value){return createHash("sha256").update(value).digest("base64url");}
function authorizeUrl(value){
  const url=new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id",CLIENT_ID);
  url.searchParams.set("redirect_uri",REDIRECT);
  url.searchParams.set("response_type","code");
  url.searchParams.set("scope","identify");
  url.searchParams.set("state",randomBytes(16).toString("base64url"));
  url.searchParams.set("code_challenge",challenge(value));
  url.searchParams.set("code_challenge_method","S256");
  return url.href;
}

const [mode,code,codeVerifier]=process.argv.slice(2);
if(mode==="--authorize"){
  const value=verifier();
  console.log("CODE_VERIFIER="+value);
  console.log(authorizeUrl(value));
}else if(mode==="--exchange"&&code&&codeVerifier){
  const response=await fetch(`${SITE}/api/auth/native/exchange`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({code,codeVerifier,redirectUri:REDIRECT})
  });
  const body=await response.text();
  console.log("HTTP",response.status,body);
  if(response.ok){const {url}=JSON.parse(body);console.log("Abra no navegador:",SITE+url);}
}else{
  console.log("Uso: --authorize | --exchange <code> <codeVerifier>");
  process.exitCode=1;
}
