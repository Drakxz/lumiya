const emojis=require("./emojis");
const {
  ContainerBuilder,TextDisplayBuilder,SeparatorBuilder,SectionBuilder,ThumbnailBuilder,
  ActionRowBuilder,ButtonBuilder,ButtonStyle,StringSelectMenuBuilder,ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,UserSelectMenuBuilder,MessageFlags,ModalBuilder,LabelBuilder,
  TextInputBuilder,TextInputStyle
}=require("discord.js");

const TOKENS=Object.freeze({
  accent:0xC4A7E7,
  lilac:0xE8D8F5,
  rose:0xF6DCEA,
  white:0xFFFFFF,
  ink:0xF7F3FB
});
const EMOJI=Object.freeze({
  moon:{id:"1575609386385019024",name:"i_luaestrelaroxo",fallback:"🌙"},
  star:{id:"1575609412566130881",name:"0j_purplestar1",animated:true,fallback:"✨"},
  heart:{id:"1575609434137296967",name:"a_heartpurple",animated:true,fallback:"💜"}
});
const MAX_COMPONENTS=40;
const MAX_TEXT=4000;

function cleanName(value){
  return String(value??"").replace(/[*_`~|<>]/g,"").replace(/@/g,"@\u200b").replace(/[\r\n]+/g," ").slice(0,100);
}
function emojiToken(ctx,key){
  const item=EMOJI[key];if(!item)return key;
  const cached=ctx?.guild?.emojis?.cache?.get(item.id)||ctx?.client?.emojis?.cache?.get(item.id);
  return cached&&cached.available!==false?`<${item.animated?"a":""}:${cached.name||item.name}:${item.id}>`:item.fallback;
}
function emojiObject(ctx,key){
  const token=emojiToken(ctx,key),match=/^<(a?):([^:]+):(\d{17,20})>$/.exec(token);
  return match?{id:match[3],name:match[2],animated:match[1]==="a"}:{name:token};
}
const text=(content,{small=false,plain=false}={})=>new TextDisplayBuilder().setContent(
  `${small?"-# ":""}${plain?content:emojis.panelText(content)}`.slice(0,MAX_TEXT)
);
const separator=(spacing=1)=>new SeparatorBuilder().setDivider(true).setSpacing(spacing);
const row=(...items)=>new ActionRowBuilder().addComponents(...items.filter(Boolean));
const breadcrumb=(...parts)=>text(parts.filter(Boolean).map(cleanName).join(" › "),{small:true});

function container(accent=TOKENS.accent,parts=[]){
  const result=new ContainerBuilder().setAccentColor(accent);
  for(const part of parts.filter(Boolean)){
    const type=part.toJSON?.().type;
    if(type===10)result.addTextDisplayComponents(part);
    else if(type===14)result.addSeparatorComponents(part);
    else if(type===1)result.addActionRowComponents(part);
    else if(type===9)result.addSectionComponents(part);
    else if(type===12)result.addMediaGalleryComponents(part);
  }
  return result;
}
function section(texts,thumbnailURL,accessory){
  const parts=texts.filter(Boolean);
  if(!thumbnailURL&&!accessory)return parts;
  const builder=new SectionBuilder().addTextDisplayComponents(...parts);
  if(thumbnailURL)builder.setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailURL));
  else if(accessory)builder.setButtonAccessory(accessory);
  return builder;
}
function stateLine(label,active){
  return `${active?emojis.TOKENS.ativo:emojis.TOKENS.desativado} ${label} · ${active?"ativo":"desativado"}`;
}
function valueLine(label,value){
  return `📁 ${label} · ${value}`;
}
function statusContainer(lines,accent=TOKENS.lilac){
  return container(accent,[text("### Estado do sistema"),separator(),text(lines.filter(Boolean).join("\n"))]);
}
const feedback={
  success:message=>`♡ Prontinho! ${message}`,
  saved:()=>"♡ Prontinho! Suas alterações foram salvas.",
  error:message=>`Ops! ${message} Pode tentar novamente?`,
  denied:()=>"Essa configuração está disponível apenas para pessoas autorizadas.",
  empty:()=>"Ainda não temos nada por aqui. Que tal começar a configurar?",
  enabled:()=>`${emojis.TOKENS.ativo} Tudo certo! Já estou cuidando disso por você. ♡`,
  disabled:()=>`${emojis.TOKENS.desativado} Certo! Vou ficar de olho quando você quiser voltar. ♡`,
  expired:()=>"Esta tela expirou. Abra /config novamente para continuar. ♡"
};

function button(customId,label,{style=ButtonStyle.Secondary,emoji,disabled=false}={}){
  const builder=new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
  if(emoji)builder.setEmoji(typeof emoji==="string"?{name:emoji}:emoji);
  return builder;
}
function nav(s,action,label,options={}){
  const customId=s?`lc:${action}:${s.id}:${s.revision}`:action;
  return button(customId,label,options);
}
function page({
  path=[],title,subtitle="",description="",guild,bot,ctx,
  body=[],rows=[],footer="",ephemeral=true,accent=TOKENS.accent
}){
  const context=ctx||{guild,bot};
  const thumbnail=guild?.iconURL?.({size:256})||bot?.displayAvatarURL?.({size:256});
  const headerParts=[text(`### ${title}`)];
  if(subtitle)headerParts.push(text(subtitle,{small:true}));
  const header=container(accent,thumbnail?
    [section(headerParts,thumbnail),separator(),...(description?[text(description)]:[])]:
    [...headerParts,separator(),...(description?[text(description)]:[])]);
  const components=[header,...body.filter(Boolean)];
  if(rows.length){
    components.push(container(accent,rows.filter(Boolean)));
  }
  if(footer)components.push(container(TOKENS.lilac,[text(footer,{small:true})]));
  return {_lumiyaCanonical:true,components,flags:MessageFlags.IsComponentsV2|(ephemeral?MessageFlags.Ephemeral:0),allowedMentions:{parse:[]}};
}
function modal(s,action,title,fields=[]){
  const builder=new ModalBuilder().setCustomId(s?`lc:${action}:${s.id}:${s.revision}`:action).setTitle(title.slice(0,45));
  for(const field of fields){
    let component;
    if(field.type==="select"){
      component=new StringSelectMenuBuilder().setCustomId(field.id).setPlaceholder((field.placeholder||"Selecione").slice(0,100))
        .addOptions((field.options||[]).slice(0,25).map(option=>({...option,default:Boolean(field.defaults?.includes(option.value)),
          label:String(option.label).slice(0,100),description:option.description?.slice(0,100)})));
      if(field.minValues!==undefined)component.setMinValues(Math.max(0,Math.min(25,field.minValues)));
      if(field.maxValues!==undefined)component.setMaxValues(Math.max(1,Math.min(25,field.maxValues)));
      if(field.required===false)component.setRequired(false);
    }else if(field.type==="channel"){
      component=new ChannelSelectMenuBuilder().setCustomId(field.id).setPlaceholder((field.placeholder||"Escolha um canal").slice(0,100));
      if(field.minValues!==undefined)component.setMinValues(field.minValues);
      if(field.maxValues!==undefined)component.setMaxValues(field.maxValues);
    }else if(field.type==="role"){
      component=new RoleSelectMenuBuilder().setCustomId(field.id).setPlaceholder((field.placeholder||"Escolha um cargo").slice(0,100));
      if(field.minValues!==undefined)component.setMinValues(field.minValues);
      if(field.maxValues!==undefined)component.setMaxValues(field.maxValues);
      if(field.required===false)component.setRequired(false);
    }else if(field.type==="user"){
      component=new UserSelectMenuBuilder().setCustomId(field.id).setPlaceholder((field.placeholder||"Escolha uma pessoa").slice(0,100));
      if(field.minValues!==undefined)component.setMinValues(field.minValues);
      if(field.maxValues!==undefined)component.setMaxValues(field.maxValues);
      if(field.required===false)component.setRequired(false);
    }else{
      component=new TextInputBuilder().setCustomId(field.id)
        .setStyle(field.paragraph?TextInputStyle.Paragraph:TextInputStyle.Short)
        .setRequired(field.required!==false).setMaxLength(Math.min(4000,field.max||4000));
      if(field.value)component.setValue(String(field.value).slice(0,field.max||4000));
      if(field.placeholder)component.setPlaceholder(field.placeholder.slice(0,100));
    }
    const label=new LabelBuilder().setLabel(field.label.slice(0,45));
    if(field.description)label.setDescription(field.description.slice(0,100));
    if(field.type==="select")label.setStringSelectMenuComponent(component);
    else if(field.type==="channel")label.setChannelSelectMenuComponent(component);
    else if(field.type==="role")label.setRoleSelectMenuComponent(component);
    else if(field.type==="user")label.setUserSelectMenuComponent(component);
    else label.setTextInputComponent(component);
    builder.addLabelComponents(label);
  }
  return builder;
}

function flat(components){
  return (components||[]).flatMap(component=>{
    const raw=component.toJSON?.()||component;
    return [raw,...flat(raw.components),...(raw.accessory?[raw.accessory]:[])];
  });
}
function validatePayload(payload){
  const nodes=flat(payload.components);
  if(nodes.length>MAX_COMPONENTS)throw new Error("Este painel excede os 40 componentes do Discord.");
  const total=nodes.filter(node=>node.type===10).reduce((sum,node)=>sum+String(node.content||"").length,0);
  if(total>MAX_TEXT)throw new Error("Este painel excede o limite de texto do Discord.");
  return payload;
}

function onboarding(ctx,systems){
  const moon=emojiToken(ctx,"moon"),star=emojiToken(ctx,"star"),heart=emojiToken(ctx,"heart");
  const name=cleanName(ctx.guild?.name);
  const introParts=[
    text(`### ${moon} Oii, ${name}! Eu sou a Lumiya! ♡`),
    text("Sua nova companheira de moderação, segurança e gerenciamento. Estou aqui para deixar seu servidor mais seguro, organizado e especial!",{small:true}),
    text(`${heart} Tudo o que você precisa, em um só lugar.`)
  ];
  const avatar=ctx.bot?.displayAvatarURL?.({size:256});
  const intro=container(TOKENS.accent,avatar?[section(introParts,avatar)]:introParts);
  const options=(systems||[]).slice(0,25).map(system=>({
    label:system.label,value:system.id,description:system.description?.slice(0,100)
  }));
  const start=container(TOKENS.lilac,[
    text(`### ${star} Vamos começar?`),
    text("Escolha uma função abaixo para começar a personalizar sua experiência comigo.",{small:true}),
    ...(options.length?[row(new StringSelectMenuBuilder().setCustomId("lc:quick").setPlaceholder("Selecione o que deseja configurar...").addOptions(options))]:[]),
    row(button("lc:open","Central de configurações",{style:ButtonStyle.Primary,emoji:emojiObject(ctx,"moon")}))
  ]);
  return validatePayload({_lumiyaCanonical:true,components:[intro,start],flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}});
}

module.exports={
  TOKENS,EMOJI,MAX_COMPONENTS,MAX_TEXT,cleanName,emojiToken,emojiObject,text,separator,row,breadcrumb,
  container,section,stateLine,valueLine,statusContainer,feedback,button,nav,page,modal,flat,
  validatePayload,onboarding,emojis
};
