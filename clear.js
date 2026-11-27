const { PermissionFlagsBits } = require("discord.js");
const paginasClear = require("./clear-history");

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;
// Evita enviar ao bulk mensagens prestes a completar 14 dias durante a fila REST.
const AGE_MARGIN = 60_000;
const SNOWFLAKE = /^\d{17,20}$/;
const REQUIRED = [
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.AddReactions
];
const STOP_CODES = new Set([10003, 50001, 50013]);

module.exports = function instalarClear({ client }) {
  const commands = require("./command-system/registry").getCommandRegistry(client);
  const inProgress = new Map();
  client.rest?.on?.("rateLimited",data=>{
    if(!inProgress.size || (!data.global&&!data.route?.includes("/messages")))return;
    const operacao=data.route?.endsWith("/search")?"busca por autor":
      data.route?.endsWith("/bulk-delete")?"bulk":data.method==="GET"?"histórico":"exclusão";
    console.warn(`[CL] Limite do Discord (${operacao}): ${Math.ceil(Number(data.timeToReset)||0)}ms de espera; global=${Boolean(data.global)}; ${inProgress.size} limpeza(s) ativa(s).`);
  });

  async function apagarIndividual(canal, id) {
    try {
      // Sempre usa o manager do canal autorizado, nunca um canal vindo da busca.
      await canal.messages.delete(id);
      return true;
    } catch (error) {
      if (error.code === 10008) return true; // Já apagada por usuário/moderação/outra limpeza.
      if (STOP_CODES.has(error.code)) throw error;
      console.warn(`[CL] Não foi possível apagar a mensagem ${id} em ${canal.id}:`, error.message);
      return false;
    }
  }

  async function apagarPagina(canal, mensagens) {
    let apagadas = 0;
    const limite = Date.now() - TWO_WEEKS + AGE_MARGIN;
    const recentes = [];
    const individuais = [];
    for (const mensagem of mensagens) {
      if (Number.isFinite(mensagem.createdTimestamp) && mensagem.createdTimestamp > limite) recentes.push(mensagem.id);
      else individuais.push(mensagem.id);
    }

    if (recentes.length >= 2 && typeof canal.bulkDelete === "function") {
      try {
        // Somente IDs previamente validados, nunca bulkDelete(quantidade).
        // O REST do discord.js gerencia os rate limits; não disparamos loops paralelos.
        await canal.bulkDelete(recentes);
        apagadas += recentes.length;
      } catch (error) {
        if (STOP_CODES.has(error.code)) throw error;
        // Inclui 50034: envelheceu durante a espera. DELETE individual não tem
        // o limite de 14 dias e ignora com segurança mensagens já apagadas.
        console.warn(`[CL] Bulk indisponível em ${canal.id}; tentando exclusão individual:`, error.message);
        individuais.unshift(...recentes);
      }
    } else individuais.unshift(...recentes);

    // Workers contínuos: um DELETE lento não segura todos os outros workers.
    // O REST continua responsável por respeitar os limites do Discord.
    const CONCORRENCIA = 8;
    let indice = 0, falha = null;
    await Promise.all(Array.from({length:Math.min(CONCORRENCIA,individuais.length)},async()=>{
      while (!falha && indice < individuais.length) {
        const id = individuais[indice++];
        try { if(await apagarIndividual(canal,id))apagadas++; }
        catch (error) { falha ||= error; }
      }
    }));
    if (falha) throw falha;
    return apagadas;
  }

  async function executar(message, job, alvoId) {
    const canal = message.channel;
    const inicio = Date.now();
    let paginas = 0, apagadas = 0, primeiroLoteMs = null;
    let exclusao = Promise.resolve(), removerComando = Promise.resolve(), erroExclusao = null;
    const enviarLote = async mensagens => {
      // Uma exclusão ativa e um lote em preparação: memória limitada, sem
      // colocar todo o histórico na fila REST ou multiplicar os workers.
      await exclusao;
      if (erroExclusao) throw erroExclusao;
      exclusao = apagarPagina(canal,mensagens).then(total => {
        apagadas += total;
        if(primeiroLoteMs === null){
          primeiroLoteMs=Date.now()-inicio;
          console.log(`[CL] Primeiro lote no canal ${canal.id}: ${total} mensagens; ${primeiroLoteMs}ms.`);
        }
      }).catch(error => { erroExclusao = error; });
    };
    try {
      const bot = message.guild.members.me || await message.guild.members.fetchMe();
      const permissoes = canal.permissionsFor(bot);
      if (!permissoes?.has(REQUIRED)) {
        console.warn(`[CL] Permissões ausentes no canal ${canal.id}: ${permissoes ? permissoes.missing(REQUIRED).join(", ") : "não foi possível consultar"}`);
        return;
      }
      void message.react("💩").catch(error => {
        console.warn(`[CL] Não foi possível reagir em ${canal.id}:`, error.message);
      });
      // Remove o comando antes de percorrer o histórico, que pode levar minutos.
      // Se houver falha transitória, mantém a referência para tentar no finally.
      removerComando = apagarIndividual(canal,message.id).then(apagada => {
        if(apagada)job.commands.delete(message.id);
      }).catch(error => { erroExclusao ||= error; });
      // O Gateway já fornece mensagens recentes: não precisamos buscá-las
      // novamente para começar. Só IDs verificados do alvo/canal autorizado.
      const conhecidas = [...(canal.messages.cache?.values() || [])].filter(item =>
        SNOWFLAKE.test(item.id) && BigInt(item.id) < BigInt(message.id) &&
        item.channelId === canal.id && item.author?.id === alvoId && !item.author.bot
      ).sort((a,b)=>BigInt(a.id)>BigInt(b.id)?-1:1).slice(0,100);
      const idsConhecidos = new Set(conhecidas.map(item=>item.id));
      // A busca e o primeiro bulk de mensagens conhecidas rodam em paralelo.
      // O conjunto limitado impede excluir os mesmos IDs na varredura.
      if(conhecidas.length)await enviarLote(conhecidas);
      const lote = [];
      let paginasNoLote = 0;
      for await (const anteriores of paginasClear({
        client,canal,guildId:message.guild.id,alvoId,limiteId:message.id,
        antesDeVarrer:async()=>{
          if(lote.length)await enviarLote(lote.splice(0));
          await exclusao;
          if(erroExclusao)throw erroExclusao;
        }
      })) {
        if (erroExclusao) throw erroExclusao;
        paginas++;
        const proprias = anteriores.filter(item => item.channelId === canal.id &&
          item.author?.id === alvoId && !item.author.bot && !idsConhecidos.has(item.id));
        lote.push(...proprias);
        paginasNoLote++;
        // Junta autores esparsos de até três páginas para evitar DELETEs
        // isolados e aproveitar o bulk de até 100 IDs, sempre já filtrados.
        while (lote.length >= 100) {
          await enviarLote(lote.splice(0,100));
          paginasNoLote = 0;
        }
        if (lote.length && (paginasNoLote >= 3 || anteriores.length < 25 ||
            (paginas === 1 && !conhecidas.length && lote.length >= 2))) {
          await enviarLote(lote.splice(0));
          paginasNoLote = 0;
        }
        // A busca avança enquanto o lote anterior é apagado. Só a próxima
        // exclusão aguarda a anterior, não cada página do histórico.
      }
      if (lote.length) await enviarLote(lote.splice(0));
      await exclusao;
      await removerComando;
      if (erroExclusao) throw erroExclusao;
    } catch (error) {
      console.error(`[CL] Limpeza interrompida no canal ${canal.id}, usuário ${message.author.id}:`, error.message);
    } finally {
      // Não libera a trava enquanto houver DELETEs em voo, inclusive na falha.
      await exclusao;
      await removerComando;
      // O comando e a mensagem respondida/mencionada também são apagados,
      // inclusive se a busca falhou ou as permissões mudaram no meio do caminho.
      while (job.commands.size) {
        const id = job.commands.values().next().value;
        job.commands.delete(id);
        try { await apagarIndividual(canal, id); }
        catch (error) {
          console.warn(`[CL] Não foi possível apagar o comando em ${canal.id}:`, error.message);
          break;
        }
      }
      console.log(`[CL] Canal ${canal.id}, alvo ${alvoId}: ${apagadas} mensagens removidas/já ausentes; ${paginas} páginas; primeiro lote ${primeiroLoteMs === null ? "nenhum" : `${primeiroLoteMs}ms`}; total ${Date.now()-inicio}ms.`);
    }
  }

  async function comandoClear(message) {
    if (!message.guild || message.author?.bot) return;
    if (message.channel.id !== message.channelId ||
      !SNOWFLAKE.test(message.id) || !message.channel.messages?.fetch) return;

    // Somente administradores podem direcionar o CL a outra pessoa.
    const admin = Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.Administrator));
    let alvoId = message.author.id;
    let respondida = null;
    if (admin) {
      const referenciaId = message.reference?.messageId;
      if (SNOWFLAKE.test(referenciaId)) {
        const referenciada = message.channel.messages.cache?.get(referenciaId) ||
          await message.channel.messages.fetch(referenciaId).catch(() => null);
        if (referenciada?.guildId === message.guild.id && referenciada.channelId === message.channelId &&
          !referenciada.author?.bot && SNOWFLAKE.test(referenciada.author?.id)) {
          alvoId = referenciada.author.id;
          respondida = referenciada.id;
        }
      }
      if (!respondida) {
        const mencionado = [...(message.mentions?.users?.values?.() || [])]
          .find(user => user && !user.bot && user.id !== message.author.id && SNOWFLAKE.test(user.id));
        if (mencionado) alvoId = mencionado.id;
      }
    }

    const key = `${message.guild.id}:${message.channelId}:${alvoId}`;
    const existente = inProgress.get(key);
    if (existente) {
      // Mesma mensagem recebida duas vezes ou novo 'cl': não duplica o trabalho.
      if (existente.commands.has(message.id)) return;
      existente.commands.add(message.id);
      if (respondida) existente.commands.add(respondida);
      try { await message.react("💩"); }
      catch (error) { console.warn(`[CL] Não foi possível reagir ao comando repetido em ${message.channelId}:`, error.message); }
      try { if(await apagarIndividual(message.channel,message.id))existente.commands.delete(message.id); }
      catch (error) { console.warn(`[CL] Não foi possível apagar o comando repetido em ${message.channelId}:`, error.message); }
      return;
    }
    const job = { commands: new Set([message.id, ...(respondida ? [respondida] : [])]) };
    inProgress.set(key, job); // Trava ANTES do primeiro await.
    try { await executar(message, job, alvoId); }
    catch (error) { console.error("[CL] Falha inesperada:", error); }
    finally { inProgress.delete(key); }
  }

  commands.register({
    name: "cl", description: "Apaga mensagens do autor no canal atual; administradores podem responder/mencionar outra pessoa.", category: "Moderação",
    result: "Reage com 💩 e apaga também a própria mensagem de comando. Administradores que respondem ou mencionam alguém limpam as mensagens dessa pessoa, incluindo a mensagem respondida.",
    examples: ["cl", "cl @pessoa (administrador)"], prefix: { trigger: "cl", exact: true, caseInsensitive: true, execute: comandoClear }
  });

  return { inProgress };
};
