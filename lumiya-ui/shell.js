const {MessageFlags}=require("discord.js");
const theme=require("./theme");

function normalizeComponents(items){
  return require("./canonical").normalize(items);
}
// Compartilha o acabamento visual sem adicionar um container de navegação
// antes do conteúdo original do painel.
function shell(payload,{accent=theme.TOKENS.accent,preview=false}={}){
  if(payload?._lumiyaCanonical)return payload;
  const raw=(payload.components||[]).map(component=>component?.toJSON?.()||component);
  const body=raw.map(component=>({
    ...component,
    ...(component.type===17?{accent_color:component.accent_color??accent}:{}),
    ...(component.components?{components:normalizeComponents(component.components)}:{})
  }));
  const components=body;
  if(preview)theme.flat(components).forEach((component,index)=>{
    if(component.custom_id)component.custom_id=`lc:preview:${index}`;
    if([2,3,5,6,7,8].includes(component.type))component.disabled=true;
  });
  return theme.validatePayload({
    ...payload,components,files:payload.files||[],
    flags:MessageFlags.IsComponentsV2|(preview?MessageFlags.Ephemeral:(Number(payload.flags||0)&MessageFlags.Ephemeral)),
    allowedMentions:{parse:[]}
  });
}
module.exports={shell,normalizeComponents};
