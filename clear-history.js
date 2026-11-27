const {Routes}=require("discord.js");
const SNOWFLAKE=/^\d{17,20}$/;
function anteriores(messages,before){
  return messages.filter(message=>SNOWFLAKE.test(message.id)&&BigInt(message.id)<BigInt(before));
}
function cursor(messages){
  return messages.reduce((id,message)=>BigInt(message.id)<BigInt(id)?message.id:id,messages[0].id);
}

// Busca oficial por autor, usando o mesmo REST/rate limiter do bot.
// Nunca usa tokens de usuários nem endpoints não documentados.
module.exports=async function* paginasClear({client,canal,guildId,alvoId,limiteId,antesDeVarrer=async()=>{}}){
  let varrerTudo=true;
  if(typeof client.rest?.get==="function"&&typeof Routes.guildMessagesSearch==="function"){
    console.log(`[CL] Busca direta por autor ativada no canal ${canal.id}.`);
    let before=limiteId;
    try{
      while(true){
        const query=new URLSearchParams({
          channel_id:canal.id,author_id:alvoId,max_id:before,
          limit:"25",sort_by:"timestamp",sort_order:"desc",include_nsfw:"true"
        });
        const result=await client.rest.get(Routes.guildMessagesSearch(guildId),{query});
        // Índice indisponível/incompleto: a varredura continua sendo a fonte
        // completa, sem insistir num endpoint que ainda está indexando.
        if(result.code===110000||result.doing_deep_historical_index)break;
        if(!Array.isArray(result.messages))throw new Error("Resposta inválida da busca de mensagens.");
        const raw=result.messages.flat();
        if(!raw.length){varrerTudo=false;break;}
        const validas=anteriores(raw,before).filter(message=>
          message.channel_id===canal.id&&message.author?.id===alvoId&&!message.author.bot);
        if(!validas.length)break; // Sem progresso: fallback, nunca loop infinito.
        const unicas=[...new Map(validas.map(message=>[message.id,{
          id:message.id,channelId:message.channel_id,author:message.author,
          createdTimestamp:Date.parse(message.timestamp)
        }])).values()];
        yield unicas;
        before=cursor(unicas);
        // Não usa offset, total_results nem length<25 para encerrar:
        // exclusões mudam o índice, e o Discord pode retornar páginas curtas.
      }
    }catch(error){
      if([10003,50001,50013].includes(error.code)||error.status===429)throw error;
      console.warn("[CL] Busca por autor indisponível; usando histórico do canal:",error.message);
    }
    // Evita reenviar IDs que ainda estejam no último bulk em andamento.
    await antesDeVarrer();
  }

  // Mesmo com busca completa, confere a página mais recente para cobrir o
  // atraso de indexação. Sem índice, percorre todo o histórico como antes.
  let before=limiteId;
  while(true){
    const pagina=await canal.messages.fetch({limit:100,before,cache:false});
    if(!pagina.size)break;
    const mensagens=anteriores([...pagina.values()],before);
    if(!mensagens.length)break;
    yield mensagens;
    if(!varrerTudo||pagina.size<100)break;
    before=cursor(mensagens);
  }
};
