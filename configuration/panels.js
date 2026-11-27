const {MessageFlags}=require("discord.js");
const {apply,defaults,flat,controlKey}=require("./render");
const {shell}=require("../lumiya-ui/shell");
const {panelColor,parseColor}=require("../panel-art/colors");
class PanelRegistry{
  constructor({store,client}){this.store=store;this.client=client;this.items=new Map();}
  register(definition){
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(definition.id)||typeof definition.render!=="function")throw new Error("Registro de painel inválido.");
    if(this.items.has(definition.id))throw new Error(`Painel duplicado: ${definition.id}`);
    this.items.set(definition.id,definition);return definition;
  }
  get(id){const item=this.items.get(id);if(!item)throw new Error("Este painel não está disponível.");return item;}
  list(){return [...this.items.values()];}
  async baseline(id,context){
    const result=await defaults(()=>this.get(id).render({...context,bot:context.bot||this.client.user}));
    const payload=result?.toJSON?{components:[result]}:result;
    if(!payload?.components?.length||payload.embeds?.length)throw new Error("O sistema não retornou um painel Components V2.");
    return {...payload,components:payload.components.map(c=>c.toJSON?.()||c),flags:MessageFlags.IsComponentsV2,allowedMentions:{parse:[]}};
  }
  async render(id,context,{config,preview=false}={}){
    const base=await this.baseline(id,context);
    const saved=config??this.store.panel(context.guild.id,id).data;
    const result=apply(base.components,saved,{...context,bot:context.bot||this.client.user},{preview,asset:assetId=>this.store.asset(context.guild.id,assetId)});
    result.files=[...(base.files||[]),...result.files];
    // Discord não aceita arquivos com o mesmo nome no mesmo envio.
    const serialized=JSON.stringify(result.components);
    result.files=result.files.filter((file,n,list)=>serialized.includes(`attachment://${file.name}`)&&!list.slice(0,n).some(prev=>prev.name&&prev.name===file.name));
    const definition=this.get(id);
    return shell(result,{
      guild:context.guild,bot:context.bot||this.client.user,ctx:context,
      accent:saved.color?parseColor(saved.color):panelColor(context.guild),
      path:["Painel",...(definition.category?[definition.category]:[]),definition.label],
      label:definition.label,preview
    });
  }
  async fields(id,context){
    const base=await this.baseline(id,context),nodes=flat(base.components);
    const texts=nodes.filter(c=>c.type===10).map((c,index)=>({index,content:c.content}));
    return {
      texts:texts.length?texts:[{index:0,content:`# ${this.get(id).label}`,virtual:true}],
      controls:nodes.filter(c=>controlKey(c)&&[2,3,5,6,7,8].includes(c.type)).map(c=>({
        id:controlKey(c),type:c.type,label:c.label||c.placeholder||c.custom_id,style:c.style,emoji:c.emoji,
        options:c.type===3?c.options.map(o=>({value:o.value,label:o.label,description:o.description||""})):undefined
      })),
      color:base.components.find(c=>c.type===17)?.accent_color,
      images:nodes.filter(c=>[11,12].includes(c.type)).length
    };
  }
}
module.exports={PanelRegistry};
