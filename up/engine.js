const { PermissionFlagsBits } = require("discord.js");
const { UpStore } = require("./store");
const {weekStart,WEEK_MS}=require("../voice-hours/time");

const PRIVILEGED = Object.entries(PermissionFlagsBits)
  .filter(([name])=>/^(Administrator|Manage|BanMembers|KickMembers|ModerateMembers|MentionEveryone|ViewAuditLog|MuteMembers|DeafenMembers|MoveMembers)/.test(name))
  .map(([,value])=>value);

function validateRole(guild, role, actor = null) {
  const bot = guild.members.me;
  if (!bot?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new Error("O bot precisa de Gerenciar Cargos.");
  if (!role || role.id === guild.id || role.managed || role.position >= bot.roles.highest.position) {
    throw new Error("O cargo deve existir, não ser gerenciado por integração e estar abaixo do bot.");
  }
  if (PRIVILEGED.some(permission => role.permissions.has(permission))) {
    // Configuration requires an actual administrator; automatic delivery has no
    // human actor and uses only roles already authorized in the UP settings.
    if (actor && actor.id !== guild.ownerId && !actor.permissions?.has(PermissionFlagsBits.Administrator)) {
      throw new Error("Somente o dono do servidor ou um Administrador pode configurar cargos com permissões administrativas no UP.");
    }
  }
  if (actor && actor.id !== guild.ownerId && role.position >= actor.roles.highest.position) throw new Error("O cargo também deve estar abaixo do seu cargo mais alto.");
}

class UpEngine {
  constructor({client,hours,history,notify}) {
    this.client=client; this.hours=hours; this.history=history; this.store=new UpStore(hours); this.notify=notify;
    this.locks=new Set(); this.queue=new Set(); this.workers=0; this.stopped=false;
  }
  eligible(guild, member, config = this.store.config(guild.id)) {
    const excluded = [...new Set([...config.excludedChannels, guild.afkChannelId].filter(Boolean))];
    return Math.max(0,this.hours.eligible(guild.id,member.userId,{ since: config.retroactive ? 0 : member.joinedAt,
      countMuted: config.countMuted, excluded })-this.store.maintenanceState(guild.id,member.userId).eligibleOffset);
  }
  async roleChange(guild, userId, role, action, op) {
    if(action==='add'&&this.bioGate)await this.bioGate.require(guild,userId);
    const member = await guild.members.fetch({ user:userId,force:true });
    validateRole(guild,role);
    return this.history.alterarCargo({ guild,alvo:member,cargo:role,action,autor:this.client.user,
      source:"Progressão automática mds",reason:op.maintenance?"Meta semanal não cumprida: rebaixamento de um nível":"Progressão automática por horas em call",hoursMs:op.hoursMs,
      executar:reason => action === "add" ? member.roles.add(role,reason) : member.roles.remove(role,reason) });
  }
  async apply(guild,op) {
    op.maintenance=Boolean(this.store.db.prepare("SELECT opId FROM up_maintenance_operations WHERE opId=?").get(op.id));
    const config=this.store.config(guild.id), level=this.store.levels(guild.id).find(item=>item.id===op.levelId);
    const stillAuthorized=level && level.requiredMs===op.requiredMs && (op.requiredMs===0
      ? [level.roleId,...config.initialRoles].includes(op.roleId) : level.roleId===op.roleId);
    if(!stillAuthorized && op.state==="planned") {
      const current=await guild.members.fetch({user:op.userId,force:true});
      if(!current.roles.cache.has(op.roleId)) {
        // Uma meta nova vale para quem ainda não recebeu a recompensa.
        this.store.cancel(op);
        return false;
      }
    }
    const role=await guild.roles.fetch(op.roleId);
    validateRole(guild,role);
    // Adiciona antes de remover. Cada etapa usa a API idempotente de cargo único.
    await this.roleChange(guild,op.userId,role,"add",op);
    this.store.markGranted(op);
    let removals=[];
    if(op.recalculate) {
      removals=[...this.store.levels(guild.id).map(l=>l.roleId),...this.store.config(guild.id).initialRoles,op.previousRoleId];
    } else if(op.removePrevious && op.previousRoleId) removals=[op.previousRoleId];
    for(const id of new Set(removals.filter(id=>id && id!==op.roleId))) {
      let previous;
      try {previous=await guild.roles.fetch(id);}
      catch(error) {if(error.code===10011)previous=null;else throw error;}
      if(previous) await this.roleChange(guild,op.userId,previous,"remove",op);
    }
    this.store.finish(op);
    await this.deliver(guild,op);
    return true;
  }
  async deliver(guild,op) {
    const row=this.store.db.prepare("SELECT notification FROM up_operations WHERE id=?").get(op.id);
    if(row?.notification!=="pending") return;
    const config=this.store.config(guild.id);
    // Entrega at-most-once: nunca repete um aviso após um timeout/queda ambígua.
    this.store.db.prepare("UPDATE up_operations SET notification='attempted' WHERE id=? AND notification='pending'").run(op.id);
    if(!config.notificationChannel || !op.previousRoleId || op.recalculate) return;
    try { await this.notify(guild,op,config); }
    catch(error) { console.warn("[UP] Não foi possível enviar a notificação:",error.message); }
  }
  async claim(guild,userId,initialRoleId) {
    const key=`${guild.id}:${userId}`;
    if(this.locks.has(key)) throw new Error("Sua progressão já está sendo processada. Aguarde.");
    this.locks.add(key);
    try {
      const config=this.store.config(guild.id), levels=this.store.levels(guild.id);
      if(!config.enabled || !levels.length || levels[0].requiredMs!==0) throw new Error("A progressão ainda não está habilitada/configurada.");
      const previous=this.store.member(guild.id,userId);
      if(previous) {
        if(previous.state==="enrolling") {
          const pending=this.store.pending(guild.id,userId);
          if(pending) await this.apply(guild,pending);
        }
        throw new Error("Você já iniciou sua jornada. Suas horas e seu resgate foram preservados.");
      }
      if(this.bioGate)await this.bioGate.require(guild,userId,true);
      const authorized=[levels[0].roleId,...config.initialRoles];
      if(!authorized.includes(initialRoleId)) throw new Error("Esse cargo não é uma opção inicial autorizada.");
      const member=await guild.members.fetch({user:userId,force:true});
      if(member.user.bot) throw new Error("Bots não participam da progressão.");
      if(levels.some(l=>l.requiredMs>0 && member.roles.cache.has(l.roleId))) throw new Error("Você já possui um cargo avançado da progressão; procure a equipe para evitar um rebaixamento.");
      const role=await guild.roles.fetch(initialRoleId); validateRole(guild,role);
      const now=Date.now(), total=this.hours.stats(guild.id,userId,now).totalCallMs;
      const op=this.hours.transaction(()=>{
        const enrolled=this.store.join(guild.id,userId,total,now);
        return this.store.plan(enrolled,levels[0],initialRoleId,0,config);
      });
      if(!await this.apply(guild,op)) throw new Error("A configuração mudou durante o resgate. Seu início foi salvo; o bot tentará concluir com a configuração atual.");
      this.enqueue(guild.id,userId);
      return {roleId:initialRoleId,next:levels[1] || null};
    } finally {this.locks.delete(key);}
  }
  async advance(guildId,userId) {
    const key=`${guildId}:${userId}`;
    if(this.locks.has(key) || this.stopped) return;
    this.locks.add(key);
    try {
      const guild=this.client.guilds.cache.get(guildId);
      if(!guild?.available) return;
      const config=this.store.config(guildId);
      if(!config.enabled) return;
      let member=this.store.member(guildId,userId);
      if(!member || member.state==="absent") return;
      if(this.bioGate&&!await this.bioGate.allow(guild,userId))return;
      const pending=this.store.pending(guildId,userId);
      if(pending) {await this.apply(guild,pending);member=this.store.member(guildId,userId);}
      if(member.state==="enrolling" && !this.store.pending(guildId,userId)) {
        const initial=this.store.levels(guildId)[0];
        if(initial?.requiredMs===0) {
          const op=this.store.plan(member,initial,initial.roleId,0,config);
          await this.apply(guild,op);member=this.store.member(guildId,userId);
        }
      }
      if(member.state!=="active") return;
      if(await this.maintain(guild,member,config))return;
      const eligible=this.eligible(guild,member,config), levels=this.store.levels(guildId);
      if(!levels.length) return;
      const earned=new Set(this.store.unlocks(guildId,userId).map(item=>item.levelId));
      const due=member.recalculate
        ? levels.filter(l=>l.requiredMs<=eligible).slice(-1)
        : levels.filter(l=>!earned.has(l.id) && l.requiredMs>member.bestMs && l.requiredMs<=eligible);
      for(const level of due) {
        // Alterações administrativas durante a chamada não produzem mais etapas com uma revisão antiga.
        if(this.store.config(guildId).revision!==config.revision) break;
        const op=this.store.plan(member,level,level.roleId,eligible,config);
        await this.apply(guild,op);
        member=this.store.member(guildId,userId);
      }
      for(const op of this.store.db.prepare("SELECT * FROM up_operations WHERE guildId=? AND userId=? AND state='done' AND notification='pending'").all(guildId,userId)) await this.deliver(guild,op);
    } catch(error) {
      if(error.code===10007) this.store.db.prepare("UPDATE up_members SET state='absent',updatedAt=? WHERE guildId=? AND userId=?").run(Date.now(),guildId,userId);
      else throw error;
    } finally {this.locks.delete(key);}
  }
  enqueue(guildId,userId) {
    if(this.stopped) return;
    this.queue.add(`${guildId}:${userId}`);
    this.drain();
  }
  async maintain(guild,member,config,now=Date.now()) {
    const currentWeek=weekStart(now),state=this.store.maintenanceState(guild.id,member.userId);
    if(state.blockedUntil>now)return true;
    const rule=this.store.maintenance(guild.id,member.currentRoleId);
    if(!rule?.requiredMs)return false;
    const levels=this.store.levels(guild.id),index=levels.findIndex(l=>l.id===member.currentLevelId);
    if(index<=0)return false;
    // Só cobra semanas inteiras após a última aquisição do cargo ou edição da meta.
    const firstWeek=weekStart(Math.max(rule.enabledAt,member.lastEvolution||member.joinedAt))+WEEK_MS;
    const from=Math.max(firstWeek,state.checkedUntil);
    if(from>=currentWeek)return false;
    this.hours.checkpoint(now);
    for(let week=from;week<currentWeek;week+=WEEK_MS) {
      const actual=this.hours.getWeek.get(guild.id,member.userId,week)?.callMs||0;
      if(actual>=rule.requiredMs)continue;
      const target=levels[index-1];
      // Não concede cargo inferior se o cargo cobrado já não pertence ao membro.
      const discordMember=await guild.members.fetch({user:member.userId,force:true});
      if(!discordMember.roles.cache.has(member.currentRoleId))return false;
      validateRole(guild,await guild.roles.fetch(target.roleId));
      validateRole(guild,await guild.roles.fetch(member.currentRoleId));
      const eligible=this.eligible(guild,member,config);
      const op=this.hours.transaction(()=>{
        const planned=this.store.plan({...member,recalculate:1},target,target.roleId,actual,{...config,removePrevious:true});
        this.store.db.prepare("INSERT INTO up_maintenance_operations VALUES(?)").run(planned.id);
        this.store.db.prepare(`INSERT INTO up_maintenance_members VALUES(?,?,?,?,?) ON CONFLICT(guildId,userId)
          DO UPDATE SET checkedUntil=excluded.checkedUntil,blockedUntil=excluded.blockedUntil,eligibleOffset=excluded.eligibleOffset`)
          .run(guild.id,member.userId,currentWeek,currentWeek+WEEK_MS,state.eligibleOffset+Math.max(0,eligible-target.requiredMs));
        this.store.db.prepare("DELETE FROM up_unlocks WHERE guildId=? AND userId=? AND requiredMs>?").run(guild.id,member.userId,target.requiredMs);
        return planned;
      });
      op.maintenance=true;
      await this.apply(guild,op);
      return true;
    }
    this.store.db.prepare(`INSERT INTO up_maintenance_members VALUES(?,?,?,?,?) ON CONFLICT(guildId,userId)
      DO UPDATE SET checkedUntil=excluded.checkedUntil`).run(guild.id,member.userId,currentWeek,state.blockedUntil,state.eligibleOffset);
    return false;
  }
  drain() {
    while(this.workers<3 && this.queue.size && !this.stopped) {
      const key=this.queue.values().next().value;this.queue.delete(key);this.workers++;
      const [guildId,userId]=key.split(":");
      this.advance(guildId,userId).catch(error=>console.warn(`[UP] ${key}:`,error.message))
        .finally(()=>{this.workers--;this.drain();});
    }
  }
  wakeGuild(guildId) {
    for(const row of this.store.db.prepare("SELECT userId FROM up_members WHERE guildId=? AND state!='absent'").all(guildId)) this.enqueue(guildId,row.userId);
  }
  scan(includeInactive=false) {
    if(includeInactive) {
      for(const row of this.store.db.prepare("SELECT guildId,userId FROM up_members WHERE state!='absent'").all())this.enqueue(row.guildId,row.userId);
      return;
    }
    for(const row of this.store.db.prepare(`SELECT DISTINCT m.guildId,m.userId FROM up_members m
      LEFT JOIN active a ON a.guildId=m.guildId AND a.userId=m.userId
      WHERE m.state!='absent' AND (a.userId IS NOT NULL OR m.state='enrolling' OR m.recalculate=1
       OR EXISTS(SELECT 1 FROM up_maintenance_roles r WHERE r.guildId=m.guildId AND r.roleId=m.currentRoleId AND r.requiredMs>0)
       OR EXISTS(SELECT 1 FROM up_operations o WHERE o.guildId=m.guildId AND o.userId=m.userId AND (o.state!='done' OR o.notification='pending')))`).all()) {
      this.enqueue(row.guildId,row.userId);
    }
  }
}

module.exports={UpEngine,validateRole};
