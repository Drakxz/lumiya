// Nomes internos e IDs de controles continuam estáveis. Somente a forma de
// digitar os comandos muda; todos os prefixos antigos permanecem como aliases.
const SHORTCUTS=Object.freeze({
  "!wlcargos":"!wl",
  "!cargos":"!cargo",
  "!cargosgames":"!jogos",
  "!cargoinicial":"!inicial",
  "!protecaouser":"!nomes",
  "!midiaadmin":"!midia",
  "!midiarevisao":"!revisao",
  "!instagram":"!insta",
  "!instaverificacao":"!verificar",
  "!instapainel":"!fotos",
  "!instaticket":"!ticket",
  "!comandos":"!ajuda",
  "!painelcomandos":"!menu",
  "!backuppainel":"!bkpainel",
  "!banpainel":"!bans",
  "!limitebans":"!limiteban",
  "!desbanir":"!unban",
  "!ticketconfig":"!tickets",
  "!ticketstats":"!metas",
  "!upcargos":"!up",
  "!unmutepainel":"!unmute",
  "!corpainel":"!cor",
  "!migracao":"!migrar",
  "!autocall":"!call"
});

function shortCommandText(text){
  return text.replace(/![a-z][a-z0-9_-]*/gi,token=>SHORTCUTS[token.toLowerCase()]||token);
}
function simplifyCommand(definition){
  const prefix=definition.prefix,newTrigger=prefix&&SHORTCUTS[prefix.trigger];
  if(!newTrigger)return definition;
  const aliases=[...new Set([prefix.trigger,...(prefix.aliases||[])])].filter(alias=>alias!==newTrigger);
  return {
    ...definition,
    examples:definition.examples&&[...new Set(definition.examples.map(shortCommandText))],
    prefix:{
      ...prefix,trigger:newTrigger,aliases,
      usage:[...new Set((prefix.usage||[prefix.trigger]).map(shortCommandText))]
    }
  };
}
module.exports={SHORTCUTS,shortCommandText,simplifyCommand};
