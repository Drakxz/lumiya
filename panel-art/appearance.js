const {ContainerBuilder}=require("discord.js");
const settings=require("./settings.json");
const {panelColor}=require("./colors");

function panelImagesEnabled(guild){
  const id=typeof guild==="string"?guild:guild?.id;
  return settings[id]?.imagesEnabled!==false;
}

// Only call for general panels, never for member publications or moderation media.
function removePanelImages(components){
  const result=[];
  for(const original of components){
    const component=structuredClone(original);
    if(component.type===12||component.type===11)continue;
    if(component.type===9&&component.accessory?.type===11){
      result.push(...removePanelImages(component.components||[]));
      continue;
    }
    if(component.components)component.components=removePanelImages(component.components);
    if(component.type===14&&(!result.length||result.at(-1).type===14))continue;
    result.push(component);
  }
  if(result.at(-1)?.type===14)result.pop();
  return result;
}

function applyPanelAppearance(container,guild,panelId,context){
  const raw=container.toJSON();
  raw.accent_color=panelColor(guild);
  if(!panelImagesEnabled(guild))raw.components=removePanelImages(raw.components);
  const styled=require("../lumiya-ui/canonical").canonical({components:[new ContainerBuilder(raw)]}).components[0];
  return require("../configuration/runtime").decorate(styled,guild,panelId,context);
}
module.exports={panelImagesEnabled,removePanelImages,applyPanelAppearance};
