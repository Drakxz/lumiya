const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {spawn}=require("node:child_process"),{EventEmitter}=require("node:events");
const WebSocket=require("ws");
const {createManager,createPanelServer}=require("../call-panel");
const edge=path.join(process.env["ProgramFiles(x86)"]||"C:\\Program Files (x86)","Microsoft/Edge/Application/msedge.exe");

test("browser navigates dashboard, edits presence and opens command menu",{skip:process.platform!=="win32"||!fs.existsSync(edge),timeout:60000},async t=>{
  const root=path.join(os.tmpdir(),"opencode");await fsp.mkdir(root,{recursive:true});
  const profile=await fsp.mkdtemp(path.join(root,"sla-browser-"));
  let saved=[];
  const manager=createManager({client:new EventEmitter(),env:{},store:{load:async()=>saved,save:async a=>{saved=structuredClone(a);}},
    install:()=>({close(){},getStatus:()=>({state:"online"}),setPresence(){}})});
  await manager.ready;await manager.save({name:"Conta de teste",token:"mock-token",joinCall:false,channelId:""});
  const html=await fsp.readFile(path.join(__dirname,"../call-panel/index.html"),"utf8");
  const panel=createPanelServer({manager,html}),url=await panel.listen(0);
  const child=spawn(edge,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--disable-extensions",
    "--remote-debugging-port=0",`--user-data-dir=${profile}`,"about:blank"],{windowsHide:true,stdio:["ignore","ignore","pipe"]});
  let ws;
  t.after(async()=>{
    if(ws?.readyState===WebSocket.OPEN){try{ws.send(JSON.stringify({id:99999,method:"Browser.close"}));}catch{}ws.close();}
    child.kill();manager.close();
    await new Promise(resolve=>panel.server.close(resolve));
    // Edge may still be releasing its isolated profile files.
    await fsp.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
  });
  const endpoint=await new Promise((resolve,reject)=>{
    let output="";const timer=setTimeout(()=>reject(new Error("Browser startup timeout")),20000);
    child.on("error",()=>{clearTimeout(timer);reject(new Error("Browser failed to start"));});
    child.stderr.on("data",chunk=>{output+=chunk.toString();const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject);});
  let id=0;const pending=new Map(),errors=[];
  ws.on("message",raw=>{
    const packet=JSON.parse(String(raw));
    if(packet.method==="Runtime.exceptionThrown")errors.push(packet.params.exceptionDetails.text);
    const task=pending.get(packet.id);if(task){pending.delete(packet.id);packet.error?task.reject(new Error(packet.error.message)):task.resolve(packet.result);}
  });
  function call(method,params={},sessionId){
    return new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject});ws.send(JSON.stringify({id:current,method,params,...(sessionId?{sessionId}:{})}));});
  }
  const {targetId}=await call("Target.createTarget",{url:"about:blank"});
  const {sessionId}=await call("Target.attachToTarget",{targetId,flatten:true});
  await call("Runtime.enable",{},sessionId);await call("Page.enable",{},sessionId);
  const loaded=new Promise(resolve=>{
    function listener(raw){const event=JSON.parse(String(raw));if(event.sessionId===sessionId&&event.method==="Page.loadEventFired"){ws.off("message",listener);resolve();}}
    ws.on("message",listener);
  });
  await call("Page.navigate",{url},sessionId);await loaded;
  async function evaluate(expression){
    const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true},sessionId);
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+15000;const timer=setInterval(()=>{
    if(document.getElementById("stat-total")?.textContent==="1"){clearInterval(timer);resolve(true);}
    else if(Date.now()>deadline){clearInterval(timer);reject(new Error("Dashboard did not load"));}
  },50);})`);
  assert.equal(await evaluate('document.getElementById("overview-view").hidden'),false);
  await evaluate('document.querySelector("[data-nav=presence]").click()');
  assert.equal(await evaluate('document.getElementById("presence-view").hidden'),false);
  await evaluate('document.querySelector("#presence-accounts .primary").click()');
  assert.equal(await evaluate('document.getElementById("presence-editor").open'),true);
  await evaluate(`document.getElementById("presence-status").value="dnd";document.getElementById("presence-name").value="sla";document.getElementById("presence-save").click()`);
  await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+10000;const t=setInterval(()=>{
    if(!document.getElementById("presence-editor").open){clearInterval(t);resolve(true);}
    else if(Date.now()>deadline){clearInterval(t);reject(new Error("Presence save failed"));}
  },50);})`);
  assert.equal(manager.list()[0].presence.status,"dnd");
  await evaluate('document.getElementById("command-open").click()');
  assert.equal(await evaluate('document.getElementById("command-dialog").open'),true);
  assert.ok(await evaluate('document.querySelectorAll("#command-results button").length')>5);
  assert.deepEqual(errors,[]);
});
