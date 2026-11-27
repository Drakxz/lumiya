const {SeparatorBuilder,SeparatorSpacingSize,escapeMarkdown}=require('discord.js');
const ACCENT=0;
const divider=()=>new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const permissionLabel={close:'Fechamento',transfer:'Transferência',participants:'Participantes'};
const enabled=value=>value===false?'Desativado':'Ativado';
const shorten=(value,max=100)=>String(value||'').length>max?`${String(value).slice(0,max-1)}…`:String(value||'');
// Conteúdo livre é exibido em uma linha, sem Markdown ou menções injetadas.
const safeText=(value,max=100)=>escapeMarkdown(shorten(String(value??'').replace(/\s+/g,' ').trim(),max).replace(/@/g,'＠').replace(/[<>]/g,''));
const statusLabel=(value,assigned=false)=>value==='open'?(assigned?'Em atendimento':'Aguardando'):({closed:'Fechado',archived:'Fechado',configuration:'Configuração'}[value]||safeText(value,40));
const counted=(value,singular,plural)=>`${value} ${Number(value)===1?singular:plural}`;
module.exports={ACCENT,divider,permissionLabel,enabled,shorten,safeText,statusLabel,counted};
