const test=require("node:test");
const assert=require("node:assert/strict");
const {EventEmitter}=require("node:events");
const {PermissionsBitField,PermissionFlagsBits}=require("discord.js");
const {getCommandRegistry}=require("../command-system/registry");
const {SHORTCUTS,simplifyCommand,shortCommandText}=require("../command-system/shortcuts");

test("shortcuts preserve executors, authorization, old aliases, arguments and logical names",async()=>{
  const client=new EventEmitter();client.user={id:"bot"};
  let denied=0;
  const registry=getCommandRegistry(client,{deny:async()=>{denied++;}});
  for(const [oldTrigger,shortTrigger] of Object.entries(SHORTCUTS)){
    const executed=[];
    const original={name:oldTrigger.slice(1),description:"Descrição",category:"Administração",
      permissions:["ManageGuild"],examples:[`${oldTrigger} #canal`],
      prefix:{trigger:oldTrigger,usage:[`${oldTrigger} [@usuário ou ID]`],
        execute:async m=>{executed.push(m.content);}}};
    const command=registry.register(original);
    assert.equal(command.name,original.name);
    assert.equal(command.prefix.trigger,shortTrigger);
    assert.equal(command.prefix.execute,original.prefix.execute);
    assert.equal(original.prefix.trigger,oldTrigger);
    assert.deepEqual(command.prefix.usage,[`${shortTrigger} [@usuário ou ID]`]);
    assert.deepEqual(command.examples,[`${shortTrigger} #canal`]);
    assert.ok(command.prefix.aliases.includes(oldTrigger));
    assert.ok(!registry.matches(command,`${shortTrigger}extra`));
    for(const trigger of [oldTrigger,shortTrigger]){
      const message={content:`${trigger} 123`,guild:{id:"guild"},author:{id:"admin"},
        member:{permissions:new PermissionsBitField([PermissionFlagsBits.ManageGuild])}};
      for(const callback of client.listeners("messageCreate"))await callback(message);
      message.member.permissions=new PermissionsBitField([]);
      for(const callback of client.listeners("messageCreate"))await callback(message);
    }
    assert.deepEqual(executed,[`${oldTrigger} 123`,`${shortTrigger} 123`]);
  }
  assert.equal(denied,Object.keys(SHORTCUTS).length*2);
  assert.equal(registry.catalog({all:true}).length,Object.keys(SHORTCUTS).length);
});

test("shortening deduplicates preexisting short aliases and usage without mutating slash data",()=>{
  const slash={data:{name:"desbanir"},execute(){}};
  const command=simplifyCommand({name:"desbanir",slash,examples:["!desbanir ID","!unban ID"],
    prefix:{trigger:"!desbanir",aliases:["!unban"],usage:["!desbanir ID","!unban ID"],execute(){}}});
  assert.deepEqual(command.prefix.aliases,["!desbanir"]);
  assert.deepEqual(command.prefix.usage,["!unban ID"]);
  assert.deepEqual(command.examples,["!unban ID"]);
  assert.equal(command.slash,slash);
  assert.equal(shortCommandText("!WLCARGOS · !wlcargosextra · /upadmin"),"!wl · !wlcargosextra · /upadmin");
});

test("short aliases retain exact matching and collision protection",()=>{
  const client=new EventEmitter();client.user={id:"bot"};
  const registry=getCommandRegistry(client);
  const definition={name:"wlcargos",description:"Descrição",category:"Geral",
    prefix:{trigger:"!wlcargos",exact:true,execute(){}}};
  const command=registry.register(definition);
  for(const trigger of ["!wl","!wlcargos"]){
    assert.ok(registry.matches(command,trigger));
    assert.equal(registry.matches(command,`${trigger} argumento`),false);
  }
  assert.throws(()=>registry.register({...definition,name:"other",prefix:{trigger:"!wl",execute(){}}}),/já registrado/);
});
