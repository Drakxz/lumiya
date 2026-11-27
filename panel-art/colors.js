const DEFAULT_COLOR=0xC4A7E7;
let readColor=()=>undefined;

function initializeColors(db){
  db.exec("CREATE TABLE IF NOT EXISTS panel_colors(guildId TEXT PRIMARY KEY,color INTEGER NOT NULL CHECK(color BETWEEN 0 AND 16777215))");
  const read=db.prepare("SELECT color FROM panel_colors WHERE guildId=?");
  const write=db.prepare("INSERT INTO panel_colors(guildId,color) VALUES(?,?) ON CONFLICT(guildId) DO UPDATE SET color=excluded.color");
  const remove=db.prepare("DELETE FROM panel_colors WHERE guildId=?");
  readColor=id=>read.get(id)?.color;
  return {
    set(id,value){const color=parseColor(value);write.run(id,color);return color;},
    reset(id){remove.run(id);}
  };
}
function parseColor(value){
  if(typeof value!=="string"||!/^#?[a-f\d]{6}$/i.test(value.trim()))
    throw new Error("Digite uma cor hexadecimal com 6 caracteres, como #C4A7E7.");
  return parseInt(value.trim().replace(/^#/,""),16);
}
function panelColor(guild){
  const id=typeof guild==="string"?guild:guild?.id;
  return (id?readColor(id):undefined)??DEFAULT_COLOR;
}
const colorHex=color=>`#${color.toString(16).padStart(6,"0").toUpperCase()}`;
module.exports={DEFAULT_COLOR,initializeColors,parseColor,panelColor,colorHex};
