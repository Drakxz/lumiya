const {ContainerBuilder,MessageFlags}=require("discord.js");
const {TOKENS,flat,MAX_TEXT}=require("./theme");

// Apenas Markdown de apresentação: exemplos em blocos de código permanecem intactos.
function normalizeText(content){
  let fenced=false;
  return String(content).split("\n").flatMap(line=>{
    if(/^\s*```/.test(line)){fenced=!fenced;return line;}
    if(!fenced&&/^-# Painel(?: ›.*)?$/.test(line))return [];
    return fenced?line:line.replace(/^#{1,2}\s+/,"### ");
  }).join("\n");
}

function normalize(items){
  return (items||[]).map(item=>{
    const next={...item};
    if(next.type===10&&typeof next.content==="string")next.content=normalizeText(next.content);
    if(next.type===14)return {type:14,divider:true,spacing:1};
    if(next.components)next.components=normalize(next.components);
    if(next.accessory?.components)next.accessory={...next.accessory,components:normalize(next.accessory.components)};
    return next;
  });
}

// Normalização leve e segura para painéis operacionais existentes.
// Mantém IDs, opções, anexos e cores semânticas, sem adicionar cabeçalhos extras.
function canonical(payload,{accent=TOKENS.accent}={}){
  if(!payload||payload._lumiyaCanonical||!payload.components?.length)return payload;
  const raw=payload.components.map(component=>component?.toJSON?.()||component);
  if(raw.some(component=>component.type!==17))return payload;
  const styled=raw.map(component=>({
    ...component,accent_color:component.accent_color??accent,components:normalize(component.components)
  }));
  const nodes=flat(styled),texts=nodes.filter(node=>node.type===10);
  if(texts.reduce((sum,node)=>sum+node.content.length,0)>MAX_TEXT){
    const originals=flat(raw).filter(node=>node.type===10);
    texts.forEach((node,index)=>{node.content=originals[index].content;});
  }
  const heading=texts.find(node=>/^###\s+/.test(node.content));
  if(heading){
    const title=heading.content.split("\n")[0].replace(/^###\s+/,"");
    if(/^\p{L}/u.test(title)&&texts.reduce((sum,node)=>sum+node.content.length,0)+3<=MAX_TEXT)
      heading.content=heading.content.replace(/^### /,"### 🌙 ");
  }
  const components=styled.map(component=>new ContainerBuilder(component));
  return {...payload,components,_lumiyaCanonical:true,
    flags:Number(payload.flags||0)|MessageFlags.IsComponentsV2};
}
module.exports={canonical,normalize,normalizeText};
