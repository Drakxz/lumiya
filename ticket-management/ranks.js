const {RoleSelectMenuBuilder,StringSelectMenuBuilder}=require('discord.js');
const {AREAS,LABEL}=require('./areas');
const {safeText,shorten,divider}=require('./appearance');
module.exports=function({config,saveConfig,card,text,row,button,respond,denied}){
  async function panel(i,area){
    const c=config(i.guildId),ids=c[`${area}Ranks`]||[],valid=ids.filter(id=>i.guild.roles.cache.has(id));
    const out=card(area,`# Promoções de ${LABEL[area]}\n-# Ordem do primeiro ao último cargo. Ajuste as posições antes de usar.`).addSeparatorComponents(divider())
      .addTextDisplayComponents(text(valid.length?valid.map((id,n)=>`${n+1}. ${safeText(i.guild.roles.cache.get(id).name,60)}`).join('\n'):'-# Nenhuma sequência configurada.'))
      .addActionRowComponents(row(new RoleSelectMenuBuilder().setCustomId(`tg:cfg-rank-save:${area}`).setPlaceholder('Escolher cargos da sequência').setMinValues(0).setMaxValues(25).setDefaultRoles(...valid)));
    if(valid.length)out.addActionRowComponents(row(new StringSelectMenuBuilder().setCustomId(`tg:cfg-rank-pick:${area}`).setPlaceholder('Selecionar cargo para reordenar').addOptions(valid.map((id,n)=>({label:shorten(`${n+1}. ${i.guild.roles.cache.get(id).name}`,100),value:id})))));
    return respond(i,out);
  }
  return async function handle(i,action,area,parts){
    if(!AREAS.includes(area))return denied(i);
    await i.guild.roles.fetch();const c=config(i.guildId);
    if(action==='cfg-ranks')return panel(i,area);
    if(action==='cfg-rank-save'){
      const ids=[...new Set(i.values||[])];if(ids.length>25)return denied(i);
      for(const id of ids){const r=i.guild.roles.cache.get(id);if(!(c[`${area}Team`]||[]).includes(id)||!r||r.managed||id===i.guildId)return respond(i,card(area,'# Cargo inválido\n-# Selecione apenas cargos da lista da equipe desta área.'));}
      const previous=c[`${area}Ranks`]||[];
      c[`${area}Ranks`]=[...previous.filter(id=>ids.includes(id)),...ids.filter(id=>!previous.includes(id))];
      saveConfig(i,area,c);return panel(i,area);
    }
    const ids=c[`${area}Ranks`]||[];
    if(action==='cfg-rank-pick'){
      const id=i.values?.[0],index=ids.indexOf(id);if(index<0)return denied(i);
      return respond(i,card(area,`# Ordenar sequência\n**Cargo:** ${safeText(i.guild.roles.cache.get(id)?.name||id)}\n**Nível atual:** ${index+1}`).addActionRowComponents(row(button(`tg:cfg-rank-move:${area}:${id}:up`,'Mover antes').setDisabled(index===0),button(`tg:cfg-rank-move:${area}:${id}:down`,'Mover depois').setDisabled(index===ids.length-1),button(`tg:cfg-ranks:${area}`,'Voltar'))));
    }
    if(action==='cfg-rank-move'){
      const index=ids.indexOf(parts[3]),step=parts[4]==='up'?-1:parts[4]==='down'?1:0,next=index+step;
      if(index<0||!step||next<0||next>=ids.length)return denied(i);
      [ids[index],ids[next]]=[ids[next],ids[index]];c[`${area}Ranks`]=ids;saveConfig(i,area,c);return panel(i,area);
    }return denied(i);
  };
};
