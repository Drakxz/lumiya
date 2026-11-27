// Consultas completas são para listagens. Autorização usa sempre fetch individual.
const directories=new WeakMap();
function createMemberDirectory(client,{ttl=60000,now=()=>Date.now()}={}){
  const guilds=new Map();
  function state(gid){if(!guilds.has(gid))guilds.set(gid,{members:null,expires:0,pending:null,retryAt:0});return guilds.get(gid);}
  function cooldown(retryAt){const error=new Error('A consulta de membros está temporariamente limitada pelo Discord.');error.kind='member_fetch_rate_limit';error.retrySeconds=Math.max(1,Math.ceil((retryAt-now())/1000));return error;}
  async function get(guild){
    const s=state(guild.id);
    if(s.members&&now()<s.expires)return s.members;
    if(s.pending)return s.pending;
    if(now()<s.retryAt){if(s.members)return s.members;throw cooldown(s.retryAt);}
    const cache=guild.members.cache;
    if(Number.isInteger(guild.memberCount)&&cache&&cache.size===guild.memberCount){s.members=new Map(cache);s.expires=now()+ttl;return s.members;}
    s.pending=Promise.resolve().then(async()=>{
      try{
        const members=await guild.members.fetch();s.members=new Map(members);s.expires=now()+ttl;s.retryAt=0;return s.members;
      }catch(error){
        const seconds=Number(error.data?.retry_after)||Number(error.message?.match(/Retry after ([\d.]+) seconds/i)?.[1]);
        if(error.data?.opcode===8||/opcode 8.*rate limited/i.test(error.message||'')){
          s.retryAt=now()+Math.max(1000,(seconds||15)*1000)+250;
          if(s.members)return s.members;
          throw cooldown(s.retryAt);
        }throw error;
      }finally{s.pending=null;}
    });return s.pending;
  }
  const update=m=>{const s=guilds.get(m.guild.id);if(s?.members)s.members.set(m.id,m);};
  client.on('guildMemberAdd',update);
  client.on('guildMemberUpdate',(_old,m)=>update(m));
  client.on('guildMemberRemove',m=>guilds.get(m.guild.id)?.members?.delete(m.id));
  client.on('guildDelete',g=>guilds.delete(g.id));
  return {get};
}
function memberDirectory(client){if(!directories.has(client))directories.set(client,createMemberDirectory(client));return directories.get(client);}
module.exports={memberDirectory,createMemberDirectory};
