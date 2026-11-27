const {weekStart}=require('../voice-hours/time');
module.exports=function createActivity({client,db,config}){
  db.exec(`CREATE TABLE IF NOT EXISTS management_activity(guildId TEXT NOT NULL,area TEXT NOT NULL,week INTEGER NOT NULL,userId TEXT NOT NULL,channelId TEXT NOT NULL,messages INTEGER NOT NULL DEFAULT 0,everyone INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(guildId,area,week,userId,channelId));
    CREATE TABLE IF NOT EXISTS management_activity_seen(messageId TEXT PRIMARY KEY,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS management_activity_seen_at ON management_activity_seen(at);`);
  const seen=db.prepare('INSERT OR IGNORE INTO management_activity_seen VALUES(?,?)');
  const add=db.prepare('INSERT INTO management_activity VALUES(?,?,?,?,?,1,?) ON CONFLICT(guildId,area,week,userId,channelId) DO UPDATE SET messages=messages+1,everyone=everyone+excluded.everyone');
  const prune=db.prepare('DELETE FROM management_activity_seen WHERE at<?');let nextPrune=0;
  function count(message){
    if(!message.guildId||!message.id||!message.author?.id||message.author.bot||message.webhookId||message.system)return;
    const c=config(message.guildId),at=message.createdTimestamp||Date.now(),week=weekStart(at);
    if(at<Date.now()-7*86400000||at>Date.now()+300000)return;
    const areas=['movchat'];if(c.passtimeChannel===message.channelId)areas.push('passtime');
    // Conta uma marcação por mensagem; @here não conta como @everyone.
    const visible=String(message.content||'').replace(/```[\s\S]*?```|`[^`\n]*`/g,'');
    const everyone=message.mentions?.everyone===true&&/(^|[^\\])@everyone\b/.test(visible)?1:0;
    db.exec('BEGIN IMMEDIATE');try{
      const inserted=seen.run(message.id,at);
      if(inserted.changes)for(const area of areas)add.run(message.guildId,area,week,message.author.id,message.channelId,everyone);
      if(Date.now()>=nextPrune)prune.run(Date.now()-7*86400000);db.exec('COMMIT');
      if(Date.now()>=nextPrune)nextPrune=Date.now()+3600000;
    }catch(error){db.exec('ROLLBACK');console.warn('[Atividade de equipes] Não foi possível registrar a mensagem:',error.message);}
  }
  function totals(gid,area,now=Date.now()){
    const c=config(gid),rows=area==='passtime'
      ?db.prepare('SELECT userId,SUM(messages) messages,SUM(everyone) everyone FROM management_activity WHERE guildId=? AND area=? AND week=? AND channelId=? GROUP BY userId').all(gid,area,weekStart(now),c.passtimeChannel||'')
      :db.prepare('SELECT userId,SUM(messages) messages,SUM(everyone) everyone FROM management_activity WHERE guildId=? AND area=? AND week=? GROUP BY userId').all(gid,area,weekStart(now));
    return new Map(rows.map(r=>[r.userId,{messages:Number(r.messages),everyone:Number(r.everyone)}]));
  }
  client.on('messageCreate',count);return {count,totals};
};
