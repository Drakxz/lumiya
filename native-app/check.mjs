// Checks prerequisites only; passing this script is not a native build/test.
import {existsSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=fileURLToPath(new URL(".",import.meta.url));
const read=relative=>readFileSync(path.join(root,relative),"utf8");
const android=read("android/gradle.properties"),ios=read("ios/project.yml");
const clientId=android.match(/^discordClientId=(\d+)$/m)?.[1];
const site=android.match(/^siteUrl=(.+)$/m)?.[1];
const iosId=ios.match(/DISCORD_CLIENT_ID: "(\d+)"/)?.[1];
const iosSite=ios.match(/SITE_URL: "([^"]+)"/)?.[1];
let missing=0;
function check(ok,message){console.log(`${ok?"OK":"PENDENTE"}: ${message}`);if(!ok)missing++;}
check(/^\d{17,20}$/.test(clientId||""),"Client ID Android válido");
check(clientId===iosId,"Mesmo Client ID em Android e iOS");
let validOrigin=false;
try{const url=new URL(site);validOrigin=url.protocol==="https:"&&url.origin===site;}catch{}
check(validOrigin&&site===iosSite,"Mesma origem HTTPS em Android e iOS");
for(const file of ["sdk/include/discordpp.h","sdk/android/discord_partner_sdk.aar",
  "sdk/ios/discord_partner_sdk.xcframework/Info.plist"]){
  check(existsSync(path.join(root,file)),file);
}
console.log(`\nCadastre no Discord Developer Portal: discord-${clientId}:/authorize/callback`);
console.log("Build Android: JDK 17, Gradle 8.9 e Android SDK/NDK/CMake.");
console.log("Build iOS: macOS, Xcode e XcodeGen. Assinatura necessária para distribuir.");
console.log("Depois do build, teste em aparelhos reais com e sem o Discord instalado.");
process.exitCode=missing?1:0;
