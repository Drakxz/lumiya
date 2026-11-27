const {PermissionFlagsBits}=require("discord.js");
const LEVEL={none:0,view:1,manage:2};
const DURATIONS={permanent:0,hour:3600000,day:86400000,week:7*86400000,month:30*86400000};
const NATIVE_ACCESS=[
  PermissionFlagsBits.Administrator,PermissionFlagsBits.ManageGuild,PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageMessages,PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageChannels,PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.MuteMembers,PermissionFlagsBits.DeafenMembers,PermissionFlagsBits.MoveMembers
];

class AccessService{
  constructor(store,systems){
    this.store=store;this.systems=systems;
    this.keys=[
      {id:"view",label:"Visualizar configurações"},
      ...systems().map(system=>({id:`system:${system.id}`,label:system.label})),
      {id:"panel.appearance",label:"Aparência dos painéis"},
      {id:"panel.templates",label:"Editor de templates"},
      {id:"panel.publish",label:"Publicar e atualizar painéis"},
      {id:"panel.logs",label:"Canais de logs"}
    ];
    this.keyIds=new Set(this.keys.map(key=>key.id));
    this.migrate();
  }
  migrate(){
    for(const row of this.store.db.prepare("SELECT guildId,data FROM lumiya_settings").all()){
      if(this.store.accessMigrated(row.guildId))continue;
      const data=JSON.parse(row.data),now=Date.now();
      for(const id of data.authorizedUsers||[])this.store.saveAccess({guildId:row.guildId,subjectType:"user",subjectId:id,level:LEVEL.manage,permissions:{"*":LEVEL.manage},expiresAt:null,grantedBy:null,reason:"Importado das configurações anteriores",createdAt:now});
      for(const id of data.authorizedRoles||[])this.store.saveAccess({guildId:row.guildId,subjectType:"role",subjectId:id,level:LEVEL.manage,permissions:{"*":LEVEL.manage},expiresAt:null,grantedBy:null,reason:"Importado das configurações anteriores",createdAt:now});
      this.store.markAccessMigrated(row.guildId);
    }
  }
  cleanup(guildId){
    const now=Date.now(),expired=this.store.accessRows(guildId).filter(row=>row.expiresAt&&row.expiresAt<=now&&!row.expiredLogged);
    for(const row of expired){
      this.store.markExpired(guildId,row.subjectType,row.subjectId);
      this.store.addAccessHistory({guildId,actorId:null,subjectType:row.subjectType,subjectId:row.subjectId,
        action:"access.expired",beforeData:this.public(row),afterData:null,reason:"Expiração automática",createdAt:now});
    }
    return expired.length;
  }
  public(row){
    return {...row,permissions:typeof row.permissions==="string"?JSON.parse(row.permissions):row.permissions};
  }
  isPrivileged(permissions){
    if(!permissions)return false;
    if(typeof permissions.has==="function")return NATIVE_ACCESS.some(flag=>permissions.has(flag));
    return NATIVE_ACCESS.some(flag=>(BigInt(permissions)&flag)===flag);
  }
  effective(guildId,userId,roleIds=[],ownerId=null,privileged=false){
    const levels={};
    this.cleanup(guildId);
    if(ownerId&&userId===ownerId){
      for(const key of this.keyIds)levels[key]=LEVEL.manage;
      levels["access.manage"]=LEVEL.manage;
      return {owner:true,levels};
    }
    if(privileged){
      for(const key of this.keyIds)levels[key]=LEVEL.manage;
      levels["access.manage"]=LEVEL.none;
      return {owner:false,levels,privileged:true};
    }
    const rows=this.store.accessRows(guildId).filter(row=>!row.expiresAt||row.expiresAt>Date.now());
    for(const row of rows){
      if(row.subjectType==="user"&&row.subjectId!==userId)continue;
      if(row.subjectType==="role"&&!roleIds.includes(row.subjectId))continue;
      const permissions=this.public(row).permissions||{};
      for(const [key,value]of Object.entries(permissions)){
        if(key==="*"){
          for(const id of this.keyIds)if(id!=="access.manage")levels[id]=Math.max(levels[id]||0,Math.min(LEVEL.manage,value));
        }else if(this.keyIds.has(key)&&key!=="access.manage")
          levels[key]=Math.max(levels[key]||0,Math.min(LEVEL.manage,Number(value)||0));
      }
      if(row.level===LEVEL.manage){
        levels.view=Math.max(levels.view||0,LEVEL.manage);
        for(const key of ["panel.appearance","panel.templates","panel.publish","panel.logs"])
          levels[key]=Math.max(levels[key]||0,LEVEL.manage);
      }
    }
    levels["access.manage"]=LEVEL.none;
    return {owner:false,levels};
  }
  can(guildId,userId,roleIds,ownerId,key,minimum=LEVEL.view,privileged=false){
    return this.effective(guildId,userId,roleIds,ownerId,privileged).levels[key]>=minimum;
  }
  visibleSystems(guildId,userId,roleIds,ownerId,privileged=false){
    const levels=this.effective(guildId,userId,roleIds,ownerId,privileged).levels;
    return this.systems().filter(system=>levels[`system:${system.id}`]>=LEVEL.view);
  }
  normalize(level,permissions){
    if(![LEVEL.none,LEVEL.view,LEVEL.manage].includes(Number(level)))throw new Error("Tipo de acesso inválido.");
    const clean={};
    for(const [key,value]of Object.entries(permissions||{})){
      if(!this.keyIds.has(key)||key==="access.manage")continue;
      const numeric=Math.min(LEVEL.manage,Math.max(LEVEL.none,Number(value)||0));
      if(numeric)clean[key]=numeric;
    }
    if(Number(level)===LEVEL.view)for(const key of Object.keys(clean))clean[key]=Math.min(clean[key],LEVEL.view);
    return clean;
  }
  grant(guildId,actorId,ownerId,{subjectType,subjectId,level,permissions,expiresAt,reason}){
    if(actorId!==ownerId)throw new Error("Somente o proprietário pode alterar acessos.");
    if(!["role","user"].includes(subjectType)||!/^\d{17,20}$/.test(String(subjectId)))throw new Error("Selecione um cargo ou membro válido.");
    const before=this.store.accessRow(guildId,subjectType,subjectId),now=Date.now();
    const normalized=this.normalize(level,permissions);
    normalized.view=Math.max(normalized.view||0,Number(level)===LEVEL.view?LEVEL.view:LEVEL.manage);
    const row={guildId,subjectType,subjectId:String(subjectId),level:Number(level),
      permissions:normalized,expiresAt:expiresAt||null,grantedBy:actorId,
      reason:String(reason||"").slice(0,400),createdAt:now};
    this.store.saveAccess(row);
    this.store.addAccessHistory({guildId,actorId,subjectType,subjectId:row.subjectId,action:before?"access.updated":"access.granted",
      beforeData:before?this.public(before):null,afterData:row,reason:row.reason,createdAt:now});
    this.store.invalidateSessions(guildId,actorId);
    return row;
  }
  revoke(guildId,actorId,ownerId,subjectType,subjectId){
    if(actorId!==ownerId)throw new Error("Somente o proprietário pode revogar acessos.");
    const before=this.store.accessRow(guildId,subjectType,subjectId);
    if(!before)throw new Error("Este acesso não existe mais.");
    this.store.deleteAccess(guildId,subjectType,subjectId);
    this.store.addAccessHistory({guildId,actorId,subjectType,subjectId,action:"access.revoked",
      beforeData:this.public(before),afterData:null,reason:null,createdAt:Date.now()});
    this.store.invalidateSessions(guildId,actorId);
    return before;
  }
}
module.exports={AccessService,LEVEL,DURATIONS};
