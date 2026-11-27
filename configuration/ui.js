const theme=require("../lumiya-ui/theme");
const {ButtonStyle,StringSelectMenuBuilder}=require("discord.js");

const ACCENT=theme.TOKENS.accent;
const brand=(ctx,key)=>theme.emojiToken(ctx,key);
const brandEmoji=(ctx,key)=>theme.emojiObject(ctx,key);
const text=theme.text;
const sep=()=>theme.separator(1);
const row=theme.row;
const cid=(s,action)=>s?`lc:${action}:${s.id}:${s.revision}`:action;
const button=(s,action,label,options=ButtonStyle.Secondary)=>theme.button(cid(s,action),label,
  typeof options==="object"?options:{style:options});
function menu(s,action,placeholder,options,{page=0,size=20}={}){
  const selected=(options||[]).slice(page*size,(page+1)*size);
  if(!selected.length)return null;
  return row(new StringSelectMenuBuilder().setCustomId(cid(s,action)).setPlaceholder(placeholder)
    .addOptions(selected.map(option=>({...option,label:String(option.label).slice(0,100),description:option.description?.slice(0,100)}))));
}
function card(title,body,components=[],{guild,color=ACCENT,thumbnail=false}={}){
  const parts=[theme.text(title)];
  if(body)parts.push(theme.separator(),theme.text(body));
  for(const component of components.filter(Boolean))parts.push(component);
  const icon=thumbnail&&guild?.iconURL?.({size:256});
  const header=icon?theme.section(parts,icon):parts;
  return theme.validatePayload({
    components:[theme.container(color,icon?[header]:header)],
    flags:require("discord.js").MessageFlags.IsComponentsV2|require("discord.js").MessageFlags.Ephemeral,
    allowedMentions:{parse:[]}
  });
}
const categoryOptions=systems=>(systems||[]).map(system=>({
  label:system.label,value:system.id,description:system.description
}));
module.exports={
  ...theme,ACCENT,brand,brandEmoji,text,sep,row,cid,button,menu,card,categoryOptions,
  onboarding:theme.onboarding,cleanName:theme.cleanName
};
