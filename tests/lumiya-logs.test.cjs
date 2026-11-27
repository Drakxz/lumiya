const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const d=require("discord.js");
const logs=require("../lumiya-ui/logs");
const jsonOf=payload=>payload.embeds.map(embed=>embed.toJSON?.()||embed);
const textOf=payload=>jsonOf(payload).map(e=>[
  e.author?.name,e.title,e.description,...(e.fields||[]).flatMap(f=>[f.name,f.value]),e.footer?.text
].filter(Boolean).join("\n")).join("\n");
function valid(payload){
  assert.equal(payload.components,undefined);
  assert.equal(payload.flags,undefined);
  const embeds=jsonOf(payload);
  assert.equal(embeds.length,1);
  assert.ok(textOf(payload).length<=6000);
  for(const e of embeds){
    assert.ok(e.title.length<=256);
    assert.ok(e.description.length<=4096);
    assert.ok(e.footer.text.length<=2048);
    assert.ok((e.fields||[]).length<=25);
    for(const f of e.fields||[]){
      assert.ok(f.name.length>0&&f.name.length<=256);
      assert.ok(f.value.length>0&&f.value.length<=1024);
    }
  }
}

for(const category of Object.keys(logs.CATEGORIES)){
  test(`log card: ${category} shares hierarchy, limits, footer and no mentions`,()=>{
    const payload=logs.card({
      category,title:"Evento registrado",subtitle:"Os detalhes estão abaixo.",
      summary:[["Responsável","<@123456789012345678>"],["Status","Concluído"]],
      details:[["Canal","<#123456789012345679>"],["Motivo","Contexto da ação"]],
      preview:[["Antes","Texto anterior"],["Depois","Texto atualizado"]],
      avatarURL:"https://cdn.discordapp.com/embed/avatars/0.png",
      at:Date.UTC(2026,10,12,15,30),eventId:"audit-123"
    });
    const embed=jsonOf(payload)[0];
    valid(payload);
    assert.deepEqual(payload.allowedMentions,{parse:[]});
    assert.equal(embed.color,logs.CATEGORIES[category].color);
    assert.equal(embed.thumbnail.url,"https://cdn.discordapp.com/embed/avatars/0.png");
    assert.match(textOf(payload),/Responsável[\s\S]*Detalhes[\s\S]*Conteúdo[\s\S]*Lumiya/);
    assert.match(textOf(payload),/12\/11\/2026.*12:30:00/);
    assert.equal(payload.content,undefined);
    assert.equal(payload.files,undefined);
  });
}
test("long log data is attached without loss, mentions or broken surrogate pairs",()=>{
  const original=("Texto completo ♡ 🌙\n").repeat(500);
  const payload=logs.card({title:"Detalhes extensos",details:[original]});
  valid(payload);
  assert.equal(payload.files.length,1);
  const attached=payload.files[0].attachment.toString("utf8");
  assert.equal((textOf(payload)+attached).match(/Texto completo ♡ 🌙/g).length,500);
  assert.doesNotMatch(attached,/\ufffd/);
  assert.deepEqual(payload.allowedMentions,{parse:[]});
});
test("empty, malformed image, overlong title and no avatar stay valid",()=>{
  for(const avatarURL of [undefined,"http://localhost/secret","javascript:alert(1)","not-a-url"]){
    const payload=logs.card({title:"x".repeat(10000),subtitle:"y".repeat(10000),avatarURL});
    valid(payload);
    assert.equal(jsonOf(payload)[0].thumbnail,undefined);
  }
});
test("many short fields stay inline without requiring AttachFiles",()=>{
  const payload=logs.card({
    category:"moderation",title:"Banimento concluído",
    details:Array.from({length:30},(_,i)=>[`Campo ${i}`,`Valor ${i}`])
  });
  assert.equal(payload.files,undefined);
  valid(payload);
  for(let i=0;i<30;i++)assert.match(textOf(payload),new RegExp(`Valor ${i}`));
});
test("combined maximum labels, avatar and overflow respect Discord limits",()=>{
  const payload=logs.card({
    title:"*".repeat(10000),subtitle:"*".repeat(10000),source:"*".repeat(10000),eventId:"*".repeat(10000),
    avatarURL:"https://cdn.discordapp.com/embed/avatars/0.png",
    summary:["A".repeat(3000)],details:["B".repeat(3000)],preview:["C".repeat(3000)]
  });
  valid(payload);
  assert.equal(payload.files.length,1);
  const complete=textOf(payload)+payload.files[0].attachment.toString();
  for(const character of ["A","B","C"]){
    const runs=complete.match(new RegExp(`${character}{2,}`,"g"))||[];
    assert.equal(runs.reduce((sum,run)=>sum+run.length,0),3000);
  }
});
test("legacy heading and duplicate record footer are replaced, factual content retained",()=>{
  const c=new d.ContainerBuilder().addTextDisplayComponents(
    new d.TextDisplayBuilder().setContent("## Banimento concluído\n-# Registro antigo"),
    new d.TextDisplayBuilder().setContent("**Motivo**\n> Spam"),
    new d.TextDisplayBuilder().setContent("-# Registro: record-123")
  );
  const payload=logs.fromPayload({components:[c]},{
    title:"Banimento concluído",category:"moderation",eventId:"record-123",omitHeader:true
  });
  assert.equal(textOf(payload).match(/Banimento concluído/g).length,1);
  assert.equal(textOf(payload).match(/record-123/g).length,1);
  assert.match(textOf(payload),/> Spam/);
  assert.doesNotMatch(textOf(payload),/Registro antigo/);
  assert.equal(payload.files,undefined);
});
test("migration adapter preserves ordered metadata and attachments without mutating input",()=>{
  const c=new d.ContainerBuilder().setAccentColor(0)
    .addTextDisplayComponents(new d.TextDisplayBuilder().setContent("**Alvo**\n<@123>"))
    .addSeparatorComponents(new d.SeparatorBuilder())
    .addTextDisplayComponents(new d.TextDisplayBuilder().setContent("**Motivo**\n> Texto anterior\n> Segunda linha"));
  const before=JSON.stringify(c.toJSON()),file={attachment:Buffer.from("full"),name:"original.txt"};
  const payload=logs.fromPayload({components:[c],files:[file]},{
    category:"moderation",title:"Banimento concluído"
  });
  assert.equal(JSON.stringify(c.toJSON()),before);
  assert.match(textOf(payload),/Alvo[\s\S]*Motivo[\s\S]*Segunda linha/);
  assert.equal(payload.files[0],file);
  valid(payload);
});
test("image previews are explicit HTTPS-only and never create a container",()=>{
  const payload=logs.card({category:"messages",title:"Mensagem editada",
    preview:[["Antes","> Mensagem antiga"],["Depois","> Mensagem nova"]],
    metadata:[["Servidor","123"],["Canal","456"],["Mensagem","789"]],
    imageURL:"https://cdn.discordapp.com/attachments/example/image.png",
    botAvatarURL:"https://cdn.discordapp.com/embed/avatars/0.png"
  });
  valid(payload);
  assert.match(jsonOf(payload)[0].image.url,/image.png/);
  assert.ok(jsonOf(payload)[0].author.icon_url);
  assert.match(textOf(payload),/Antes[\s\S]*Depois[\s\S]*Identificadores[\s\S]*789/);
  assert.equal(jsonOf(logs.card({imageURL:"file:///private.png"}))[0].image,undefined);
});
test("invalid timestamps fall back instead of breaking delivery",()=>{
  for(const at of [NaN,Infinity,1e99,"invalid"]){
    const payload=logs.card({at});
    valid(payload);
    assert.ok(Number.isFinite(Date.parse(jsonOf(payload)[0].timestamp)));
  }
});
test("every existing Discord log emitter uses the central log-card system",()=>{
  for(const file of [
    "media-moderation/logs.js","role-whitelist/addition-log.js","boost-logs/index.js",
    "ticket-management/index.js","nickname-protection/index.js","backups/index.js",
    "instagram-web/index.js","configuration/index.js","ban-management/index.js"
  ])assert.match(fs.readFileSync(require("node:path").join(__dirname,"..",file),"utf8"),/lumiya-ui\/logs/,file);
});
