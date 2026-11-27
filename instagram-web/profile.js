const publicBadges={
  Staff:["Equipe do Discord","Insígnia pública de funcionário do Discord."],
  Partner:["Parceiro do Discord","Insígnia pública do programa de parceiros do Discord."],
  Hypesquad:["HypeSquad Events","Participante do programa HypeSquad Events."],
  HypeSquadOnlineHouse1:["Bravery","Casa Bravery do HypeSquad."],
  HypeSquadOnlineHouse2:["Brilliance","Casa Brilliance do HypeSquad."],
  HypeSquadOnlineHouse3:["Balance","Casa Balance do HypeSquad."],
  BugHunterLevel1:["Bug Hunter","Insígnia pública de caçador de bugs do Discord."],
  BugHunterLevel2:["Bug Hunter nível 2","Insígnia pública de caçador de bugs nível 2."],
  PremiumEarlySupporter:["Apoiador inicial","Insígnia Early Supporter: apoiador inicial do Discord."],
  VerifiedDeveloper:["Desenvolvedor pioneiro","Insígnia pública de desenvolvedor verificado pioneiro."],
  CertifiedModerator:["Moderador certificado","Insígnia pública de moderação do Discord."],
  ActiveDeveloper:["Desenvolvedor ativo","Insígnia pública Active Developer do Discord."]
};

module.exports=function profile(member,{guild,admin,moderator,vip},user=member.user,{nitro}={}){
  const badges=[{id:"member",kind:"member",label:"Membro da comunidade",description:"Participa deste servidor com sua conta do Discord."}];
  const accountBadges=[];
  const owner=member.id===guild.ownerId;
  if(owner)badges.push({id:"owner",kind:"owner",label:"Dono do servidor",description:"Proprietário deste servidor no Discord."});
  else if(admin)badges.push({id:"admin",kind:"admin",label:"Administrador",description:"Tem a permissão Administrador neste servidor."});
  else if(moderator)badges.push({id:"moderator",kind:"moderator",label:"Equipe de moderação",description:"Possui um cargo de moderação configurado neste servidor."});
  if(vip)badges.push({id:"vip",kind:"vip",label:"VIP",description:"Possui um cargo VIP configurado para esta comunidade."});
  if(member.premiumSinceTimestamp)badges.push({id:"booster",kind:"booster",label:"Impulsionador",description:"Está impulsionando este servidor no Discord."});
  for(const flag of (user.flags??member.user.flags)?.toArray?.()||[]){
    const badge=publicBadges[flag];
    if(badge){const item={id:`discord:${flag}`,kind:"discord",label:badge[0],description:badge[1]};badges.push(item);accountBadges.push(item);}
  }
  if(nitro&&[1,2,3].includes(nitro.type)&&Number.isFinite(nitro.checkedAt)&&nitro.checkedAt<=Date.now()&&Date.now()-nitro.checkedAt<12*3600000){
    const label={1:"Nitro Classic",2:"Nitro",3:"Nitro Basic"}[nitro.type];
    accountBadges.push({id:"discord:Nitro",kind:"discord",label,description:`${label} confirmado pelo Discord no último login. A assinatura pode ter mudado desde essa consulta.`,checkedAt:nitro.checkedAt});
  }
  if(member.premiumSinceTimestamp)accountBadges.push({id:"discord:Boost",kind:"discord",label:"Boost neste servidor",description:`Impulsionamento ativo em ${guild.name||"este servidor"}. A API não informa o nível global da insígnia de boost.`,since:member.premiumSinceTimestamp});
  return {badges,accountBadges,banner:member.displayBannerURL?.({size:1024})||null,
    accountCreatedAt:user.createdTimestamp||member.user.createdTimestamp||null,boostingSince:member.premiumSinceTimestamp||null};
};
