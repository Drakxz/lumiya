const {MessageFlags}=require("discord.js");
const {z}=require("zod");
const {parseColor}=require("../panel-art/colors");
const {safeURL}=require("./assets");
const {createHash}=require("node:crypto");
const VARIABLES=["server.name","server.icon","server.banner","server.id","server.members","server.owner",
  "bot.name","bot.avatar","user.name","user.mention","user.avatar","channel.name","date"];
const imageSchema=z.object({mode:z.enum(["default","none","guildIcon","guildBanner","botAvatar","asset"]),assetId:z.string().uuid().optional()}).strict();
const schema=z.object({
  color:z.string().regex(/^#[a-f\d]{6}$/i).optional(),
  texts:z.record(z.string().regex(/^\d+$/),z.string().min(1).max(4000)).optional(),
  subtitle:z.string().max(500).optional(),footer:z.string().max(500).optional(),
  hideTexts:z.array(z.number().int().min(1).max(39)).max(20).optional(),
  separators:z.enum(["default","none","small","large"]).optional(),
  images:z.object({top:imageSchema.optional(),main:imageSchema.optional(),bottom:imageSchema.optional(),thumbnail:imageSchema.optional(),icon:imageSchema.optional(),
    serverAvatar:imageSchema.optional(),botAvatar:imageSchema.optional(),serverBanner:imageSchema.optional()}).strict().optional(),
  components:z.record(z.string().max(100),z.object({
    label:z.string().min(1).max(80).optional(),style:z.number().int().min(1).max(4).optional(),
    emoji:z.string().max(100).optional(),placeholder:z.string().min(1).max(150).optional(),
    options:z.record(z.string().max(100),z.object({label:z.string().min(1).max(100).optional(),description:z.string().max(100).optional(),emoji:z.string().max(100).optional()}).strict()).optional()
  }).strict()).optional()
}).strict();
function flat(items){return (items||[]).flatMap(c=>[c,...flat(c.components),...(c.accessory?[c.accessory]:[])]);}
const cleanName=value=>String(value??"").replace(/[*_`~|<>]/g,"").replace(/@/g,"@\u200b").replace(/[\r\n]/g," ").slice(0,100);
function variables(text,ctx){
  const g=ctx.guild,b=ctx.bot,u=ctx.user;
  const values={
    "server.name":cleanName(g?.name),"server.icon":g?.iconURL?.({size:512})||"",
    "server.banner":g?.bannerURL?.({size:1024})||"","server.id":g?.id||"","server.members":String(g?.memberCount??0),
    "server.owner":g?.ownerId?`<@${g.ownerId}>`:"",
    "bot.name":cleanName(b?.username||"Lumiya"),"bot.avatar":b?.displayAvatarURL?.({size:256})||"",
    "user.name":cleanName(u?.displayName||u?.username||"visitante"),"user.mention":u?.id?`<@${u.id}>`:"",
    "user.avatar":u?.displayAvatarURL?.({size:256})||"","channel.name":cleanName(ctx.channel?.name||""),
    date:new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo"}).format(ctx.now||new Date())
  };
  return text.replace(/\{([^{}]+)\}/g,(token,key)=>Object.hasOwn(values,key)?values[key]:token);
}
function emoji(input){
  if(!input)return undefined;
  const match=/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/.exec(input);
  if(match)return {id:match[3],name:match[2],animated:match[1]==="a"};
  if(input.length>16||/[<>]/.test(input))throw new Error("Use um emoji Unicode ou um emoji personalizado válido.");
  return {name:input};
}
function availableEmoji(input,ctx){
  const parsed=emoji(input);
  if(!parsed?.id)return parsed;
  const cached=ctx.guild?.emojis?.cache?.get(parsed.id)||ctx.client?.emojis?.cache?.get(parsed.id);
  if(!cached||cached.available===false)return {name:"💜"};
  const external=cached.guild?.id&&cached.guild.id!==ctx.guild?.id;
  if(external&&ctx.channel?.permissionsFor&&ctx.bot&&!ctx.channel.permissionsFor(ctx.bot)?.has?.(require("discord.js").PermissionFlagsBits.UseExternalEmojis))return {name:"💜"};
  return parsed;
}
function configuredText(text,ctx){
  return variables(text,ctx).replace(/<a?:[a-zA-Z0-9_]+:\d{17,20}>/g,token=>{
    const resolved=availableEmoji(token,ctx);
    return resolved?.id?token:resolved?.name||"💜";
  });
}
const controlKey=c=>c.custom_id?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,"{session}")||
  (c.type===2&&c.url?`link:${createHash("sha256").update(c.url).digest("hex").slice(0,16)}`:null);
function validate(config){const parsed=schema.safeParse(config);if(!parsed.success)throw new Error("A personalização contém campos inválidos ou textos acima do limite.");return parsed.data;}
function validateComponents(components){
  const nodes=flat(components);
  if(nodes.length>40)throw new Error("Este painel excede os 40 componentes do Discord. Remova imagens ou textos opcionais.");
  const texts=nodes.filter(c=>c.type===10);
  if(texts.some(c=>!c.content?.length||c.content.length>4000)||texts.reduce((n,c)=>n+c.content.length,0)>4000)
    throw new Error("O painel deve ter até 4.000 caracteres. Reduza os textos.");
  const ids=nodes.filter(c=>c.custom_id).map(c=>c.custom_id);
  if(new Set(ids).size!==ids.length)throw new Error("Identificadores duplicados no painel.");
  for(const node of nodes){
    if(node.type===1&&(node.components?.length>5))throw new Error("Uma linha de controles pode ter até cinco botões.");
    if(node.type===3&&(!node.options?.length||node.options.length>25))throw new Error("O menu deve ter entre uma e 25 opções.");
    if(node.type===17&&(node.components||[]).some(c=>c.type===17))throw new Error("Containers não podem ser aninhados.");
    if(node.type===9&&!node.components?.length)throw new Error("Esta seção precisa manter pelo menos um texto.");
    if(node.type===12&&(!node.items?.length||node.items.length>10))throw new Error("Uma galeria deve ter entre uma e dez imagens.");
  }
  return components;
}
function apply(raw,config,ctx,{preview=false,asset=()=>null}={}){
  config=validate(config);
  const components=structuredClone(raw),attachments=[],nodes=flat(components);
  const textNodes=nodes.filter(c=>c.type===10);
  if(!textNodes.length&&config.texts?.[0]){
    const container=components.find(c=>c.type===17);
    if(container)container.components.unshift({type:10,content:configuredText(config.texts[0],ctx)});
  }
  for(const [index,node]of textNodes.entries())if(config.texts?.[index]!==undefined)node.content=configuredText(config.texts[index],ctx);
  const imageURL=setting=>{
    if(!setting||["none","default"].includes(setting.mode))return null;
    if(setting.mode==="guildIcon")return ctx.guild?.iconURL?.({size:512})||ctx.bot?.displayAvatarURL?.({size:256})||null;
    if(setting.mode==="guildBanner")return ctx.guild?.bannerURL?.({size:1024})||ctx.guild?.iconURL?.({size:512})||null;
    if(setting.mode==="botAvatar")return ctx.bot?.displayAvatarURL?.({size:512})||null;
    const stored=asset(setting.assetId);
    if(!stored)throw new Error("Uma imagem deste rascunho não está disponível neste servidor.");
    const name=`lumiya-${stored.id}.png`;
    if(!attachments.some(file=>file.name===name))attachments.push({attachment:Buffer.from(stored.bytes),name});
    return `attachment://${name}`;
  };
  let index=0;
  function rewrite(items){
    const result=[];
    for(const c of items){
      if(c.type===10){const n=index++;if(config.hideTexts?.includes(n))continue;}
      if(c.type===14){
        if(config.separators==="none")continue;
        if(["small","large"].includes(config.separators))c.spacing=config.separators==="large"?2:1;
      }
      const change=config.components?.[controlKey(c)];
      if(change){
        if(c.type===2){
          if(change.label)c.label=variables(change.label,ctx).slice(0,80);
          if(change.style&&c.style!==5)c.style=change.style;
          if(change.emoji!==undefined){const value=availableEmoji(change.emoji,ctx);if(value)c.emoji=value;else delete c.emoji;}
        }
        if([3,5,6,7,8].includes(c.type)&&change.placeholder)c.placeholder=variables(change.placeholder,ctx).slice(0,150);
        if(c.type===3)for(const option of c.options){
          const update=change.options?.[option.value];if(!update)continue;
          if(update.label)option.label=variables(update.label,ctx).slice(0,100);
          if(update.description!==undefined){const value=variables(update.description,ctx).slice(0,100);if(value)option.description=value;else delete option.description;}
          if(update.emoji!==undefined){const value=availableEmoji(update.emoji,ctx);if(value)option.emoji=value;else delete option.emoji;}
        }
      }
      if(c.components)c.components=rewrite(c.components);
      if(c.type===9&&!c.components.length){
        if(c.accessory?.type===2)throw new Error("Este texto é necessário para manter o botão da seção; ele não pode ser ocultado.");
        continue;
      }
      if(c.type===9&&c.accessory?.type===11&&config.images?.thumbnail?.mode==="none"){result.push(...c.components);continue;}
      if(c.type===9&&c.accessory?.type===11&&config.images?.thumbnail&&config.images.thumbnail.mode!=="default"){
        const url=imageURL(config.images.thumbnail);
        if(url)c.accessory.media={url};else{result.push(...c.components);continue;}
      }
      if(c.type===17){
        if(config.color)c.accent_color=parseColor(config.color);
        const main=config.images?.main;
        if(main&&main.mode!=="default")c.components=c.components.filter(item=>item.type!==12);
        const gallery=setting=>{const url=imageURL(setting);return url?{type:12,items:[{media:{url}}]}:null;};
        const top=gallery(config.images?.top),bottom=gallery(config.images?.bottom),middle=gallery(main);
        if(top)c.components.unshift(top);
        if(middle){
          const position=c.components.findIndex(item=>item.type===1);
          c.components.splice(position<0?c.components.length:position,0,middle);
        }
        if(config.subtitle)c.components.splice(top?2:1,0,{type:10,content:`-# ${configuredText(config.subtitle,ctx)}`});
        if(config.footer)c.components.push({type:10,content:`-# ${configuredText(config.footer,ctx)}`});
        if(bottom)c.components.push(bottom);
        const serverBanner=gallery(config.images?.serverBanner);
        if(serverBanner)c.components.splice(top?1:0,0,serverBanner);
        for(const [slot,label]of [["serverAvatar",ctx.guild?.name||"Servidor"],["botAvatar",ctx.bot?.username||"Lumiya"]]){
          const setting=config.images?.[slot];
          if(!setting||["none","default"].includes(setting.mode))continue;
          const url=imageURL(setting);
          if(url){
            const position=c.components.findIndex(item=>item.type===1);
            const avatar={type:9,components:[{type:10,content:`-# ${cleanName(label)}`}],accessory:{type:11,media:{url}}};
            c.components.splice(position<0?c.components.length:position,0,avatar);
          }
        }
        const thumbnail=config.images?.thumbnail;
        if(thumbnail&&thumbnail.mode!=="default"&&thumbnail.mode!=="none"&&!flat(c.components).some(n=>n.type===11)){
          const url=imageURL(thumbnail),pos=c.components.findIndex(n=>n.type===10);
          if(url&&pos>=0)c.components.splice(pos,1,{type:9,components:[c.components[pos]],accessory:{type:11,media:{url}}});
        }
        if(config.images?.icon&&config.images.icon.mode!=="default"){
          const url=imageURL(config.images.icon);if(url)c.components.unshift({type:12,items:[{media:{url},description:"Ícone personalizado"}]});
        }
      }
      result.push(c);
    }
    // Evita separadores órfãos após ocultar campos.
    return result.filter((c,n,list)=>c.type!==14||(n>0&&n<list.length-1&&list[n-1].type!==14));
  }
  const result=rewrite(components);
  if(preview)flat(result).forEach((c,n)=>{
    if(c.custom_id)c.custom_id=`lc:preview:${n}`;
    if([2,3,5,6,7,8].includes(c.type))c.disabled=true;
  });
  validateComponents(result);
  return {components:result,files:attachments,flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
}
module.exports={VARIABLES,flat,variables,emoji,controlKey,validate,validateComponents,apply,safeURL,...require("./runtime")};
