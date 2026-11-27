// Histórico observado a partir da instalação. Não importa nem inventa eventos antigos.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  AuditLogEvent, PermissionFlagsBits, SlashCommandBuilder, MessageFlags,
  ContainerBuilder, SectionBuilder, ThumbnailBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown
} = require("discord.js");
const { serverName } = require("./brand");
const { errorText } = require("./error-ui");

// Marcadores oficiais do servidor para alterações de cargo.
const EMOJI_ADICIONADO = "<:Icon_Access_Approve:1569949091880902747>";
const EMOJI_REMOVIDO = "<:Icon_Access_Reject:1569949111166439507>";
const marcadorCargo = adicionou => adicionou ? EMOJI_ADICIONADO : EMOJI_REMOVIDO;

module.exports = function instalarFicha({ client, db, moderation, responderSemPermissao, voltarGerenciamento, autorizadoExtra = null }) {
  const banStore = db ? require("./ban-management/store")(db) : null;
  const modStore = moderation?.store;
  const commands = require("./command-system/registry").getCommandRegistry(client, { deny: responderSemPermissao });
  const arquivo = process.env.ROLE_HISTORY_FILE || path.join(__dirname, "role-history.json");
  const permissoes = PermissionFlagsBits[process.env.HISTORY_PERMISSION || "ManageRoles"];
  if (typeof permissoes !== "bigint") throw new Error("HISTORY_PERMISSION inválida.");
  const idValido = id => /^\d{17,20}$/.test(id || "");
  const normalizar = texto => String(texto).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  let banco = { records: [], sessions: {} };
  // Falha fechada: não sobrescreve um histórico ilegível por um arquivo vazio.
  if (fs.existsSync(arquivo)) {
    banco = JSON.parse(fs.readFileSync(arquivo, "utf8"));
    if (!Array.isArray(banco.records) || !banco.sessions) throw new Error("Histórico de cargos inválido.");
  }
  function salvar() {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo + ".tmp", JSON.stringify(banco), "utf8");
    fs.renameSync(arquivo + ".tmp", arquivo);
  }
  const indice = new Map();
  const porId = new Map();
  const pendentes = new Map();
  const filas = new Map();
  const consultasAuditoria = new Map();
  const transicoesObservadas = new Map();
  const timersFicha = new Map();
  const apagarFicha = new Map();
  const INATIVIDADE_FICHA = 30_000;

  function cancelarTimerFicha(id) {
    clearTimeout(timersFicha.get(id));
    timersFicha.delete(id);
    apagarFicha.delete(id);
  }

  function renovarFicha(sessao, apagar = null) {
    clearTimeout(timersFicha.get(sessao.id));
    if (apagar) apagarFicha.set(sessao.id, apagar);
    const timer = setTimeout(async () => {
      timersFicha.delete(sessao.id);
      const excluir = apagarFicha.get(sessao.id);
      apagarFicha.delete(sessao.id);
      delete banco.sessions[sessao.id];
      try {
        salvar();
        if (excluir) await excluir();
      } catch (error) {
        if (error.code !== 10008 && error.code !== 10003) {
          console.warn("Não foi possível apagar a ficha inativa:", error.message);
        }
      }
    }, INATIVIDADE_FICHA);
    timer.unref();
    timersFicha.set(sessao.id, timer);
  }
  function indexar(registro) {
    porId.set(registro.id, registro);
    const chave = `${registro.guildId}:${registro.userId}`;
    if (!indice.has(chave)) indice.set(chave, []);
    indice.get(chave).push(registro);
  }
  banco.records.forEach(indexar);
  function novo(guild, userId, cargo, action, extra = {}) {
    const registro = {
      id: randomUUID(), guildId: guild.id, userId, roleId: cargo.id,
      roleName: cargo.name || cargo.id, action, actorId: null, executorId: null,
      source: "Evento de cargos do Discord", timestamp: Date.now(),
      identification: "unknown", timeSource: "observed", auditId: null, ...extra
    };
    banco.records.push(registro);
    indexar(registro);
    salvar();
    return registro;
  }
  function autorizado(membro) {
    const extra=autorizadoExtra?.(membro);
    if(extra!==null&&extra!==undefined)return Boolean(extra);
    return Boolean(membro?.permissions?.has(PermissionFlagsBits.Administrator) ||
      membro?.permissions?.has(permissoes));
  }
  const autorizadoBanimentos = membro => Boolean(banStore && autorizado(membro));
  const podeAbrir = membro => autorizado(membro) || autorizadoBanimentos(membro);
  const registros = (guildId, userId) => indice.get(`${guildId}:${userId}`) || [];
  const chaveOperacao = (guildId, userId, roleId, action) => `${guildId}:${userId}:${roleId}:${action}`;

  function corresponde(entry, registro) {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate || entry.targetId !== registro.userId) return false;
    if (Math.abs(entry.createdTimestamp - registro.timestamp) > 15_000) return false;
    const chave = registro.action === "add" ? "$add" : "$remove";
    return entry.changes?.some(change => change.key === chave &&
      Array.isArray(change.new) && change.new.some(role => role.id === registro.roleId));
  }
  function correlacionar(guild, entries) {
    let alterou = false;
    for (const registro of banco.records) {
      if (registro.guildId !== guild.id || registro.identification !== "unknown") continue;
      const candidatos = entries.filter(entry => corresponde(entry, registro));
      // Se a página de auditoria truncou parte da janela, a autoria é incerta.
      if (entries.length >= 100 && Math.min(...entries.map(e => e.createdTimestamp)) > registro.timestamp - 15_000) continue;
      // Ambiguidade: deixa desconhecido. Nunca escolhe só o mais próximo no tempo.
      if (candidatos.length !== 1) continue;
      const entry = candidatos[0];
      if (!entry.executorId) continue;
      const semelhantes = registros(guild.id, registro.userId).filter(other =>
        other.roleId === registro.roleId && other.action === registro.action && corresponde(entry, other));
      if (semelhantes.length !== 1) continue;
      registro.actorId = entry.executorId;
      registro.executorId = entry.executorId;
      registro.auditId = entry.id;
      registro.timestamp = entry.createdTimestamp;
      registro.timeSource = "audit";
      registro.identification = "audit_confirmed";
      registro.source = "Auditoria do Discord";
      if (typeof entry.reason === "string" && entry.reason.trim()) registro.reason = entry.reason;
      alterou = true;
    }
    if (alterou) salvar();
  }
  function consultarAuditoria(guild, tentativa = 0) {
    if (consultasAuditoria.has(guild.id)) return;
    const timer = setTimeout(async () => {
      consultasAuditoria.delete(guild.id);
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return;
      try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 });
        correlacionar(guild, [...logs.entries.values()]);
        if (tentativa < 2 && banco.records.some(r => r.guildId === guild.id &&
          r.identification === "unknown" && Date.now() - r.timestamp < 30_000)) {
          consultarAuditoria(guild, tentativa + 1);
        }
      } catch (error) { console.warn("Não foi possível consultar auditoria de cargos:", error.message); }
    }, tentativa ? 4000 : 2000);
    timer.unref();
    consultasAuditoria.set(guild.id, timer);
  }

  client.on("guildMemberUpdate", (anterior, atual) => {
    try {
      if (anterior.partial || atual.partial) return;
      const de = [...anterior.roles.cache.keys()].sort().join(",");
      const para = [...atual.roles.cache.keys()].sort().join(",");
      if (de === para) return;
      const chaveMembro = `${atual.guild.id}:${atual.id}`;
      const assinatura = `${de}>${para}`;
      if (transicoesObservadas.get(chaveMembro) === assinatura) return;
      transicoesObservadas.set(chaveMembro, assinatura);
      for (const action of ["add", "remove"]) {
        const base = action === "add" ? atual : anterior;
        const outro = action === "add" ? anterior : atual;
        for (const cargo of base.roles.cache.values()) {
          if (cargo.id === atual.guild.id || outro.roles.cache.has(cargo.id)) continue;
          const chave = chaveOperacao(atual.guild.id, atual.id, cargo.id, action);
          const pendente = pendentes.get(chave);
          if (pendente) {
            // O registro interno será confirmado somente depois do sucesso REST.
            pendente.observado = true;
            if (pendente.concluido) pendentes.delete(chave);
            continue;
          }
          novo(atual.guild, atual.id, cargo, action);
        }
      }
      consultarAuditoria(atual.guild);
    } catch (error) { console.error("Erro ao registrar alteração de cargos:", error); }
  });

  async function alterarCargo({ guild, alvo, cargo, action, autor, executar,
    source = "Gerenciamento de cargos", reason = null, hoursMs = null }) {
    const chaveFila = `${guild.id}:${alvo.id}`;
    const anterior = filas.get(chaveFila) || Promise.resolve();
    const trabalho = anterior.catch(() => {}).then(async () => {
      const atual = await guild.members.fetch({ user: alvo.id, force: true });
      // Operações simultâneas em painéis distintos não registram PUT/DELETE sem efeito.
      if (atual.roles.cache.has(cargo.id) === (action === "add")) return atual;
      const chave = chaveOperacao(guild.id, alvo.id, cargo.id, action);
      const token = randomUUID();
      // Persistir a intenção ANTES da API permite recuperar uma interrupção.
      const registro = novo(guild, alvo.id, cargo, action, {
        source, reason, hoursMs, identification: "pending",
        requestedBy: autor.id, token
      });
      const pendente = { observado: false };
      pendentes.set(chave, pendente);
      try {
        const resultado = await executar(`mds ficha:${token} por ${autor.id}`);
        registro.actorId = autor.id;
        registro.executorId = client.user.id;
        registro.identification = "panel_confirmed";
        registro.timestamp = Date.now();
        registro.timeSource = "request_confirmed";
        pendente.concluido = true;
        salvar();
        return resultado;
      } catch (error) {
        // Não apresenta uma solicitação que falhou como alteração confirmada.
        registro.identification = pendente.observado ? "unknown" : "failed";
        if (pendente.observado) consultarAuditoria(guild);
        salvar();
        throw error;
      } finally {
        // Mantém a correlação até o Gateway confirmar a alteração ou expirar.
        if (pendente.observado) pendentes.delete(chave);
        else {
          const timer = setTimeout(() => {
            if (pendentes.get(chave) === pendente) pendentes.delete(chave);
          }, 15_000);
          timer.unref();
        }
      }
    });
    filas.set(chaveFila, trabalho);
    try { return await trabalho; }
    finally { if (filas.get(chaveFila) === trabalho) filas.delete(chaveFila); }
  }

  const separador = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
  const texto = content => new TextDisplayBuilder().setContent(content);
  const botao = (id, label, primary = false) => new ButtonBuilder().setCustomId(id)
    .setLabel(label).setStyle(primary ? ButtonStyle.Primary : ButtonStyle.Secondary);
  const data = timestamp => Math.floor(timestamp / 1000);
  const responsavel = r => r.actorId ? `<@${r.actorId}>` : "Não identificado";
  const cargoTexto = (guild, r) => guild.roles.cache.has(r.roleId)
    ? `<@&${r.roleId}>` : `${r.roleName.replace(/([\\*_~`|<>])/g, "\\$1")} (cargo excluído · ${r.roleId})`;
  const disponiveis = (guildId, userId) => registros(guildId, userId)
    .filter(r => r.identification !== "pending" && r.identification !== "failed")
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));

  function emojiDisponivel(guild, id) {
    const emoji = guild.emojis?.cache.get(id);
    if (!emoji || emoji.available === false) return null;
    const restricoes = emoji.roles.cache;
    if (restricoes.size && !restricoes.some(cargo => guild.members.me?.roles.cache.has(cargo.id))) return null;
    return emoji;
  }

  // Apenas na exibição da ficha, o nome da marca aparece como "bot".
  // Os textos gravados no banco e nos registros de auditoria não são alterados.
  // O token literal "/mds" da bio é preservado.
  const seguro = value => escapeMarkdown(String(value))
    .replace(/@/g, "@\u200b")
    .replace(/(?<!\/)\bMDS\b/gi, "bot");
  const diaBan = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });
  const horaBan = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", timeStyle: "medium", hour12: false });
  const quandoBan = r => `**Data:** ${diaBan.format(r.createdAt)} · **Hora:** ${horaBan.format(r.createdAt)} (Brasília)`;
  const estadoBan = r => r.status === "success" ? "Concluído"
    : r.status === "failed" ? errorText("Falhou — ação não confirmada")
    : "Pendente de verificação — resultado não confirmado";

  // --- Blocos visuais compartilhados: mantêm todas as abas alinhadas ---
  function tituloPagina(container, titulo, subtitulo) {
    return container.addTextDisplayComponents(texto(`## ${titulo}\n-# ${subtitulo}`));
  }
  function identidade(container, sessao, linhaExtra = "") {
    const corpo = `**<@${sessao.userId}>**\n-# ID: ${sessao.userId}${linhaExtra ? `\n${linhaExtra}` : ""}`;
    return container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(texto(corpo))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(sessao.avatar)));
  }
  function estatisticas(container, pares) {
    return container.addTextDisplayComponents(texto(pares.map(([rotulo, valor]) =>
      `**${rotulo}:** ${valor}`).join("\n")));
  }
  function blocoMotivo(container, conteudo, limite = 400) {
    if (!conteudo) return container.addTextDisplayComponents(texto("**Motivo:** Não informado"));
    const curto = conteudo.length > limite ? `${conteudo.slice(0, limite)}…` : conteudo;
    return container.addTextDisplayComponents(texto(`**Motivo**\n> ${seguro(curto).replace(/\r?\n/g, "\n> ")}`));
  }
  function nota(container, conteudo) {
    return container.addTextDisplayComponents(texto(`-# ${conteudo}`));
  }
  function cartao(container, { marcador = "", titulo, status = "", campos = [], motivo: motivoTexto, acessorio = null, nota: notaTexto = "" }) {
    const cabecalhoTexto = `${marcador ? `${marcador} ` : ""}**${titulo}**${status ? ` · ${status}` : ""}`;
    const linhas = [cabecalhoTexto, ...campos.map(([rotulo, valor]) => `**${rotulo}:** ${valor}`)];
    if (motivoTexto !== undefined && motivoTexto !== null) {
      const textoMotivo = String(motivoTexto);
      const curto = textoMotivo.length > 400 ? `${textoMotivo.slice(0, 400)}…` : textoMotivo;
      linhas.push("", `**Motivo**\n> ${seguro(curto).replace(/\r?\n/g, "\n> ")}`);
    }
    if (notaTexto) linhas.push("", `-# ${notaTexto}`);
    const bloco = texto(linhas.join("\n"));
    if (acessorio) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(bloco).setButtonAccessory(acessorio));
    else container.addTextDisplayComponents(bloco);
    return container;
  }

  function abas(container, sessao, membro) {
    const row = new ActionRowBuilder().addComponents(
      botao(`ficha:tab:${sessao.id}:roles`, "Cargos", sessao.tab === "roles").setDisabled(!autorizado(membro)),
      botao(`ficha:tab:${sessao.id}:bans`, "Banimentos", sessao.tab === "bans").setDisabled(!autorizadoBanimentos(membro))
    );
    if (modStore) row.addComponents(botao(`ficha:tab:${sessao.id}:moderation`, "Moderação", sessao.tab === "moderation"));
    return container.addActionRowComponents(row).addSeparatorComponents(separador());
  }

  function montarModeracao(guild, sessao, container) {
    const rows = modStore ? modStore.history(guild.id, sessao.userId) : [];
    const applied = modStore ? modStore.byActor(guild.id, sessao.userId) : [];
    const label = { kick: "Expulsão", ban: "Banimento externo", timeout: "Castigo" };
    identidade(container, sessao);
    estatisticas(container, [
      ["Ações sofridas", rows.length],
      ["Ações aplicadas", applied.length],
      ["Origem", "auditoria do Discord"]
    ]);
    container.addSeparatorComponents(separador());
    if (!rows.length && !applied.length) nota(container,
      "Nenhuma expulsão, castigo ou banimento externo foi registrado para este usuário.");
    const shown = [...rows, ...applied.filter(a => !rows.some(r => r.id === a.id))];
    for (const [index, r] of shown.entries()) {
      if (index) container.addSeparatorComponents(separador());
      const marcador = emojiDisponivel(guild, r.kind === "ban" ? "1569949111166439507" : "1570299467490533448");
      const status = r.sanction === "role-removed" ? "cargo de moderação removido"
        : r.sanction === "cleanup" ? "registro processado" : "";
      cartao(container, {
        marcador: marcador?.toString() || "",
        titulo: label[r.kind] || r.kind,
        status,
        campos: [
          ["Responsável", `<@${r.actorId}>`],
          ["Alvo", `<@${r.targetId}>`],
          ["Registrado em", `${diaBan.format(r.createdAt)} · ${horaBan.format(r.createdAt)} (Brasília)`]
        ],
        motivo: r.reason,
        nota: `Auditoria: ${r.auditId}`
      });
    }
    return container;
  }

  function navegacaoBans(container, sessao, paginas) {
    const pesquisa = botao(`ficha:search:${sessao.id}`, "Pesquisar").setEmoji({ id: "1569941293323255889" });
    container.addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
      botao(`ficha:filter:${sessao.id}:all`, "Todos", sessao.filter === "all"),
      botao(`ficha:filter:${sessao.id}:ban`, "Banimentos", sessao.filter === "ban"),
      botao(`ficha:filter:${sessao.id}:unban`, "Desbanimentos", sessao.filter === "unban"), pesquisa
    )).addActionRowComponents(new ActionRowBuilder().addComponents(
      botao(`ficha:page:${sessao.id}:${sessao.page - 1}`, "Anterior").setDisabled(sessao.page === 1),
      botao(`ficha:info:${sessao.id}`, `${sessao.page}/${paginas}`).setDisabled(true),
      botao(`ficha:page:${sessao.id}:${sessao.page + 1}`, "Próxima").setDisabled(sessao.page === paginas)
    ));
    if (sessao.managementId) container.addActionRowComponents(new ActionRowBuilder().addComponents(
      botao(`ficha:management:${sessao.id}`, "← Voltar ao gerenciamento")));
    return container;
  }

  function montarBanimentos(guild, sessao, container) {
    if (sessao.detail) {
      const r = banStore.get(guild.id, sessao.userId, sessao.detail);
      if (!r) throw new Error("Registro inválido.");
      const campos = [
        ["Usuário", `<@${r.targetId}> · \`${r.targetId}\``],
        ["Ação", r.action === "ban" ? "Banimento" : "Desbanimento"],
        ["Resultado", estadoBan(r)],
        ["Responsável", `<@${r.actorId}> · \`${r.actorId}\``],
        ["Registrado em", `${diaBan.format(r.createdAt)} · ${horaBan.format(r.createdAt)} (Brasília)`]
      ];
      if (r.action === "ban") campos.push(["Limpeza solicitada", r.deleteSeconds ? `${r.deleteSeconds / 3600} hora(s)` : "Nenhuma"]);
      campos.push(["ID do registro", `\`${r.id}\``]);
      cartao(container, {
        marcador: emojiDisponivel(guild, r.action === "ban" ? "1569949111166439507" : "1569949091880902747")?.toString() || "",
        titulo: r.action === "ban" ? "Detalhes do banimento" : "Detalhes do desbanimento",
        campos,
        motivo: r.reason,
        nota: "Origem: sistema de banimentos do bot"
      });
      container.addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
        botao(`ficha:back:${sessao.id}`, "Voltar aos banimentos")));
      return container;
    }
    const stats = banStore.stats(guild.id, sessao.userId);
    const lista = banStore.list(guild.id, sessao.userId, sessao);
    sessao.page = lista.page;
    identidade(container, sessao);
    estatisticas(container, [
      ["Banimentos concluídos", stats.bans],
      ["Desbanimentos concluídos", stats.unbans],
      ["Tentativas com falha", stats.failed],
      ["Pendentes", stats.pending],
      ["Última operação", stats.latest ? `<t:${data(stats.latest)}:R>` : "Nenhuma registrada"]
    ]);
    nota(container, `Histórico registrado por este bot · ${sessao.private ? "consulta privada" : "consulta no canal"}`);
    container.addSeparatorComponents(separador());
    if (!lista.rows.length) nota(container, stats.total
      ? "Nenhuma operação corresponde aos filtros." : "Nenhum banimento ou desbanimento foi registrado para este usuário.");
    for (const [index, r] of lista.rows.entries()) {
      if (index) container.addSeparatorComponents(separador());
      cartao(container, {
        marcador: emojiDisponivel(guild, r.action === "ban" ? "1569949111166439507" : "1569949091880902747")?.toString() || "",
        titulo: r.action === "ban" ? "Banimento" : "Desbanimento",
        status: estadoBan(r),
        campos: [
          ["Responsável", `<@${r.actorId}>`],
          ["Registrado em", `${diaBan.format(r.createdAt)} · ${horaBan.format(r.createdAt)} (Brasília)`]
        ],
        motivo: r.reason,
        acessorio: botao(`ficha:detail:${sessao.id}:${r.id}`, "Detalhes")
      });
    }
    return navegacaoBans(container, sessao, lista.pages);
  }

  function montar(guild, sessao, membro) {
    const todos = disponiveis(guild.id, sessao.userId);
    const container = new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(texto(sessao.detail
        ? sessao.tab === "bans" ? "# Detalhes da Moderação" : "# Detalhes da Alteração"
        : `# Ficha do Usuário | ${serverName(guild)}`));
    abas(container, sessao, membro);
    if (sessao.tab === "moderation") return montarModeracao(guild, sessao, container);
    if (sessao.tab === "bans") {
      if (!autorizadoBanimentos(membro)) throw new Error("Consulta de banimentos não autorizada.");
      return montarBanimentos(guild, sessao, container);
    }
    if (!autorizado(membro)) throw new Error("Consulta de cargos não autorizada.");
    if (sessao.detail) {
      const r = porId.get(sessao.detail);
      if (!r || r.guildId !== guild.id || r.userId !== sessao.userId) throw new Error("Registro inválido.");
      const campos = [
        ["Membro", `<@${r.userId}> · \`${r.userId}\``],
        ["Ação", r.action === "add" ? "Cargo adicionado" : "Cargo removido"],
        ["Cargo", cargoTexto(guild, r)],
        ["Responsável", responsavel(r)],
        ["Executor técnico", r.executorId ? `<@${r.executorId}>` : "Não identificado"],
        ["Origem", seguro(r.source)],
        ["Registrado em", `${diaBan.format(r.timestamp)} · ${horaBan.format(r.timestamp)} (Brasília)`]
      ];
      if (Number.isFinite(r.hoursMs)) campos.push(["Horas acumuladas", `${(r.hoursMs / 3600000).toFixed(2)}h`]);
      campos.push(["Tempo decorrido", `<t:${data(r.timestamp)}:R>`], ["ID do registro", `\`${r.id}\``]);
      cartao(container, {
        marcador: marcadorCargo(r.action === "add"),
        titulo: "Detalhes da alteração",
        campos,
        motivo: r.reason || "Não informado",
        nota: r.timeSource === "observed" ? "Horário de observação pelo bot; autoria não confirmada." : `Identificação: ${r.identification}`
      });
      container.addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
        botao(`ficha:back:${sessao.id}`, "Voltar para ficha")));
      return container;
    }
    const adicoes = todos.filter(r => r.action === "add").length;
    identidade(container, sessao, sessao.joinedAt ? `Registrado no servidor: <t:${data(sessao.joinedAt)}:R>` : "Registro de entrada indisponível");
    estatisticas(container, [
      ["Total de alterações", todos.length],
      ["Cargos adicionados", adicoes],
      ["Cargos removidos", todos.length - adicoes],
      ["Última alteração", todos[0] ? `<t:${data(todos[0].timestamp)}:R>` : "Nenhuma registrada"]
    ]);
    container.addSeparatorComponents(separador())
      .addTextDisplayComponents(texto("## Histórico de alterações"))
      .addTextDisplayComponents(texto("-# Adições e remoções de cargos registradas pelo bot."));
    const busca = normalizar(sessao.search);
    const filtrados = todos.filter(r => (sessao.filter === "all" || r.action === sessao.filter) &&
      (!busca || normalizar(r.roleName).includes(busca) || r.roleId.includes(busca)));
    // A volta ao gerenciamento ocupa três componentes adicionais. As abas
    // mantêm a ficha abaixo do limite de 40 componentes do Discord.
    const porPagina = modStore ? (sessao.managementId ? 2 : 3) : (sessao.managementId ? 3 : 4);
    const paginas = Math.max(1, Math.ceil(filtrados.length / porPagina));
    sessao.page = Math.min(Math.max(1, sessao.page), paginas);
    const visiveis = filtrados.slice((sessao.page - 1) * porPagina, sessao.page * porPagina);
    if (!visiveis.length) nota(container, todos.length
      ? "Nenhuma alteração corresponde aos filtros."
      : "Nenhuma alteração de cargo foi registrada para este usuário até o momento.");
    for (const [indice, r] of visiveis.entries()) {
      if (indice > 0) container.addSeparatorComponents(separador());
      const adicionou = r.action === "add";
      cartao(container, {
        marcador: marcadorCargo(adicionou),
        titulo: `Cargo ${adicionou ? "adicionado" : "removido"}`,
        campos: [
          ["Cargo", cargoTexto(guild, r)],
          ["Responsável", responsavel(r)],
          ["Registrado em", `${diaBan.format(r.timestamp)} · ${horaBan.format(r.timestamp)} (Brasília)`]
        ],
        motivo: r.reason,
        acessorio: botao(`ficha:detail:${sessao.id}:${r.id}`, "Detalhes").setEmoji({ id: "1569951006547116082" })
      });
    }
    const pesquisa = new ButtonBuilder().setCustomId(`ficha:search:${sessao.id}`).setEmoji({ id: "1569941293323255889" }).setStyle(ButtonStyle.Secondary);
    container.addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
      botao(`ficha:filter:${sessao.id}:all`, "Todos", sessao.filter === "all"),
      botao(`ficha:filter:${sessao.id}:add`, "Adicionados", sessao.filter === "add"),
      botao(`ficha:filter:${sessao.id}:remove`, "Removidos", sessao.filter === "remove"), pesquisa
    )).addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
      botao(`ficha:page:${sessao.id}:${sessao.page - 1}`, "<").setDisabled(sessao.page === 1),
      botao(`ficha:info:${sessao.id}`, `${sessao.page}/${paginas}`).setDisabled(true),
      botao(`ficha:page:${sessao.id}:${sessao.page + 1}`, ">").setDisabled(sessao.page === paginas)
    ));
    if (sessao.managementId) {
      container.addSeparatorComponents(separador()).addActionRowComponents(new ActionRowBuilder().addComponents(
        botao(`ficha:management:${sessao.id}`, "← Voltar ao gerenciamento")
      ));
    }
    return container;
  }
  async function abrir(origem, userId, privada = true, managementId = null, initialTab = null) {
    const staff = await origem.guild.members.fetch({ user: (origem.user || origem.author).id, force: true });
    if (!podeAbrir(staff)) return responderSemPermissao(origem);
    const tab = initialTab || (autorizado(staff) ? "roles" : "bans");
    if (tab === "bans" ? !autorizadoBanimentos(staff) : tab !== "roles" || !autorizado(staff))
      return responderSemPermissao(origem);
    if (!idValido(userId)) throw new Error("Informe um usuário ou ID válido.");
    const guild = origem.guild;
    const membro = await guild.members.fetch(userId).catch(() => null);
    // Permite consultar quem saiu, sem apagar os registros anteriores.
    const usuario = membro?.user || await client.users.fetch(userId);
    const sessao = {
      id: randomUUID(), guildId: guild.id, staffId: (origem.user || origem.author).id,
      userId, avatar: usuario.displayAvatarURL({ extension: "png", size: 256 }),
      joinedAt: membro?.joinedTimestamp || null, filter: "all", search: "", page: 1,
      criadoEm: Date.now(), detail: null, managementId, tab, private: !origem.author && privada,
      views: {}
    };
    banco.sessions[sessao.id] = sessao;
    const component = montar(guild, sessao, staff);
    const payload = { components: [component],
      flags: MessageFlags.IsComponentsV2 | (privada ? MessageFlags.Ephemeral : 0), allowedMentions: { parse: [] } };
    salvar();
    const mensagem = await (origem.author ? origem.reply(payload) : origem.editReply(payload));
    sessao.messageId = mensagem.id;
    renovarFicha(sessao, origem.author
      ? () => mensagem.delete()
      : () => origem.webhook.deleteMessage(mensagem.id));
    salvar();
    return mensagem;
  }
  function erro(origem, error) {
    console.error("Erro na ficha de cargos:", error);
    const payload = { components: [new ContainerBuilder().setAccentColor(0)
      .addTextDisplayComponents(texto(errorText("# Não foi possível abrir a ficha\nInforme um membro ou ID válido e tente novamente.")))],
    flags: MessageFlags.IsComponentsV2 | (origem.author ? 0 : MessageFlags.Ephemeral), allowedMentions: { parse: [] } };
    return (origem.author ? origem.reply(payload) : origem.deferred || origem.replied ? origem.followUp(payload) : origem.reply(payload)).catch(() => {});
  }
  async function comandoFichaPrefixo(message) {
    if (!message.guild || message.author.bot) return;
    if (!podeAbrir(message.member)) return responderSemPermissao(message).catch(() => {});
    const argumento = message.content.trim().split(/\s+/)[1];
    const userId = message.mentions.users.first()?.id ||
      (argumento ? argumento.replace(/[<@!>]/g, "") : message.author.id);
    try { await abrir(message, userId, false); } catch (error) { await erro(message, error); }
  }
  async function comandoFichaSlash(i) {
    if (!podeAbrir(i.member)) return responderSemPermissao(i).catch(() => {});
    try {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await abrir(i, i.options.getUser("usuario")?.id || i.user.id);
    } catch (error) { await erro(i, error); }
  }
  commands.register({
    name: "ficha", description: "Consulta a ficha do usuário em abas de cargos e banimentos.",
    category: "Histórico de Cargos", permissions: [], authorize: podeAbrir,
    result: "Abas de cargos e banimentos no mesmo painel, com filtros, detalhes e paginação. Ambas seguem as permissões da ficha. Sem alvo, consulta a própria ficha.",
    examples: ["!ficha", "!ficha @usuário", "/ficha usuario:@usuário"],
    prefix: { trigger: "!ficha", trimLeading: false,
      usage: ["!ficha [@usuário ou ID]"], execute: comandoFichaPrefixo },
    slash: {
      data: new SlashCommandBuilder().setName("ficha").setDescription("Consultar ficha de cargos e banimentos")
        .addUserOption(option => option.setName("usuario").setDescription("Membro consultado (padrão: você)").setRequired(false)),
      usage: ["/ficha [usuario:@usuário]"], execute: comandoFichaSlash
    }
  });
  client.on("interactionCreate", async i => {
    if (!i.inGuild()) return;
    if (!(i.isButton() || i.isModalSubmit()) || !i.customId.startsWith("ficha:")) return;
    const [, action, id, value] = i.customId.split(":");
    const sessao = banco.sessions[id];
    if (!sessao || sessao.guildId !== i.guildId || sessao.staffId !== i.user.id) {
      return responderSemPermissao(i).catch(() => {});
    }
    try {
      const staff = await i.guild.members.fetch({ user: i.user.id, force: true });
      const desiredTab = action === "tab" ? value : sessao.tab || "roles";
      if (!["roles", "bans", "moderation"].includes(desiredTab) ||
          (desiredTab === "bans" ? !autorizadoBanimentos(staff) : !autorizado(staff))) {
        return responderSemPermissao(i).catch(() => {});
      }
      // Só o solicitante autorizado renova o prazo. A exclusão afeta apenas a
      // mensagem da consulta, nunca os registros persistentes do histórico.
      renovarFicha(sessao, sessao.messageId
        ? () => i.webhook.deleteMessage(sessao.messageId)
        : () => i.deleteReply());
      if (action === "tab") {
        sessao.views ||= {};
        const current = sessao.tab || "roles";
        sessao.views[current] = { filter: sessao.filter, search: sessao.search, page: sessao.page, detail: sessao.detail };
        Object.assign(sessao, { filter: "all", search: "", page: 1, detail: null }, sessao.views[value] || {});
        sessao.tab = value;
      }
      if (action === "management" && sessao.managementId && voltarGerenciamento) {
        const resultado = await voltarGerenciamento(i, sessao.managementId);
        if (i.deferred) {
          cancelarTimerFicha(id);
          delete banco.sessions[id];
          salvar();
        }
        return resultado;
      }
      if (action === "search" && i.isButton()) {
        return await i.showModal(new ModalBuilder().setCustomId(`ficha:modal:${id}:${sessao.tab || "roles"}`).setTitle("Pesquisar histórico")
          .addLabelComponents(new LabelBuilder().setLabel(sessao.tab === "bans" ? "Motivo, ID do responsável ou do registro" : "Nome ou ID do cargo").setTextInputComponent(
            new TextInputBuilder().setCustomId("search").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)
          )));
      }
      await i.deferUpdate();
      if (action === "modal" && i.isModalSubmit()) {
        if (value && value !== (sessao.tab || "roles")) throw new Error("Pesquisa expirada. Abra a pesquisa na aba atual.");
        sessao.search = i.fields.getTextInputValue("search").trim(); sessao.page = 1;
      }
      else if (action === "filter") {
        if (!(sessao.tab === "bans" ? ["all", "ban", "unban"] : ["all", "add", "remove"]).includes(value))
          throw new Error("Filtro inválido para esta aba.");
        sessao.filter = value; sessao.page = 1;
      }
      else if (action === "page" && /^\d{1,8}$/.test(value)) sessao.page = Number(value);
      else if (action === "detail") {
        const r = sessao.tab === "bans" ? banStore.get(sessao.guildId, sessao.userId, value) : porId.get(value);
        if (!r || r.guildId !== sessao.guildId ||
            (sessao.tab === "bans" ? r.targetId !== sessao.userId : r.userId !== sessao.userId || ["pending", "failed"].includes(r.identification)))
          throw new Error("Registro inválido");
        sessao.detail = value;
      } else if (action === "back") sessao.detail = null;
      await i.editReply({ components: [montar(i.guild, sessao, staff)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
      salvar();
    } catch (error) { await erro(i, error); }
  });
  client.once("clientReady", async () => {
    // Intenções interrompidas: só confirma quando o token exato aparece na auditoria.
    for (const registro of banco.records.filter(r => r.identification === "pending")) {
      try {
        const guild = await client.guilds.fetch(registro.guildId);
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 });
        const entry = [...logs.entries.values()].find(e => e.reason?.includes(`mds ficha:${registro.token} `) && corresponde(e, registro) && e.executorId === client.user.id);
        if (entry) Object.assign(registro, { identification: "panel_confirmed", actorId: registro.requestedBy,
          executorId: entry.executorId, auditId: entry.id, timestamp: entry.createdTimestamp, timeSource: "audit" });
        else registro.identification = "failed";
        salvar();
      } catch (error) { console.warn("Intenção de cargo aguardando recuperação:", error.message); }
    }
  });
  function close() {
    for (const id of timersFicha.keys()) cancelarTimerFicha(id);
    for (const timer of consultasAuditoria.values()) clearTimeout(timer);
    consultasAuditoria.clear();
  }
  return { abrir, alterarCargo, autorizado, erro, close };
};
