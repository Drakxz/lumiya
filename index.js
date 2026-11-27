const anticrash = require("./anticrash/runtime").installProcessProtection();
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const {
  Client,
  ActivityType,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  ContainerBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  UserSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { serverName, titulo, prefereTexto } = require("./brand");
const { errorText, statusText } = require("./error-ui");
const { renderPanelArt, SLA_SUPPORT_ART, SLA_MIGRATION_ART } = require("./panel-art");
const {panelImagesEnabled,applyPanelAppearance}=require("./panel-art/appearance");
const {canManageTicket}=require("./ticket-management/permissions");

// =====================================
// CLIENTE ÚNICO
// =====================================

const client = new Client({
  presence: {
    status: "online",
    activities: [{
      name: "💜 Online | 0 servidores",
      type: ActivityType.Custom
    }]
  },
  intents: [
    GatewayIntentBits.Guilds,
    // Ative Bot > Privileged Gateway Intents > Server Members Intent no Developer Portal.
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Os módulos do bot registram handlers independentes de interactionCreate.
// O limite padrão 10 é menor que essa quantidade fixa e gerava um falso alerta.
// Os módulos instalados mantêm listeners fixos; o cargo inicial acrescenta um
// handler próprio. Mantém um limite finito para ainda detectar crescimento indevido.
client.setMaxListeners(32);

anticrash.bindClient(client);
require("./voice-presence")({client});
require("./call-panel")({client,env:process.env});

const commands = require("./command-system/registry").getCommandRegistry(client, {
  deny: responderSemPermissao
});

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const CATEGORY_ID = process.env.CATEGORY_ID;

function cargosDoServidor(guild) {
  return [...guild.roles.cache.values()].filter(role =>
    role.id !== guild.id && !role.managed
  );
}

// =====================================
// CONSTANTES VISUAIS
// =====================================

// Azul extraído do lettering dos emojis do painel de migração.
const COR_TICKET = 0;
const COR_SUCESSO = 0;
const COR_ERRO = 0;

// Miniaturas originais dos painéis (nenhuma imagem nova foi criada)
const MINIATURA_SUPORTE = "https://i.imgur.com/We6Pd0u.png";
const MINIATURA_MIGRACAO = "https://i.imgur.com/BzH5NLh.jpeg";

const FLAGS_V2 = MessageFlags.IsComponentsV2;
const FLAGS_EFEMERO_V2 = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

// Cinco cargos com divisórias mantêm o painel abaixo de 40 componentes.
const CARGOS_POR_PAGINA = 5;
const FILTROS_CARGOS = ["disponiveis", "removiveis", "todos"];

// Os títulos são compostos no momento da renderização para refletir o nome
// do servidor em que o painel está, inclusive após restaurar um backup.
const tipos = {
  insta: {
    titulo: "Verificação do Instagram",
    descricao: "Seu pedido de verificação foi iniciado. Aguarde o atendimento e siga as orientações da equipe.\n\nSe aprovado, a equipe liberará seu acesso ao canal de envio de fotos. Não envie senhas, códigos de acesso ou documentos pessoais.",
    confirmacao: "verificação do Instagram"
  },
  sup: {
    titulo: "Suporte",
    descricao: "Utilize esse canal para tirar suas dúvidas com nossa equipe de suporte.",
    confirmacao: "suporte"
  },
  den: {
    titulo: "Denúncias",
    descricao: "Utilize esse canal para realizar sua denúncia. Descreva o ocorrido e apresente as provas necessárias.",
    confirmacao: "denúncia"
  },
  role: {
    titulo: "Devolução de Cargo",
    descricao: "Utilize esse canal para solicitar a recuperação de um cargo removido ou perdido. Informe o cargo e apresente uma comprovação.",
    confirmacao: "devolução de cargo"
  },
  transfer: {
    titulo: "Transferência de Conta",
    descricao: "Utilize esse canal para solicitar a transferência de cargos ou benefícios entre contas. Informe os dados necessários para a análise.",
    confirmacao: "transferência de conta"
  }
};

function descricaoMigracao(guild) {
  return `Utilize esse canal para solicitar a migração de um cargo ou seu ingresso em **${serverName(guild)}**.\n\n` +
    "Informe o servidor de origem, o cargo desejado e envie as comprovações necessárias.";
}

// =====================================
// PERSISTÊNCIA
// =====================================

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

function carregarDados() {
  const vazio = {
    pendingCloses: {},
    claims: {},
    tickets: {},
    ticketRoles: {},
    ticketConfigRoles: {},
    ticketClaimRoles: {},
    ticketStats: {},
    ticketStatsBySystem: {},
    ticketGoals: {},
    ticketGoalsByRole: {},
    rolePanels: {}
  };

  try {
    if (!fs.existsSync(DATA_FILE)) return vazio;

    const bruto = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

    return {
      pendingCloses: bruto.pendingCloses || {},
      claims: bruto.claims || {},
      tickets: bruto.tickets || {},
      ticketRoles: bruto.ticketRoles || {},
      ticketConfigRoles: bruto.ticketConfigRoles || {},
      ticketClaimRoles: bruto.ticketClaimRoles || {},
      ticketStats: bruto.ticketStats || {},
      ticketStatsBySystem: bruto.ticketStatsBySystem || {},
      ticketGoals: bruto.ticketGoals || {},
      ticketGoalsByRole: bruto.ticketGoalsByRole || {},
      rolePanels: bruto.rolePanels || {}
    };
  } catch (error) {
    console.error("Não foi possível ler data.json:", error);
    return vazio;
  }
}

const dados = carregarDados();
for(const [threadId,ticket] of Object.entries(dados.tickets))if(["support","migration"].includes(ticket.sistema))commands.preserveChannel?.(threadId);

const horasCall = require("./voice-hours")({ client });
require("./panel-art/color-panel")({client,registry:commands,db:horasCall.store.db});
const resourceIds = require("./resource-ids")(horasCall.store.db);
const rankingsSystem=require("./rankings")({client,registry:commands,db:horasCall.store.db});
const gestaoTickets=require('./ticket-management')({client,registry:commands,db:horasCall.store.db,data:dados,save:salvarDados,closeTicket:iniciarEncerramento,refreshTicket:atualizarMensagemTicket});
const ticketThreadAccess = require("./ticket-management/thread-access")({
  client, data: dados, save: salvarDados,
  getStaffRoleIds(guildId, system) {
    const config = gestaoTickets.config(guildId);
    const claims = dados.ticketClaimRoles?.[guildId];
    const claimRoles = Array.isArray(claims) ? claims : claims?.[system] || [];
    return [
      ...(dados.ticketRoles?.[guildId]?.[system] || []),
      ...claimRoles,
      ...(config[`${system}Team`] || []),
      config[`${system}Role`], config.adminRole,
      ...(!claimRoles.length && STAFF_ROLE_ID ? [resourceIds.resolve(guildId,STAFF_ROLE_ID)] : [])
    ];
  }
});
const nicknameSystem=require('./nickname-protection')({client,registry:commands,db:horasCall.store.db});
const roleWhitelist = require("./role-whitelist")({
  client, registry: commands, db: horasCall.store.db,
  managedRoleIds: [], responderSemPermissao
});
const moderationGuard = require("./moderation-guard")({ client, db: horasCall.store.db, history: null });
const fichaCargos = require("./role-history")({
  client, db: horasCall.store.db, moderation: moderationGuard, responderSemPermissao, voltarGerenciamento: voltarDaFichaParaGerenciamento,
  autorizadoExtra: member => {
    const auth=member?.guild?roleWhitelist.access(member.guild,member):null;
    return auth?.kind==="whitelist"?Boolean(auth.profile.viewHistory):
      auth?.kind==="blocked"?false:null;
  }
});
const upSystem=require("./up")({ client, hours: horasCall.store, history: fichaCargos, responderSemPermissao });
const initialRoleSystem=require("./initial-role")({client,registry:commands,db:horasCall.store.db,history:fichaCargos});
const autoCallsSystem=require("./auto-calls")({client,registry:commands,db:horasCall.store.db});
const roleAdditionLog = require("./role-whitelist/addition-log")({
  client, registry: commands, db: horasCall.store.db
});
require("./role-whitelist/guard")({ client, history: fichaCargos, additionLog: roleAdditionLog,
  resolveRoleId:(guildId,id)=>resourceIds.resolve(guildId,id) });
const gamesSystem=require("./games-roles")({ client, registry: commands, db: horasCall.store.db });
const protecaoMidia = require("./media-moderation")({ client, registry: commands, db: horasCall.store.db });
const instagramWeb = require("./instagram-web")({client,db:horasCall.store.db,registry:commands,instagram:protecaoMidia.instagram,onShutdown:horasCall.beforeShutdown});
require("./instagram/ticket-panel")({ client, registry: commands, db: horasCall.store.db });
const verificacaoInstagram = require("./instagram/verification")({
  client, registry: commands, db: horasCall.store.db, data: dados, history: fichaCargos,
  canReview: (guild, member) => gestaoTickets.access(guild, member).support || podeAssumirTicket(member, guild.id, "support"),
  refreshTicket: id => {
    const ticket = horasCall.store.db.prepare("SELECT * FROM ticket_management_cases WHERE id=?").get(id);
    if (!ticket) throw new Error("Ticket não encontrado.");
    return atualizarMensagemTicket(ticket);
  }
});
const aiChatSystem=require("./ai-chat")({ client, registry: commands, db: horasCall.store.db });
require("./clear")({ client });
const centralComandos = require("./command-center")({ client, registry: commands, db: horasCall.store.db, responderSemPermissao });
const backupsServidor = require("./backups")({
  client, registry: commands, db: horasCall.store.db, botData:dados, dataFile:DATA_FILE,
  restorePanels:require("./backups/restore-panels")({
    registry:commands,threadAccess:ticketThreadAccess,commandCenter:centralComandos,
    renderSupport:g=>painelComArte("support",g),renderMigration:g=>painelComArte("migration",g)
  })
});
const painelUnmute = require("./unmute")({ client, registry: commands });
const nukeCanal = require("./nuke")({ client, registry: commands, botConfig: backupsServidor.botConfig, mediaModeration: protecaoMidia });
const serverLogs = require("./server-logs")({ client, db: horasCall.store.db, registry: commands });
require("./boost-logs")({ client, db: horasCall.store.db, registry: commands, ensureLogs: serverLogs.ensureGuild });
const bansSystem=require("./ban-management")({ client, db: horasCall.store.db, registry: commands });
moderationGuard.configureHistory(fichaCargos);

async function voltarDaFichaParaGerenciamento(interaction, painelId) {
  const estado = dados.rolePanels[painelId];
  if (!estado || estado.guildId !== interaction.guildId || estado.staffId !== interaction.user.id) {
    return responderErro(interaction, "O painel de gerenciamento expirou. Abra novamente com !cargos.");
  }
  const auth=roleWhitelist.access(interaction.guild,interaction.member);
  if (!auth || auth.kind==="blocked") {
    return responderSemPermissao(interaction);
  }
  await interaction.deferUpdate();
  renovarPainelCargos(estado);
  // O gerenciamento original nunca foi substituído: fecha só a ficha privada.
  await interaction.deleteReply();
}

function salvarDados() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2), "utf8");
  } catch (error) {
    console.error("Não foi possível salvar data.json:", error);
  }
}

function limparDadosTicket(canalId) {
  delete dados.tickets[canalId];
  delete dados.claims[canalId];
  delete dados.pendingCloses[canalId];
}

// Remove um ticket recém-criado cujo painel inicial não pôde ser enviado.
async function descartarTicketIncompleto(canal) {
  await canal.delete("Falha ao preparar o ticket").catch(() => {});
  limparDadosTicket(canal.id);
  salvarDados();
}

const timersFechamento = new Map();
const claimsEmAndamento = new Set();
const selecoesMetaCargo = new Map();
const usuariosEmOperacao = new Set();
const paineisEmOperacao = new Set();

// =====================================
// UTILITÁRIOS VISUAIS
// =====================================

const separador = () =>
  new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Small);

function containerAviso(titulo, texto, cor = COR_TICKET) {
  return new ContainerBuilder()
    .setAccentColor(cor)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(statusText(titulo))
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(texto)
    );
}

function responderV2(interaction, container) {
  return interaction.reply({
    components: [container],
    flags: FLAGS_EFEMERO_V2,
    allowedMentions: { parse: [] }
  });
}

function editarRespostaV2(interaction, container, allowedMentions = { parse: [] }) {
  return interaction.editReply({
    components: [container],
    flags: FLAGS_V2,
    allowedMentions
  });
}

function responderErro(interaction, texto, titulo = "# Não foi possível") {
  return responderV2(
    interaction,
    containerAviso(errorText(titulo), texto, COR_ERRO)
  );
}

function editarErro(interaction, texto, titulo = "# Não foi possível") {
  return editarRespostaV2(
    interaction,
    containerAviso(errorText(titulo), texto, COR_ERRO)
  );
}

function responderCanalV2(message, container) {
  return message.reply({
    components: [container],
    flags: FLAGS_V2,
    allowedMentions: { parse: [] }
  });
}

function criarContainerSemPermissao(usuarioId) {
  return new ContainerBuilder()
    .setAccentColor(COR_ERRO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "**<a:1175261181741641789:1569933923641983038> | Você não possui permissão para executar esse comando.**\n\n" +
        `Requisitado por: <@${usuarioId}>`
      )
    );
}

function responderSemPermissao(origem) {
  const usuario = origem.user || origem.author;
  const payload = {
    components: [criarContainerSemPermissao(usuario.id)],
    flags: origem.author ? FLAGS_V2 : FLAGS_EFEMERO_V2,
    allowedMentions: { parse: [], repliedUser: false }
  };

  // Após deferUpdate, a negativa deve ser privada, sem substituir o painel público.
  if (!origem.author && (origem.deferred || origem.replied)) {
    return origem.followUp(payload);
  }

  return origem.reply(payload);
}

// =====================================
// UTILITÁRIOS DOS TICKETS
// =====================================

function obterInfoTicket(canal) {
  const salvo = dados.tickets[canal?.id];
  if (salvo?.donoId && ["support", "migration"].includes(salvo.sistema)) {
    return { sistema: salvo.sistema, donoId: salvo.donoId };
  }

  const topico = canal?.topic ?? "";

  if (topico.startsWith("ticket-owner:")) {
    const donoId = topico.slice("ticket-owner:".length);
    if (donoId) return { sistema: "support", donoId };
  }

  if (topico.startsWith("migration-owner:")) {
    const donoId = topico.slice("migration-owner:".length);
    if (donoId) return { sistema: "migration", donoId };
  }

  return null;
}

async function localizarTicketAberto(guild, sistema, donoId, tipo = null) {
  for (const [id, meta] of Object.entries(dados.tickets)) {
    if (meta?.guildId !== guild.id || meta.sistema !== sistema || meta.donoId !== donoId) continue;
    if (sistema === "support" && (meta.tipo === "insta") !== (tipo === "insta")) continue;
    const thread = await guild.channels.fetch(id).catch(() => null);
    if (thread && !thread.archived && !thread.deleted) return thread;
    // Tópicos arquivados não são tickets ativos; elimina a referência obsoleta.
    if (!thread) {
      limparDadosTicket(id);
      salvarDados();
    }
  }
  return null;
}

async function criarTopicoTicket(interaction, { sistema, tipo, nome }) {
  const canalPai = interaction.channel;
  if (!canalPai || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(canalPai.type) || !canalPai.threads) {
    throw new Error("Publique o painel em um canal de texto compatível com tópicos.");
  }
  await ticketThreadAccess.grantParentAccess(canalPai, interaction.user.id);
  await ticketThreadAccess.grantStaffRoleAccess(canalPai, sistema);

  const thread = await canalPai.threads.create({
    name: nome.slice(0, 100),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: 1440,
    reason: `Ticket ${sistema} aberto por ${interaction.user.tag}`
  });
  commands.preserveChannel?.(thread.id);

  try {
    await thread.members.add(interaction.user.id);
    // Os cargos configurados são mencionados na mensagem inicial. Os membros
    // da equipe não são adicionados automaticamente ao tópico privado.
    dados.tickets[thread.id] = {
      sistema,
      tipo,
      donoId: interaction.user.id,
      guildId: interaction.guildId,
      parentId: canalPai.id,
      criadoEm: Date.now()
    };
    salvarDados();
    return thread;
  } catch (error) {
    await thread.delete("Falha ao adicionar o proprietário ao tópico").catch(() => {});
    throw error;
  }
}

function membroDaEquipe(membro) {
  if (!membro) return false;

  if (membro.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    return true;
  }

  return Boolean(
    STAFF_ROLE_ID &&
    membro.roles?.cache?.has(resourceIds.resolve(membro.guild?.id,STAFF_ROLE_ID))
  );
}

function podeGerenciarTicket(membro,guildId,sistema){
  return canManageTicket({member:membro,data:dados,config:gestaoTickets.config(guildId),
    guildId,system:sistema,staffRoleId:STAFF_ROLE_ID,resolve:(gid,id)=>resourceIds.resolve(gid,id)})||
    membroDaEquipe(membro);
}
function podeAssumirTicket(membro,guildId,sistema){return podeGerenciarTicket(membro,guildId,sistema);}
async function podeFecharTicket(interaction,info){
  if(interaction.user.id===info.donoId)return true;
  const membro=await interaction.guild.members.fetch(interaction.user.id).catch(()=>interaction.member);
  return podeGerenciarTicket(membro,interaction.guildId,info.sistema);
}

function metaTicketDoMembro(guildId,member,system){
  if(system&&member?.guild)return gestaoTickets.team.memberGoal(member.guild,system,member);
  const goals=dados.ticketGoalsByRole?.[guildId]||{};
  const claimConfig=dados.ticketClaimRoles?.[guildId];
  const systemRoles=system?(Array.isArray(claimConfig)?claimConfig:(claimConfig?.[system]||[])):null;
  const eligible=Object.entries(goals).filter(([roleId,value])=>(!systemRoles||systemRoles.includes(roleId))&&Number.isFinite(Number(value))&&Number(value)>0&&member?.roles?.cache?.has(roleId));
  if(eligible.length){
    eligible.sort((a,b)=>(member.guild.roles.cache.get(b[0])?.position||0)-(member.guild.roles.cache.get(a[0])?.position||0));
    return Number(eligible[0][1]);
  }
  return Number(dados.ticketGoals?.[guildId])||0;
}

function criarBotoesTicket({ sistema, canalId, assumidoPor }) {
  const botoes = [
    new ButtonBuilder()
      .setCustomId(`ticket-users:${canalId}`)
      .setLabel("Adicionar/Remover Usuário")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(
        sistema === "migration" ? "migration-close" : "ticket-close"
      )
      .setLabel("Fechar Ticket")
      .setStyle(ButtonStyle.Danger)
  ];

  if (!assumidoPor) {
    botoes.push(
      new ButtonBuilder()
        .setCustomId(`ticket-claim:${canalId}`)
        .setLabel("Assumir Ticket")
        .setStyle(ButtonStyle.Primary)
    );
  }

  return new ActionRowBuilder().addComponents(...botoes);
}

function criarContainerTicket({
  guild,
  canalId,
  donoId,
  sistema,
  tipo,
  assumidoPor,
  cargosMarcados=[],
  ticketAtendidos=0,
  ticketMeta=0
}) {
  if (sistema === "support" && tipo === "insta") {
    return verificacaoInstagram.render({
      canalId, donoId, cargosMarcados,
      controls: criarBotoesTicket({ sistema, canalId, assumidoPor })
    });
  }
  const categoria = sistema === "migration"
    ? { titulo: "Migração", descricao: descricaoMigracao(guild) }
    : (
      tipos[tipo] || {
        titulo: `${serverName(guild)} - Atendimento`,
        descricao:
          "Descreva sua situação com detalhes. Nossa equipe irá ajudar você."
      }
    );

  const miniatura = guild?.iconURL?.({ extension: "png", size: 256 }) ||
    (sistema === "migration" ? MINIATURA_MIGRACAO : MINIATURA_SUPORTE);

  const container = new ContainerBuilder()
    .setAccentColor(COR_TICKET)

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${serverName(guild)} - ${categoria.titulo}`)
    )

    .addSeparatorComponents(separador())

    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `Olá, <@${donoId}>!${cargosMarcados.length?`\n\nEquipe: ${cargosMarcados.map(id=>`<@&${id}>`).join(" ")}`:""}\n\n${categoria.descricao}`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(miniatura)
        )
    )

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "**Ao finalizar, o ticket pode ser fechado utilizando o botão abaixo.**"
      )
    );

  if (assumidoPor) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Ticket assumido por: <@${assumidoPor}> · Atendidos: **${ticketAtendidos}**${ticketMeta>0?` / **${ticketMeta}** (faltam **${Math.max(0,ticketMeta-ticketAtendidos)}**)`:""}`
      )
    );
  }

  container
    .addSeparatorComponents(separador())
    .addActionRowComponents(
      criarBotoesTicket({ sistema, canalId, assumidoPor })
    );

  return container;
}

function criarContainerConfirmacao(texto) {
  return new ContainerBuilder()
    .setAccentColor(COR_SUCESSO)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Ticket criado")
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(texto)
    );
}

async function atualizarMensagemTicket(ticket,original){
  const meta=dados.tickets[ticket.id];if(!meta)return;
  const channel=await client.channels.fetch(ticket.id);
  const message=original||(meta.messageId?await channel.messages.fetch(meta.messageId):null);
  if(!message||message.author?.id!==client.user.id)return;
  const member=ticket.assigneeId?await channel.guild.members.fetch(ticket.assigneeId).catch(()=>null):null;
  await message.edit({components:[criarContainerTicket({guild:channel.guild,canalId:ticket.id,donoId:ticket.ownerId,sistema:ticket.area,tipo:ticket.kind,assumidoPor:ticket.assigneeId,
    cargosMarcados:dados.ticketRoles[channel.guildId]?.[ticket.area]||[],ticketAtendidos:Number(dados.ticketStatsBySystem[channel.guildId]?.[ticket.area]?.[ticket.assigneeId])||0,
    ticketMeta:member?metaTicketDoMembro(channel.guildId,member,ticket.area):0})],flags:FLAGS_V2,allowedMentions:{parse:[]}});
  commands.preserveMessage(message);
}

function criarContainerExcluindo() {
  return new ContainerBuilder()
    .setAccentColor(COR_TICKET)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("# Excluindo ticket")
    )
    .addSeparatorComponents(separador())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "Este ticket será excluído em 5 segundos."
      )
    );
}

function mensagemMostraAssumido(mensagem) {
  try {
    const componentes = mensagem?.components?.map(
      componente => (
        typeof componente.toJSON === "function"
          ? componente.toJSON()
          : componente
      )
    );

    return JSON.stringify(componentes).includes("Ticket assumido por:");
  } catch {
    return false;
  }
}

// =====================================
// ENCERRAMENTO DE TICKETS
// =====================================

function agendarExclusao(canalId, atraso, tentativa = 0) {
  if (timersFechamento.has(canalId)) return;

  const timer = setTimeout(
    () => executarExclusao(canalId, tentativa),
    Math.max(0, atraso)
  );

  timersFechamento.set(canalId, timer);
}

async function executarExclusao(canalId, tentativa = 0) {
  timersFechamento.delete(canalId);

  if (!dados.pendingCloses[canalId]) return;

  let canal = null;

  try {
    canal = await client.channels.fetch(canalId);
  } catch {
    canal = null;
  }

  if (!canal) {
    limparDadosTicket(canalId);
    salvarDados();
    return;
  }

  try {
    await canal.delete("Ticket encerrado");
    limparDadosTicket(canalId);
    salvarDados();
  } catch (error) {
    console.error("Erro ao excluir ticket:", error);

    if (tentativa < 2) {
      agendarExclusao(canalId, 2000, tentativa + 1);
      return;
    }

    delete dados.pendingCloses[canalId];
    salvarDados();
  }
}

function recuperarFechamentosPendentes() {
  const agora = Date.now();

  for (const [canalId, pendente] of Object.entries(dados.pendingCloses)) {
    const deleteAt = Number(pendente?.deleteAt);
    const restante = Number.isFinite(deleteAt) ? deleteAt - agora : 0;
    agendarExclusao(canalId, restante);
  }
}

function podarPaineisAntigos() {
  const limite = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let alterou = false;

  for (const [id, painel] of Object.entries(dados.rolePanels)) {
    if (!painel || !Number.isFinite(Number(painel.criadoEm)) || Number(painel.criadoEm) < limite) {
      delete dados.rolePanels[id];
      alterou = true;
    }
  }

  if (alterou) salvarDados();
}

async function iniciarEncerramento(interaction, canal) {
  if (dados.pendingCloses[canal.id]) {
    return responderErro(
      interaction,
      "Este ticket já está sendo encerrado.",
      "# Encerramento em andamento"
    );
  }

  const deleteAt = Date.now() + 5000;
  const claim=dados.claims[canal.id],ticket=dados.tickets[canal.id];
  if(claim?.userId&&ticket&&!ticket.atendimentoContabilizado){
    const guildId=ticket.guildId||interaction.guildId;
    dados.ticketStats[guildId]??={};
    dados.ticketStats[guildId][claim.userId]=(Number(dados.ticketStats[guildId][claim.userId])||0)+1;
    const system=ticket.sistema==="migration"?"migration":"support";
    dados.ticketStatsBySystem[guildId]??={support:{},migration:{}};
    dados.ticketStatsBySystem[guildId][system]??={};
    dados.ticketStatsBySystem[guildId][system][claim.userId]=(Number(dados.ticketStatsBySystem[guildId][system][claim.userId])||0)+1;
    ticket.atendimentoContabilizado=true;
  }

  dados.pendingCloses[canal.id] = {
    deleteAt,
    guildId: interaction.guildId,
    por: interaction.user.id
  };

  salvarDados();

  const responderEncerramento=interaction.deferred?interaction.editReply.bind(interaction):interaction.reply.bind(interaction);
  await responderEncerramento({
    components: [
      containerAviso(
        "# Encerramento iniciado",
        "Este ticket será excluído em 5 segundos.",
        COR_TICKET
      )
    ],
    flags: FLAGS_EFEMERO_V2,
    allowedMentions: { parse: [] }
  }).catch(() => {});

  await canal.send({
    components: [criarContainerExcluindo()],
    flags: FLAGS_V2,
    allowedMentions: { parse: [] }
  }).catch(error => {
    console.error("Erro ao enviar aviso de exclusão:", error);
  });

  agendarExclusao(canal.id, 5000);
}

// =====================================
// GERENCIAMENTO DE CARGOS
// =====================================

const INATIVIDADE_PAINEL_CARGOS = 30_000;
const timersPainelCargos = new Map();

function agendarExpiracaoPainelCargos(estado) {
  clearTimeout(timersPainelCargos.get(estado.id));
  if (!estado.channelId || !estado.messageId) return;

  const atraso = Math.max(0, estado.ultimaAtividade + INATIVIDADE_PAINEL_CARGOS - Date.now());
  const timer = setTimeout(async () => {
    timersPainelCargos.delete(estado.id);
    if (dados.rolePanels[estado.id] !== estado) return;

    delete dados.rolePanels[estado.id];
    salvarDados();

    try {
      const canal = await client.channels.fetch(estado.channelId);
      if (canal?.isTextBased()) await canal.messages.delete(estado.messageId);
    } catch (error) {
      // Mensagem/canal já apagados não são erros de funcionamento.
      if (error.code !== 10008 && error.code !== 10003) {
        console.error("Erro ao apagar painel de cargos inativo:", error);
      }
    }
  }, atraso);

  timersPainelCargos.set(estado.id, timer);
}

function renovarPainelCargos(estado) {
  estado.ultimaAtividade = Date.now();
  salvarDados();
  agendarExpiracaoPainelCargos(estado);
}

function recuperarExpiracoesPaineisCargos() {
  for (const estado of Object.values(dados.rolePanels)) {
    if (!estado.channelId || !estado.messageId) continue;
    estado.ultimaAtividade = Number(estado.ultimaAtividade) || estado.criadoEm;
    agendarExpiracaoPainelCargos(estado);
  }
}

// Só uma carga completa por servidor. Os totais não são persistidos: podem mudar
// enquanto o bot estiver offline. Eventos mantêm o retrato completo atualizado.
const contagensCargos = new Map();
const revisoesPainelCargos = new WeakMap();
const INTERVALO_CARGA_MEMBROS = 60_000;

function cargosContadosDoMembro(membro) {
  if (membro.partial || !membro.roles?.cache) {
    throw new Error("Dados incompletos de um membro.");
  }

  return new Set(
    cargosDoServidor(membro.guild).filter(role => membro.roles.cache.has(role.id)).map(role => role.id)
  );
}

function contagemConfiavel(guild, estado = contagensCargos.get(guild.id)) {
  if (!estado?.confiavel || !guild.available) return false;

  if (estado.membros.size !== guild.memberCount) {
    estado.confiavel = false;
    return false;
  }

  return true;
}

function suspenderContagens(guild) {
  // Também invalida uma carga que ainda esteja em andamento.
  contagensCargos.set(guild.id, {
    shardId: guild.shardId,
    confiavel: false,
    membros: new Map(),
    totais: new Map(),
    carregamento: null,
    alteracoes: null,
    tentarNovamenteEm: Date.now() + INTERVALO_CARGA_MEMBROS
  });
}

function atualizarContagemMembro(membro, removido = false) {
  const estado = contagensCargos.get(membro.guild.id);
  if (!estado) return;

  let cargos;

  try {
    cargos = removido ? null : cargosContadosDoMembro(membro);
  } catch {
    suspenderContagens(membro.guild);
    return;
  }

  // Entradas, saídas e alterações durante os chunks prevalecem sobre a carga.
  if (estado.alteracoes) estado.alteracoes.set(membro.id, cargos);
  if (!estado.confiavel) return;

  const anteriores = estado.membros.get(membro.id) || new Set();
  const atuais = cargos || new Set();

  // Comparar retratos evita contar duas vezes a mesma mudança (REST + Gateway).
  for (const cargoId of anteriores) {
    if (!atuais.has(cargoId)) {
      estado.totais.set(cargoId, estado.totais.get(cargoId) - 1);
    }
  }

  for (const cargoId of atuais) {
    if (!anteriores.has(cargoId)) {
      estado.totais.set(cargoId, (estado.totais.get(cargoId) || 0) + 1);
    }
  }

  if (removido) estado.membros.delete(membro.id);
  else estado.membros.set(membro.id, atuais);
}

async function garantirContagensCargos(guild) {
  if (
    !guild.available ||
    !client.options.intents.has(GatewayIntentBits.GuildMembers)
  ) return;

  let estado = contagensCargos.get(guild.id);

  if (!estado) {
    estado = {
      shardId: guild.shardId,
      confiavel: false,
      membros: new Map(),
      totais: new Map(),
      carregamento: null,
      alteracoes: null,
      tentarNovamenteEm: 0
    };
    contagensCargos.set(guild.id, estado);
  }

  if (contagemConfiavel(guild, estado)) return;
  if (estado.carregamento) return estado.carregamento;
  if (Date.now() < estado.tentarNovamenteEm) return;

  estado.alteracoes = new Map();
  estado.carregamento = (async () => {
    try {
      // Sem query, limite ou filtro de presença: inclui TODOS os membros.
      const cacheCompleto = guild.members.cache?.size === guild.memberCount;
      const membros = await (cacheCompleto ? guild.members.cache : guild.members.fetch({
        withPresences: false,
        time: 30_000
      }));

      if (contagensCargos.get(guild.id) !== estado || !guild.available) return;

      const retrato = new Map();
      for (const membro of membros.values()) {
        retrato.set(membro.id, cargosContadosDoMembro(membro));
      }

      for (const [id, cargos] of estado.alteracoes) {
        if (cargos === null) retrato.delete(id);
        else retrato.set(id, cargos);
      }

      if (retrato.size !== guild.memberCount) {
        throw new Error("A lista recebida não contém todos os membros do servidor.");
      }

      const totais = new Map(cargosDoServidor(guild).map(role => [role.id, 0]));
      for (const cargos of retrato.values()) {
        for (const id of cargos) totais.set(id, totais.get(id) + 1);
      }

      estado.membros = retrato;
      estado.totais = totais;
      estado.confiavel = true;
    } catch (error) {
      estado.confiavel = false;
      console.warn(`Contagem de cargos indisponível em ${guild.id}:`, error.message);
    } finally {
      estado.alteracoes = null;
      estado.carregamento = null;
      estado.tentarNovamenteEm = Date.now() + INTERVALO_CARGA_MEMBROS;
    }
  })();

  return estado.carregamento;
}

function textoContagemCargo(guild, cargoId) {
  const estado = contagensCargos.get(guild.id);
  const total = contagemConfiavel(guild, estado)
    ? estado.totais.get(cargoId)
    : null;

  if (!Number.isInteger(total) || total < 0) {
    return estado?.carregamento ? "<a:loadingBot:1575884281748783295> Carregando contagem…" : "Contagem indisponível";
  }
  return `<:members:1569924587293122630> ${total} ${total === 1 ? "usuário" : "usuários"}`;
}

function atualizarContagensQuandoProntas({estado,guild,autor,alvo,editar}) {
  const revisao = revisoesPainelCargos.get(estado);
  void garantirContagensCargos(guild).then(async () => {
    if (!contagemConfiavel(guild) ||
        dados.rolePanels[estado.id] !== estado ||
        revisoesPainelCargos.get(estado) !== revisao) return;
    const membro = guild.members.cache?.get(estado.targetId) || alvo;
    if (validarAlvo(guild,autor,membro)) return;
    await editar({
      components: [montarContainerCargos({estado,guild,autor,alvo:membro})],
      flags: FLAGS_V2,
      allowedMentions: {parse:[]}
    });
  }).catch(error => console.warn("Não foi possível atualizar as contagens do painel:",error.message));
}

client.on("guildMemberAdd", membro => atualizarContagemMembro(membro));
client.on("guildMemberAvailable", membro => atualizarContagemMembro(membro));
client.on("guildMemberUpdate", (_anterior, membro) => atualizarContagemMembro(membro));
client.on("guildMemberRemove", membro => atualizarContagemMembro(membro, true));

for (const evento of ["guildUnavailable", "guildAvailable", "guildDelete"]) {
  client.on(evento, guild => contagensCargos.delete(guild.id));
}

for (const evento of ["guildRoleCreate", "guildRoleDelete", "guildRoleUpdate"]) {
  client.on(evento, role => suspenderContagens(role.guild));
}

function invalidarContagensShard(shardId) {
  for (const [guildId, estado] of contagensCargos) {
    if (estado.shardId === shardId) contagensCargos.delete(guildId);
  }
}

client.on("shardDisconnect", (_evento, shardId) => invalidarContagensShard(shardId));
client.on("shardReconnecting", invalidarContagensShard);
client.on("shardReady", invalidarContagensShard);
client.on("shardResume", invalidarContagensShard);
client.on("invalidated", () => contagensCargos.clear());

function normalizarTexto(texto) {
  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function limiteHierarquia(guild, autor) {
  const eu = guild.members.me;
  const limiteAutor = autor.id === guild.ownerId
    ? Infinity
    : autor.roles.highest.position;
  const limiteBot = eu ? eu.roles.highest.position : 0;

  return Math.min(limiteAutor, limiteBot);
}

function obterCargosAutorizados(guild, autor, alvo = autor) {
  const auth = roleWhitelist.access(guild, autor);
  if (!auth || auth.kind === "blocked") return [];
  if (auth.kind === "whitelist") {
    const p = auth.profile,maxRole=guild.roles.cache.get(p.maxRoleId);
    return cargosDoServidor(guild).filter(cargo => {
      return cargo && maxRole && cargo.comparePositionTo(maxRole)<=0 &&
        ((p.add&&roleWhitelist.canRole(guild,autor,alvo,cargo,"add",auth)) ||
          (p.remove&&roleWhitelist.canRole(guild,autor,alvo,cargo,"remove",auth)));
    }).sort((a,b) => b.comparePositionTo(a));
  }
  const limite = limiteHierarquia(guild, autor);

  return cargosDoServidor(guild)
    .filter(cargo => (
      cargo &&
      cargo.id !== guild.id &&
      !cargo.managed &&
      cargo.position < limite
    ))
    .sort((a, b) => b.position - a.position);
}

function validarAlvo(guild, autor, alvo) {
  if (!alvo) return "Usuário não encontrado no servidor.";
  const auth=roleWhitelist.access(guild,autor);
  if(!auth||auth.kind==="blocked")return "Whitelist ausente, suspensa, revogada ou expirada.";
  const motivoAlvo=roleWhitelist.targetDenial(guild,autor,alvo,auth);
  if(motivoAlvo)return motivoAlvo;

  if (alvo.id === client.user.id) {
    return "Não é possível gerenciar os cargos do bot.";
  }

  const eu = guild.members.me;

  if (
    eu &&
    alvo.id !== autor.id &&
    alvo.roles.highest.comparePositionTo(eu.roles.highest) >= 0
  ) {
    return "O usuário possui um cargo igual ou superior ao do bot.";
  }

  return null;
}

function cargoPermitido(guild, autor, cargo, alvo = null) {
  if (!cargo) return false;
  if (cargo.id === guild.id || cargo.managed) return false;
  const auth=roleWhitelist.access(guild,autor);
  if(!auth||auth.kind==="blocked")return false;
  if(auth.kind==="whitelist"){
    return roleWhitelist.canRole(guild,autor,alvo||autor,cargo,(alvo||autor).roles.cache.has(cargo.id)?"remove":"add",auth);
  }
  if(auth.kind==="native")return roleWhitelist.canRole(guild,autor,alvo||autor,cargo,(alvo||autor).roles.cache.has(cargo.id)?"remove":"add",auth);

  // Exceção somente para REMOVER um cargo que o próprio autor já possui.
  // Não permite adicionar novamente um cargo fora da lista/hierarquia autorizada.
  if (alvo?.id === autor.id && alvo.roles.cache.has(cargo.id)) {
    return cargo.position < (guild.members.me?.roles.highest.position || 0);
  }

  if (!guild.roles.cache.has(cargo.id)) return false;
  return cargo.position < limiteHierarquia(guild, autor);
}

function montarContainerCargos({ estado, guild, autor, alvo }) {
  revisoesPainelCargos.set(estado,(revisoesPainelCargos.get(estado)||0)+1);
  const id = estado.id;
  const busca = normalizarTexto(estado.busca || "");

  if (!FILTROS_CARGOS.includes(estado.filtro)) {
    estado.filtro = "todos";
  }

  const auth=roleWhitelist.access(guild,autor),profile=auth?.kind==="whitelist"?auth.profile:null;
  // Visibilidade não concede autorização: Todos inclui até cargos protegidos,
  // mas os botões e cada operação continuam consultando cargoPermitido.
  const cargos = estado.filtro === "todos"
    ? [...guild.roles.cache.values()].sort((a,b)=>b.comparePositionTo(a))
    : obterCargosAutorizados(guild, autor, alvo).filter(cargo=>cargoPermitido(guild,autor,cargo,alvo));

  const filtrados = cargos.filter(cargo => {
    const possui = alvo.roles.cache.has(cargo.id);

    if (estado.filtro === "disponiveis" && possui) return false;
    if (estado.filtro === "removiveis" && !possui) return false;

    return !busca || normalizarTexto(cargo.name).includes(busca);
  });

  const porAbas = guild.id === "1571755216519438347";
  const abas = porAbas ? require("./role-whitelist/tabs").roleTabs(
    [...guild.roles.cache.values()].sort((a,b)=>b.comparePositionTo(a)),
    new Set(filtrados.map(role=>role.id)),
    6
  ) : [];
  const totalPaginas = Math.max(
    1,
    porAbas ? abas.length : Math.ceil(filtrados.length / CARGOS_POR_PAGINA)
  );

  const pagina = Math.min(
    Math.max(1, Number(estado.page) || 1),
    totalPaginas
  );

  estado.page = pagina;

  const visiveis = porAbas ? (abas[pagina - 1]?.roles || []) : filtrados.slice(
    (pagina - 1) * CARGOS_POR_PAGINA,
    pagina * CARGOS_POR_PAGINA
  );

  const container = new ContainerBuilder()
    .setAccentColor(COR_TICKET)

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# Gerenciamento de Cargos | ${serverName(guild)}`
        + (porAbas ? `\n-# ${abas[pagina - 1]?.label || "Nenhuma aba neste filtro"} · Separadas pelas divisórias do servidor` : "")
      )
    )

    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `**Olá, ${autor}!**\n\n` +
            `**Você está gerenciando ${alvo}**`
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(
            alvo.displayAvatarURL({ extension: "png", size: 256 })
          )
        )
    )

    .addSeparatorComponents(...(porAbas ? [] : [separador()]));

  if (!visiveis.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        porAbas && estado.filtro === "todos"
          ? "Nenhum cargo encontrado nas abas para esta busca."
          : profile && !guild.roles.cache.has(profile.maxRoleId)
          ? "Nenhum cargo disponível: o cargo máximo da WL não existe mais. Edite o limite em `!wlcargos`."
          : !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)
            ? "O bot precisa da permissão **Gerenciar Cargos** para disponibilizar as ações."
            : "Nenhum cargo disponível neste filtro. Confira a busca e se o cargo do bot está acima dos cargos autorizados."
      )
    );
  } else {
    for (const [indice, cargo] of visiveis.entries()) {
      if (indice > 0) container.addSeparatorComponents(separador());

      const possui = alvo.roles.cache.has(cargo.id);

      const botao = new ButtonBuilder()
        .setCustomId(`cargos:role:${id}:${cargo.id}`)
        .setLabel(possui ? "Remover" : "Adicionar")
        .setEmoji({
          id: possui ? "1569941264772628513" : "1569946663945113662"
        })
        .setStyle(
          possui ? ButtonStyle.Danger : ButtonStyle.Success
        )
      .setDisabled(!cargoPermitido(guild, autor, cargo, alvo));

      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              `**<@&${cargo.id}>**\n${textoContagemCargo(guild, cargo.id)}`
            )
          )
          .setButtonAccessory(botao)
      );
    }
  }

  const botaoFiltro = (valor, label) =>
    new ButtonBuilder()
      .setCustomId(`cargos:filtro:${id}:${valor}`)
      .setLabel(label)
      .setStyle(
        estado.filtro === valor
          ? ButtonStyle.Primary
          : ButtonStyle.Secondary
      );

  if(porAbas && abas.length){
    const inicio = Math.floor((pagina - 1) / 25) * 25;
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`cargos:aba:${id}`)
        .setPlaceholder("Escolha uma aba de cargos")
        .addOptions(abas.slice(inicio,inicio+25).map((aba,n)=>({
          label:aba.label,value:String(inicio+n+1),default:inicio+n+1===pagina
        })))
    ));
  }
  if(!porAbas)container.addSeparatorComponents(separador());
  container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        botaoFiltro("disponiveis", "Disponíveis"),
        botaoFiltro("removiveis", "Removíveis"),
        botaoFiltro("todos", "Todos"),
        new ButtonBuilder()
          .setCustomId(`cargos:historico:${id}`)
          .setLabel("Ficha do usuário")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`cargos:buscar:${id}`)
          .setEmoji({ id: "1569941293323255889" })
          .setStyle(ButtonStyle.Secondary)
      )
    );
  if(!porAbas)container.addSeparatorComponents(separador());
  container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`cargos:pagina:${id}:${pagina - 1}`)
          .setLabel("<")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pagina <= 1),

        new ButtonBuilder()
          .setCustomId(`cargos:pageinfo:${id}`)
          .setLabel(porAbas ? `${abas[pagina - 1]?.label || "Abas"} · ${pagina}/${totalPaginas}` : `${pagina}/${totalPaginas}`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),

        new ButtonBuilder()
          .setCustomId(`cargos:pagina:${id}:${pagina + 1}`)
          .setLabel(">")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(pagina >= totalPaginas)
      )
    );

  return require("./lumiya-ui/canonical").canonical({components:[container]},{path:["Cargos"]}).components[0];
}

async function atualizarPainelCargos(interaction, estado, alvoAtualizado = null) {
  try {
    const guild = interaction.guild;
    const autor = interaction.member;

    const alvo = alvoAtualizado || await guild.members
      .fetch(estado.targetId)
      .catch(() => null);

    const erro = validarAlvo(guild, autor, alvo);

    if (erro) {
      if (alvo) return await responderSemPermissao(interaction);

      return await interaction.followUp({
        components: [
          containerAviso("# Não foi possível", erro, COR_ERRO)
        ],
        flags: FLAGS_EFEMERO_V2,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }

    // A carga completa é apenas para os totais informativos: nunca bloqueia
    // uma ação do painel por chunks de membros ou rate limits do Gateway.
    void garantirContagensCargos(guild).catch(error =>
      console.warn("Não foi possível carregar as contagens de cargos:", error.message));

    const contagensPendentes = !contagemConfiavel(guild);
    const container = montarContainerCargos({
      estado,
      guild,
      autor,
      alvo
    });

    const resposta = await interaction.editReply({
      components: [container],
      flags: FLAGS_V2,
      allowedMentions: { parse: [] }
    });
    if (contagensPendentes) atualizarContagensQuandoProntas({
      estado,guild,autor,alvo,editar:payload=>interaction.editReply(payload)
    });
    return resposta;
  } catch (error) {
    console.error("Erro ao atualizar painel de cargos:", error);

    await interaction.followUp({
      components: [
        containerAviso(
          "# Erro ao atualizar painel",
          "Não foi possível atualizar o painel. Tente novamente.",
          COR_ERRO
        )
      ],
      flags: FLAGS_EFEMERO_V2,
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

function criarModalBusca(id, busca) {
  const input = new TextInputBuilder()
    .setCustomId("busca")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100)
    .setPlaceholder("Digite o nome do cargo");

  if (busca) input.setValue(busca);

  return new ModalBuilder()
    .setCustomId(`cargos:modal:${id}`)
    .setTitle("Pesquisar cargos")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Nome do cargo")
        .setDescription(
          "A lista será filtrada pelo nome informado."
        )
        .setTextInputComponent(input)
    );
}

async function painelComArte(kind, guild) {
  const rendered=await painelComArteBase(kind,guild);
  const raw=JSON.stringify(rendered.component.toJSON());
  return {...rendered,files:[...(rendered.files||[]),...require("./configuration/runtime").filesFor([rendered.component])]
    .filter(file=>raw.includes(`attachment://${file.name}`))};
}
async function painelComArteBase(kind, guild) {
  if(!panelImagesEnabled(guild)){
    return {component:kind==="support"?criarPainel(guild):criarPainelMigracao(guild),files:[]};
  }
  // O servidor sla usa a URL da arte diretamente, sem gerar nem anexar PNG.
  if (kind === "support" && prefereTexto(guild)) {
    return { component: criarPainel(guild, SLA_SUPPORT_ART), files: [] };
  }
  if (kind === "migration" && prefereTexto(guild)) {
    return { component: criarPainelMigracao(guild, SLA_MIGRATION_ART), files: [] };
  }
  const arte = `arte-${kind}.png`;
  try {
    const data = await renderPanelArt(kind, guild);
    return {
      component: kind === "support" ? criarPainel(guild, arte) : criarPainelMigracao(guild, arte),
      files: [{ name: arte, attachment: data }]
    };
  } catch (error) {
    console.warn(`[Arte do painel] Falha ao gerar arte para ${guild?.id}; usando arte original:`, error.message);
    return {
      component: kind === "support" ? criarPainel(guild) : criarPainelMigracao(guild),
      files: []
    };
  }
}

// =====================================
// PAINEL DE SUPORTE - COMPONENTS V2
// =====================================

// Aceita tanto uma URL externa quanto o nome de um arquivo anexado.
const urlArtePainel = (arte, fallback) =>
  /^https?:\/\//i.test(String(arte || "")) ? arte : (arte ? `attachment://${arte}` : fallback);

function criarPainel(guild, arte) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("ticket-support")
    .setPlaceholder("Selecione uma opção!")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      {
        label: "Suporte geral",
        description: "Dúvidas, problemas ou qualquer outro tipo de ajuda.",
        value: "sup"
      },
      {
        label: "Denúncias",
        description: "Relatos de infrações, abusos ou quebra de regras.",
        value: "den"
      },
      {
        label: "Devolução de cargo",
        description: "Pedido para recuperar cargos removidos ou perdidos.",
        value: "role"
      },
      {
        label: "Transferência de conta",
        description: "Transferir cargos ou benefícios de uma conta para outra.",
        value: "transfer"
      }
    );

  const separador = () =>
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small);

  const painel = new ContainerBuilder()
    .setAccentColor(0)

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(titulo(guild, "<:emoji_14:1570072344255533137><:emoji_13:1570072317873233942><:emoji_12:1570072282003542106>", "Suporte"))
    )

    .addSeparatorComponents(separador())

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# Precisa de ajuda ou ficou com alguma dúvida?\n" +
        "-# Aperte no botão abaixo e escolha a opção que melhor se encaixa no seu problema."
      )
    )

    .addSeparatorComponents(separador())

    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        item => item.setURL(urlArtePainel(arte, "https://cdn.discordapp.com/attachments/1569908468440367188/1570260006320734310/1794449490003.png"))
      )
    )

    .addSeparatorComponents(separador())

    .addActionRowComponents(
      new ActionRowBuilder().addComponents(menu)
    );
  return applyPanelAppearance(painel,guild,"support");
}

// =====================================
// PAINEL DE MIGRAÇÃO
// =====================================

function criarPainelMigracao(guild, arte) {

  const separador = () =>
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small);

  const botao = new ButtonBuilder()
    .setCustomId("ticket-migration")
    .setLabel("Migração")
    .setStyle(ButtonStyle.Secondary);

  const painel = new ContainerBuilder()
    .setAccentColor(0)

    .addTextDisplayComponents(
      new TextDisplayBuilder()
        .setContent(titulo(guild, "<:emoji_17:1570091847400038510><:emoji_16:1570091819084021821><:emoji_15:1570091778416189533>", "Migração"))
    )

    .addSeparatorComponents(separador())

    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# Deseja migrar seu cargo ou ingressar em ${serverName(guild)}?\n\n` +
        "> - **Migração:**\n> \n" +
        `> -# Possui cargo em outro servidor e deseja migrar para a **${serverName(guild)}.**\n` +
        `> - **Ingressar em ${serverName(guild)}:**\n> \n` +
        "> -# Novo no servidor e deseja um cargo inicial para acessar os benefícios.\n\n" +
        "**Aperte no botão abaixo e escolha a opção que melhor se encaixa na sua situação.**"
      )
    )

    .addSeparatorComponents(separador())

    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        item => item.setURL(urlArtePainel(arte, "https://cdn.discordapp.com/attachments/1569908468440367188/1570260113984331876/1794449526646.png"))
      )
    )

    .addSeparatorComponents(separador())

    .addActionRowComponents(
      new ActionRowBuilder().addComponents(botao)
    );

  return applyPanelAppearance(painel,guild,"migration");
}

// =====================================
// COMANDO !hall — DIRETRIZES DO DISCORD
// =====================================

const HALL_ART = "https://cdn.discordapp.com/attachments/1570868736926425190/1572062628103192617/file_000000003d04820e99d03c51b25ecc0d.png";

function criarPainelHall(guild) {
  const separador = () =>
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small);
  const painel = new ContainerBuilder()
    .setAccentColor(0)
    .addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(item => item.setURL(HALL_ART))
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Termos de Serviço do Discord")
          .setStyle(ButtonStyle.Link)
          .setURL("https://discord.com/terms")
      )
    );
  if(!panelImagesEnabled(guild))painel.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("## Diretrizes do Discord\nConsulte os Termos de Serviço do Discord pelo botão acima.")
  );
  return applyPanelAppearance(painel,guild,"hall");
}

async function comandoHall(message) {
  if (!message.guild || message.author.bot) return;
  if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return responderSemPermissao(message);
  }
  try {
    const component=criarPainelHall(message.guild);
    const panelFiles=require("./configuration/runtime").filesFor([component]);
    const painel = await message.channel.send({
      components: [component],
      ...(panelFiles.length?{files:panelFiles}:{}),
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    });
    if (painel?.id) {
      commands.preserveMessage(painel);
      backupsServidor.botConfig.trackPanel(message.guild.id, message.channel.id, "hall", painel.id);
    }
    await message.delete().catch(() => {});
  } catch (error) {
    console.error("Erro ao enviar painel hall:", error);
    await responderCanalV2(
      message,
      containerAviso("# Erro ao enviar painel", "Não foi possível enviar o painel de diretrizes.", COR_ERRO)
    );
  }
}

commands.register({
  name: "hall",
  description: "Publica o painel de boas-vindas e diretrizes da comunidade.",
  category: "Geral",
  permissions: ["ManageGuild"],
  result: "Publica o painel de diretrizes do Discord com imagem e links oficiais.",
  prefix: { trigger: "!hall", exact: true, execute: comandoHall }
});

// =====================================
// COMANDO !painel
// =====================================

async function comandoPainel(message) {
  if (!message.guild || message.author.bot) return;

  if (!message.member.permissions.has(
    PermissionFlagsBits.ManageGuild
  )) {
    return responderSemPermissao(message);
  }

  try {
    const { component, files } = await painelComArte("support", message.guild);
    const painel = await message.channel.send({
      components: [component],
      files,
      flags: MessageFlags.IsComponentsV2
    });
    if (painel?.id) {
      commands.preserveMessage(painel);
      backupsServidor.botConfig.trackPanel(message.guild.id,message.channel.id,"support",painel.id);
    }

    await message.delete().catch(() => {});
  } catch (error) {
    console.error("Erro ao enviar painel:", error);
    await responderCanalV2(
      message,
      containerAviso(
        "# Erro ao enviar painel",
        "Não foi possível enviar o painel.",
        COR_ERRO
      )
    );
  }
}

commands.register({
  name: "painel", description: "Envia o painel oficial de suporte e abertura de tickets.", category: "Suporte",
  permissions: ["ManageGuild"], result: "Publica o painel de atendimento no canal atual.",
  prefix: { trigger: "!painel", exact: true, execute: comandoPainel }
});

// =====================================
// COMANDO !migracao
// =====================================

async function comandoMigracao(message) {
  if (!message.guild || message.author.bot) return;

  if (!message.member.permissions.has(
    PermissionFlagsBits.ManageGuild
  )) {
    return responderSemPermissao(message);
  }

  try {
    const { component, files } = await painelComArte("migration", message.guild);
    const painel = await message.channel.send({
      components: [component],
      files,
      flags: MessageFlags.IsComponentsV2
    });
    if (painel?.id) {
      commands.preserveMessage(painel);
      backupsServidor.botConfig.trackPanel(message.guild.id,message.channel.id,"migration",painel.id);
    }
    // Painel de migração é permanente: fixar evita remoção por rotinas de limpeza
    // e mantém a proteção mesmo fora do ciclo atual do processo.
    await painel.pin().catch(error=>console.warn("Não foi possível fixar o painel de migração; ele continua preservado contra a limpeza automática:",error.message));

    await message.delete().catch(() => {});
  } catch (error) {
    console.error("Erro ao enviar painel:", error);
    await responderCanalV2(
      message,
      containerAviso(
        "# Erro ao enviar painel",
        "Erro ao enviar o painel.",
        COR_ERRO
      )
    );
  }
}

commands.register({
  name: "migracao", description: "Envia o painel de migração de cargos e ingresso no servidor.", category: "Migração",
  permissions: ["ManageGuild"], result: "Publica o painel original de migração no canal atual.",
  prefix: { trigger: "!migracao", exact: true, execute: comandoMigracao }
});

async function comandoConfigTickets(message){
  if(!message.guild||message.author.bot)return;
  const fresh=await message.guild.members.fetch({user:message.author.id,force:true}).catch(()=>null);
  if(!gestaoTickets.access(message.guild,fresh).admin)return responderSemPermissao(message);
  const configured=dados.ticketRoles[message.guild.id]||{support:[],migration:[]};
  const configRoles=dados.ticketConfigRoles[message.guild.id]||[];
  const storedClaimRoles=dados.ticketClaimRoles[message.guild.id]||{};
  const claimRoles=Array.isArray(storedClaimRoles)?{support:storedClaimRoles,migration:storedClaimRoles}:storedClaimRoles;
  const rolePicker=(system,label)=>new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
    .setCustomId(`ticket-config-role:${system}`).setPlaceholder(label).setMinValues(0).setMaxValues(25)
    .setDefaultRoles(...(configured[system]||[])));
  const container=new ContainerBuilder().setAccentColor(COR_TICKET)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("# Configuração de tickets e migração\nSelecione os cargos mencionados na abertura de cada sistema. Menções não concedem acesso. As equipes autorizadas a assumir são configuradas separadamente.\n\n**Suporte**"))
    .addActionRowComponents(rolePicker("support","Cargos mencionados nos tickets de suporte"))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent("**Migração**"))
    .addActionRowComponents(rolePicker("migration","Cargos mencionados nos tickets de migração"))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Metas por cargo:** ${Object.entries(dados.ticketGoalsByRole[message.guild.id]||{}).length?Object.entries(dados.ticketGoalsByRole[message.guild.id]).map(([id,goal])=>`<@&${id}>: ${goal}`).join(" · "):`Sem metas por cargo. Meta geral atual: ${Number(dados.ticketGoals[message.guild.id])||0}`}`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ticket-config-goal").setLabel("Configurar meta por cargo").setStyle(ButtonStyle.Primary)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Cargo autorizado a configurar a meta:** ${configRoles.length?configRoles.map(id=>`<@&${id}>`).join(", "):"Somente administradores"}`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("ticket-config-authorized-role").setPlaceholder("Cargo que pode configurar a meta").setMinValues(0).setMaxValues(1).setDefaultRoles(...configRoles)))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Quem pode assumir**\nSuporte: ${(claimRoles.support||[]).length?(claimRoles.support||[]).map(id=>`<@&${id}>`).join(", "):"somente gestão autorizada"}\nMigração: ${(claimRoles.migration||[]).length?(claimRoles.migration||[]).map(id=>`<@&${id}>`).join(", "):"somente gestão autorizada"}\nOs sistemas podem ter cargos diferentes; seleção vazia permite somente a gestão da área e administração geral.`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket-config-claim-open:support").setLabel("Cargos para assumir suporte").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket-config-claim-open:migration").setLabel("Cargos para assumir migração").setStyle(ButtonStyle.Secondary)))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('tg:config').setLabel('Gestão, permissões e logs por área').setStyle(ButtonStyle.Primary)));
  try{const panel=await message.channel.send({components:[container],flags:FLAGS_V2,allowedMentions:{parse:[]}});commands.preserveMessage(panel);}
  catch(error){console.error("Erro ao publicar configuração de tickets:",error);}
}
commands.register({name:"ticketconfig",description:"Configura cargos de acesso para tickets e migração.",category:"Administração",authorize:member=>Boolean(member?.guild&&gestaoTickets.access(member.guild,member).admin),permissionLabel:"Proprietário ou Administração Geral de Tickets",result:"Publica o painel de cargos de tickets e migração.",prefix:{trigger:"!ticketconfig",exact:true,execute:comandoConfigTickets}});

async function comandoTicketStats(message){
  if(!message.guild||message.author.bot)return;
  const fresh=await message.guild.members.fetch({user:message.author.id,force:true}).catch(()=>null),scope=gestaoTickets.access(message.guild,fresh);
  if(!scope.support&&!scope.migration)return responderSemPermissao(message);
  const guildId=message.guild.id,alvo=message.mentions.users.first();
  let body="";
  if(alvo){
    const member=await message.guild.members.fetch(alvo.id).catch(()=>null);
    const systems=[ ["support","Suporte"],["migration","Migração"] ].filter(([key])=>scope[key]);
    body=`# Metas de tickets\n-# Semana atual · horário de Brasília\n**Atendente:** <@${alvo.id}>`;
    for(const [key,label] of systems){const count=gestaoTickets.team.counts(guildId,key).get(alvo.id)||0,goal=member?gestaoTickets.team.memberGoal(message.guild,key,member):0;body+=`\n**${label}:** ${count}${goal?` / ${goal} (faltam ${Math.max(0,goal-count)})`:" atendidos; sem meta configurada"}`;}
  }else{
    const configured=gestaoTickets.config(guildId),members=await require('./ticket-management/members').memberDirectory(client).get(message.guild);
    const sections=[];
    for(const [key,label] of [["support","SUPORTE"],["migration","MIGRAÇÃO"]]){
      if(!scope[key])continue;
      const roleIds=[...new Set(configured[`${key}Team`]||[])];
      const attendants=[...members.values()].filter(member=>!member.user.bot&&roleIds.some(id=>member.roles.cache.has(id)));
      if(!roleIds.length){sections.push(`## ${label}\n_Nenhum cargo autorizado configurado no painel._`);continue;}
      const totals=gestaoTickets.team.counts(guildId,key);
      const lines=attendants.map(member=>{
        const count=totals.get(member.id)||0;
        const goal=gestaoTickets.team.memberGoal(message.guild,key,member);
        return `• <@${member.id}> — **${count}**${goal?` / **${goal}** (faltam ${Math.max(0,goal-count)})`:" atendidos; sem meta"}`;
      });
      sections.push(`## ${label}\n${attendants.length?lines.slice(0,80).join("\n")+(lines.length>80?`\n_+ ${lines.length-80} atendentes não exibidos._`:""):"_Nenhum membro encontrado nos cargos autorizados._"}`);
    }
    body=`# Metas e atendimentos por cargo\n-# Semana atual · horário de Brasília\n${sections.join("\n\n")}`;
    if(body.length>3800)body=body.slice(0,3780)+"\n…\n_Lista reduzida por limite de exibição. Consulte um membro com `!ticketstats @membro`._";
  }
  const reply=await message.reply({components:[new ContainerBuilder().setAccentColor(COR_TICKET)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))],flags:FLAGS_V2,allowedMentions:{parse:[]}});
  commands.preserveMessage(reply);
}
commands.register({name:"ticketstats",description:"Consulta metas e tickets concluídos na semana atual.",category:"Suporte",authorize:member=>Boolean(member?.guild&&(gestaoTickets.access(member.guild,member).support||gestaoTickets.access(member.guild,member).migration)),permissionLabel:"Gestão de Tickets da área autorizada",result:"Mostra metas e atendimentos semanais por membro.",prefix:{trigger:"!ticketstats",exact:false,usage:["!ticketstats","!ticketstats @membro"],execute:comandoTicketStats}});

client.on("interactionCreate",async interaction=>{
  if(interaction.inGuild?.()&&interaction.customId?.startsWith('ticket-config-')&&
    !['ticket-config-goal','ticket-config-goal-role'].includes(interaction.customId)&&!interaction.customId.startsWith('ticket-config-goal-modal:')){
    const fresh=await interaction.guild.members.fetch({user:interaction.user.id,force:true}).catch(()=>null);
    if(!gestaoTickets.access(interaction.guild,fresh).admin)return responderSemPermissao(interaction);
  }
  if(interaction.inGuild?.()&&interaction.isButton?.()&&interaction.customId.startsWith("ticket-config-claim-open:")){
    const system=interaction.customId.split(":")[1];if(!["support","migration"].includes(system))return;
    const stored=dados.ticketClaimRoles[interaction.guildId];
    const current=Array.isArray(stored)?stored:(stored?.[system]||[]);
     const select=new RoleSelectMenuBuilder().setCustomId(`ticket-config-claim-roles:${system}`).setPlaceholder(`Cargos que podem assumir ${system==="support"?"suporte":"migração"}`).setMinValues(0).setMaxValues(25).setDefaultRoles(...current);
    return interaction.reply({components:[new ContainerBuilder().setAccentColor(COR_TICKET).addTextDisplayComponents(new TextDisplayBuilder().setContent(`# Cargos para assumir ${system==="support"?"suporte":"migração"}\nSelecione os cargos autorizados. Limpar a seleção restringe o atendimento à gestão da área e administração geral.`)).addActionRowComponents(new ActionRowBuilder().addComponents(select))],flags:FLAGS_EFEMERO_V2,allowedMentions:{parse:[]}});
  }
  if(interaction.inGuild?.()&&interaction.isButton?.()&&interaction.customId==="ticket-config-goal"){
    const canConfigure=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||
      (dados.ticketConfigRoles[interaction.guildId]||[]).some(id=>interaction.member?.roles?.cache?.has(id));
    if(!canConfigure)return interaction.reply({content:"Você não tem o cargo autorizado a configurar a meta de tickets.",flags:MessageFlags.Ephemeral});
    const selector=new RoleSelectMenuBuilder().setCustomId("ticket-config-goal-role").setPlaceholder("Escolha até 5 cargos").setMinValues(1).setMaxValues(5);
    return interaction.reply({components:[new ContainerBuilder().setAccentColor(COR_TICKET).addTextDisplayComponents(new TextDisplayBuilder().setContent("# Metas individuais por cargo\nEscolha até 5 cargos. O próximo formulário terá um campo de meta independente para cada cargo. Use 0 para remover a meta daquele cargo.")).addActionRowComponents(new ActionRowBuilder().addComponents(selector))],flags:FLAGS_EFEMERO_V2,allowedMentions:{parse:[]}});
  }
  if(interaction.inGuild?.()&&interaction.isModalSubmit?.()&&interaction.customId.startsWith("ticket-config-goal-modal:")){
    const canConfigure=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||
      (dados.ticketConfigRoles[interaction.guildId]||[]).some(id=>interaction.member?.roles?.cache?.has(id));
    if(!canConfigure)return interaction.reply({content:"Você não tem o cargo autorizado a configurar a meta de tickets.",flags:MessageFlags.Ephemeral});
    const token=interaction.customId.split(":")[1],selection=selecoesMetaCargo.get(token);
        if(!selection||selection.guildId!==interaction.guildId||selection.userId!==interaction.user.id||Date.now()-selection.createdAt>10*60*1000){selecoesMetaCargo.delete(token);return interaction.reply({content:errorText("A seleção de cargos expirou. Abra novamente o painel de metas."),flags:MessageFlags.Ephemeral});}
    selecoesMetaCargo.delete(token);
    const roles=[];for(const id of selection.roleIds){const role=await interaction.guild.roles.fetch(id).catch(()=>null);if(role&&role.id!==interaction.guildId&&!role.managed)roles.push(role);}
    if(!roles.length)return interaction.reply({content:"Nenhum cargo selecionado continua válido.",flags:MessageFlags.Ephemeral});
    const updates=[];
    for(let index=0;index<roles.length;index++){
      const role=roles[index];
      const raw=interaction.fields.getTextInputValue(`goal-${index}`).trim();
      if(!/^\d{1,5}$/.test(raw)||Number(raw)>10000)return interaction.reply({content:`Informe uma meta inteira entre 0 e 10000 para o cargo ${roles[index].name}.`,flags:MessageFlags.Ephemeral});
      updates.push({role,goal:Number(raw)});
    }
    dados.ticketGoalsByRole[interaction.guildId]??={};
    for(const {role,goal} of updates){if(goal===0)delete dados.ticketGoalsByRole[interaction.guildId][role.id];else dados.ticketGoalsByRole[interaction.guildId][role.id]=goal;}
    const summary=updates.map(({role,goal})=>`${role.name}: ${goal||"sem meta"}`);
    salvarDados();return interaction.reply({content:`Metas atualizadas individualmente:\n${summary.join("\n")}`,flags:MessageFlags.Ephemeral});
  }
  if(!interaction.inGuild?.()||!interaction.isRoleSelectMenu?.())return;
  try{
    if(interaction.customId==="ticket-config-authorized-role"){
      const id=interaction.values[0]||null,role=id?await interaction.guild.roles.fetch(id).catch(()=>null):null;
      if(id&&(!role||role.id===interaction.guildId||role.managed))return interaction.reply({content:"Selecione um cargo comum deste servidor.",flags:MessageFlags.Ephemeral});
      dados.ticketConfigRoles[interaction.guildId]=id?[id]:[];salvarDados();
      return interaction.reply({content:id?`O cargo <@&${id}> agora pode configurar a meta de tickets.`:"Cargo removido. Somente administradores podem configurar a meta.",allowedMentions:{parse:[],roles:[]},flags:MessageFlags.Ephemeral});
    }
    if(interaction.customId==="ticket-config-goal-role"){
      const canConfigure=interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||(dados.ticketConfigRoles[interaction.guildId]||[]).some(id=>interaction.member?.roles?.cache?.has(id));
      if(!canConfigure)return interaction.reply({content:"Você não tem autorização para configurar metas de tickets.",flags:MessageFlags.Ephemeral});
      const roles=[];for(const roleId of interaction.values){const role=await interaction.guild.roles.fetch(roleId).catch(()=>null);if(role&&role.id!==interaction.guildId&&!role.managed)roles.push(role);}
      if(!roles.length)return interaction.reply({content:"Selecione ao menos um cargo comum deste servidor.",flags:MessageFlags.Ephemeral});
      const token=randomUUID();selecoesMetaCargo.set(token,{guildId:interaction.guildId,userId:interaction.user.id,roleIds:roles.map(role=>role.id),createdAt:Date.now()});
      while(selecoesMetaCargo.size>500)selecoesMetaCargo.delete(selecoesMetaCargo.keys().next().value);
      const modal=new ModalBuilder().setCustomId(`ticket-config-goal-modal:${token}`).setTitle("Metas individuais por cargo");
      roles.forEach((role,index)=>{
        const current=Number(dados.ticketGoalsByRole[interaction.guildId]?.[role.id])||0;
        const input=new TextInputBuilder().setCustomId(`goal-${index}`).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(5).setPlaceholder("Número de tickets; 0 remove").setValue(String(current));
        modal.addLabelComponents(new LabelBuilder().setLabel(role.name.slice(0,45)).setDescription("Meta individual por atendente. Use 0 para remover.").setTextInputComponent(input));
      });
      return interaction.showModal(modal);
    }
    if(interaction.customId.startsWith("ticket-config-claim-roles:")){
      const system=interaction.customId.split(":")[1];if(!["support","migration"].includes(system))return;
      const invalid=interaction.values.filter(id=>id===interaction.guildId||interaction.guild.roles.cache.get(id)?.managed);
      if(invalid.length)return interaction.reply({content:errorText("Selecione somente cargos comuns, não gerenciados pelo Discord."),flags:MessageFlags.Ephemeral});
      const previous=dados.ticketClaimRoles[interaction.guildId];
      const value=Array.isArray(previous)?{support:[...previous],migration:[...previous]}:{...(previous||{}),support:[...(previous?.support||[])],migration:[...(previous?.migration||[])]};
      value[system]=[...new Set(interaction.values)].slice(0,25);dados.ticketClaimRoles[interaction.guildId]=value;salvarDados();
      return interaction.reply({content:interaction.values.length?`Cargos autorizados a assumir tickets de ${system==="support"?"suporte":"migração"} atualizados.`:`Seleção limpa para ${system==="support"?"suporte":"migração"}; somente gestão autorizada pode assumir.`,flags:MessageFlags.Ephemeral});
    }
    if(!interaction.customId.startsWith("ticket-config-role:"))return;
    const system=interaction.customId.split(":")[1];if(!["support","migration"].includes(system))return;
    const invalid=interaction.values.filter(id=>id===interaction.guildId||interaction.guild.roles.cache.get(id)?.managed);
    if(invalid.length)return interaction.reply({content:errorText("Selecione somente cargos comuns, não gerenciados pelo Discord."),flags:MessageFlags.Ephemeral});
    dados.ticketRoles[interaction.guildId]??={support:[],migration:[]};
    dados.ticketRoles[interaction.guildId][system]=[...new Set(interaction.values)].slice(0,25);salvarDados();
    await interaction.reply({content:`Cargos de ${system==="support"?"suporte":"migração"} atualizados. Eles terão acesso aos próximos tópicos criados.`,flags:MessageFlags.Ephemeral});
  }catch(error){console.error("Erro ao salvar cargos de tickets:",error);if(!interaction.replied&&!interaction.deferred)await interaction.reply({content:errorText("Não foi possível salvar essa configuração."),flags:MessageFlags.Ephemeral}).catch(()=>{});}
});

// =====================================
// COMANDO !cargos
// =====================================

async function comandoCargos(message) {
  if (!message.guild || message.author.bot) return;

  const partes = message.content.trim().split(/\s+/);

  const auth=roleWhitelist.access(message.guild,message.member);
  if (!auth || auth.kind==="blocked") {
    const status=auth?.status;
    const detalhe=status==="suspended"?"Sua autorização está suspensa.":
      status==="expired"?"Sua autorização temporária expirou.":
      status==="revoked"?"Sua autorização foi revogada.":"Seu usuário não possui uma whitelist ativa para este painel.";
    return responderCanalV2(message,containerAviso("# Acesso ao painel de cargos negado",detalhe,COR_ERRO));
  }
  if(auth.kind==="whitelist"&&!auth.profile.add&&!auth.profile.remove)return responderCanalV2(message,containerAviso(
    "# Ações não configuradas","Sua whitelist precisa permitir adicionar e/ou remover cargos.",COR_ERRO
  ));

  let alvo = message.mentions.members.first();

  // Sem argumento, gerencia quem executou o comando. IDs inválidos continuam
  // retornando erro, em vez de selecionar o autor silenciosamente.
  if (!alvo && !partes[1]) alvo = message.member;

  if (!alvo && partes[1]) {
    const id = partes[1].replace(/[<@!>]/g, "");

    if (/^\d{17,20}$/.test(id)) {
      alvo = await message.guild.members
        .fetch(id)
        .catch(() => null);
    }
  }

  if (!alvo) {
    return responderCanalV2(
      message,
      containerAviso(
        "# Usuário não informado",
        "Use `!cargos @usuário` para abrir o gerenciamento de cargos.",
        COR_ERRO
      )
    );
  }

  await message.guild.roles.fetch().catch(() => {});
  await message.guild.members.fetchMe().catch(() => {});
  const erro = validarAlvo(message.guild, message.member, alvo);

  if (erro) {
    return responderCanalV2(message,containerAviso(
      "# Alvo não permitido",erro,COR_ERRO
    ));
  }

  await message.guild.roles.fetch().catch(() => {});

  void garantirContagensCargos(message.guild).catch(error =>
    console.warn("Não foi possível carregar as contagens de cargos:", error.message));

  const id = randomUUID();

  dados.rolePanels[id] = {
    id,
    guildId: message.guild.id,
    staffId: message.author.id,
    targetId: alvo.id,
    filtro: "todos",
    page: 1,
    busca: "",
    criadoEm: Date.now()
  };

  salvarDados();

  const contagensPendentes = !contagemConfiavel(message.guild);
  const container = montarContainerCargos({
    estado: dados.rolePanels[id],
    guild: message.guild,
    autor: message.member,
    alvo
  });

  try {
    const mensagemPainel = await message.channel.send({
      components: [container],
      flags: FLAGS_V2,
      allowedMentions: { parse: [] }
    });

    dados.rolePanels[id].channelId = message.channel.id;
    dados.rolePanels[id].messageId = mensagemPainel.id;
    renovarPainelCargos(dados.rolePanels[id]);
    if (contagensPendentes) atualizarContagensQuandoProntas({
      estado:dados.rolePanels[id],guild:message.guild,autor:message.member,alvo,
      editar:payload=>mensagemPainel.edit(payload)
    });
  } catch (error) {
    console.error("Erro ao enviar painel de cargos:", error);
    delete dados.rolePanels[id];
    salvarDados();
  }
}

commands.register({
  name: "cargos", description: "Gerencia os cargos autorizados de um membro, com filtros, pesquisa e histórico.",
  category: "Gerenciamento de Cargos",
  result: "Abre o painel de cargos para o alvo; sem argumento, gerencia o próprio solicitante. Detecta os cargos do servidor e aplica a whitelist e a hierarquia do Discord.",
  examples: ["!cargos", "!cargo", "!cargos @usuário"],
  prefix: { trigger: "!cargos", aliases: ["!cargo"], usage: ["!cargos [@usuário ou ID]", "!cargo [@usuário ou ID]"], execute: comandoCargos }
});

// =====================================
// CRIAÇÃO DE TICKETS - SUPORTE
// =====================================

const aberturasSuporte = new Set();
async function abrirTicketSuporte(interaction) {
  if(gestaoTickets.handlesLegacy(interaction))return;
  if (!interaction.inGuild()) return;

  if (
    (interaction.isStringSelectMenu() && interaction.customId === "ticket-support") ||
    (interaction.isButton() && interaction.customId === "ticket-instagram")
  ) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    const openingKey = `${interaction.guildId}:${interaction.user.id}`;
    if (aberturasSuporte.has(openingKey)) {
      return editarErro(interaction, "Seu ticket já está sendo aberto. Aguarde um instante.", "# Abertura em andamento");
    }
    aberturasSuporte.add(openingKey);
    try {
      const tipo = interaction.customId === "ticket-instagram" ? "insta" : interaction.values[0];
      const categoria = tipos[tipo];

      if (!categoria) {
        return editarErro(
          interaction,
          "Opção inválida.",
          "# Opção inválida"
        );
      }

      const existente = await localizarTicketAberto(interaction.guild, "support", interaction.user.id, tipo);

      if (existente) {
        return editarRespostaV2(
          interaction,
          containerAviso(
            "# Ticket já aberto",
            `Você já possui um ticket aberto: ${existente}`,
            COR_TICKET
          )
        );
      }

      const canal = await criarTopicoTicket(interaction, {
        sistema: "support", tipo, nome: tipo === "insta"
          ? `verificacao-insta-${interaction.user.username}`
          : `suporte-${categoria.confirmacao}-${interaction.user.username}`
      });
      try {
        const sent=await canal.send({
          components: [
            criarContainerTicket({
              guild: interaction.guild,
              canalId: canal.id,
              donoId: interaction.user.id,
              sistema: "support",
              tipo,
              cargosMarcados:dados.ticketRoles?.[interaction.guildId]?.support||[]
            })
          ],
          flags: FLAGS_V2,
          allowedMentions: {users:[interaction.user.id],roles:dados.ticketRoles?.[interaction.guildId]?.support||[],parse:[]}
        });
        commands.preserveMessage(sent);
        dados.tickets[canal.id].messageId=sent.id;salvarDados();gestaoTickets.sync(canal.id);
      } catch (error) {
        await descartarTicketIncompleto(canal);
        throw error;
      }

      await editarRespostaV2(
        interaction,
        criarContainerConfirmacao(
          `Seu ticket de ${categoria.confirmacao} foi criado: ${canal}`
        ),
        { users: [interaction.user.id], parse: [] }
      );
    } catch (error) {
      console.error("Erro ao criar ticket:", error);

      await editarErro(
        interaction,
        "Não foi possível criar seu ticket. Verifique as permissões e configurações do bot.",
        "# Erro ao criar ticket"
      ).catch(() => {});
    } finally {
      aberturasSuporte.delete(openingKey);
    }
  }
}
client.on("interactionCreate", abrirTicketSuporte);

// =====================================
// CRIAÇÃO DE TICKETS - MIGRAÇÃO
// =====================================

client.on("interactionCreate", async interaction => {
  if (!interaction.inGuild()) return;

  if (
    interaction.isButton() &&
    interaction.customId === "ticket-migration"
  ) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    try {
      const existente = await localizarTicketAberto(interaction.guild, "migration", interaction.user.id);

      if (existente) {
        return editarRespostaV2(
          interaction,
          containerAviso(
            "# Solicitação já aberta",
            `Você já possui uma solicitação aberta: ${existente}`,
            COR_TICKET
          )
        );
      }

      const canal = await criarTopicoTicket(interaction, {
        sistema: "migration", tipo: "migration", nome: `migracao-${interaction.user.username}`
      });
      try {
        const sent=await canal.send({
          components: [
            criarContainerTicket({
              guild: interaction.guild,
              canalId: canal.id,
              donoId: interaction.user.id,
              sistema: "migration",
              tipo: "migration",
              cargosMarcados:dados.ticketRoles?.[interaction.guildId]?.migration||[]
            })
          ],
          flags: FLAGS_V2,
          allowedMentions: {users:[interaction.user.id],roles:dados.ticketRoles?.[interaction.guildId]?.migration||[],parse:[]}
        });
        commands.preserveMessage(sent);
        dados.tickets[canal.id].messageId=sent.id;salvarDados();gestaoTickets.sync(canal.id);
      } catch (error) {
        await descartarTicketIncompleto(canal);
        throw error;
      }

      await editarRespostaV2(
        interaction,
        criarContainerConfirmacao(
          `Seu ticket de migração foi criado: ${canal}`
        ),
        { users: [interaction.user.id], parse: [] }
      );
    } catch (error) {
      console.error("Erro ao criar ticket:", error);

      await editarErro(
        interaction,
        "Não foi possível abrir a solicitação. Verifique as configurações do bot.",
        "# Erro ao criar ticket"
      ).catch(() => {});
    }
  }
});

// =====================================
// FECHAMENTO - SUPORTE
// =====================================

client.on("interactionCreate", async interaction => {
  if(gestaoTickets.handlesLegacy(interaction))return;
  if (!interaction.inGuild()) return;

  if (
    !interaction.isButton() ||
    interaction.customId !== "ticket-close"
  ) return;

  const canal = interaction.channel;
  const info = obterInfoTicket(canal);

  if (!info || info.sistema !== "support") {
    return responderErro(
      interaction,
      "Este canal não é um ticket de suporte.",
      "# Canal inválido"
    );
  }

  if (!await podeFecharTicket(interaction,info)) {
    return responderSemPermissao(interaction);
  }

  await iniciarEncerramento(interaction, canal);
});

// =====================================
// FECHAMENTO - MIGRAÇÃO
// =====================================

client.on("interactionCreate", async interaction => {
  if(gestaoTickets.handlesLegacy(interaction))return;
  if (!interaction.inGuild()) return;

  if (
    !interaction.isButton() ||
    interaction.customId !== "migration-close"
  ) return;

  const canal = interaction.channel;
  const info = obterInfoTicket(canal);

  if (!info || info.sistema !== "migration") {
    return responderErro(
      interaction,
      "Este canal não é um ticket de migração.",
      "# Canal inválido"
    );
  }

  if (!await podeFecharTicket(interaction,info)) {
    return responderSemPermissao(interaction);
  }

  await iniciarEncerramento(interaction, canal);
});

// =====================================
// CONTROLES DOS TICKETS
// =====================================

client.on("interactionCreate", async interaction => {
  if(gestaoTickets.handlesLegacy(interaction))return;
  if (!interaction.inGuild()) return;

  // -------------------------------------
  // Assumir ticket
  // -------------------------------------

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("ticket-claim:")
  ) {
    const canalId = interaction.customId.split(":")[1];

    if (canalId !== interaction.channelId) {
      return responderErro(
        interaction,
        "Este controle não pertence a este ticket.",
        "# Controle inválido"
      );
    }

    const info = obterInfoTicket(interaction.channel);

    if (!info) {
      return responderErro(
        interaction,
        "Este canal não é um ticket.",
        "# Canal inválido"
      );
    }

    const membroClaim=await interaction.guild.members.fetch(interaction.user.id).catch(()=>interaction.member);
    if (!podeAssumirTicket(membroClaim,interaction.guildId,info.sistema)) {
      return responderSemPermissao(interaction);
    }

    if (dados.claims[canalId] || mensagemMostraAssumido(interaction.message)) {
      const userId = dados.claims[canalId]?.userId;

      return responderErro(
        interaction,
        userId
          ? `Este ticket já foi assumido por <@${userId}>.`
          : "Este ticket já foi assumido.",
        "# Ticket já assumido"
      );
    }

    if (claimsEmAndamento.has(canalId)) {
      return responderErro(
        interaction,
        "Este ticket já está sendo assumido. Aguarde um instante.",
        "# Atendimento em andamento"
      );
    }

    claimsEmAndamento.add(canalId);

    try {
      await interaction.deferUpdate();

      dados.claims[canalId] = {
        userId: interaction.user.id,
        at: Date.now()
      };

      salvarDados();

      const meta = dados.tickets[canalId] || {};
      const sistema = meta.sistema || info.sistema;
      const donoId = meta.donoId || info.donoId;

      const container = criarContainerTicket({
        guild: interaction.guild,
        canalId,
        donoId,
        sistema,
        tipo: meta.tipo,
        assumidoPor: interaction.user.id,
        ticketAtendidos:Number(dados.ticketStats[interaction.guildId]?.[interaction.user.id])||0,
        ticketMeta:metaTicketDoMembro(interaction.guildId,interaction.member)
      });

      await interaction.editReply({
        components: [container],
        flags: FLAGS_V2,
        allowedMentions: {
          // Set: o Discord rejeita IDs repetidos em allowed_mentions.users.
          users: [
            ...new Set(
              [interaction.user.id, donoId].filter(Boolean)
            )
          ],
          parse: []
        }
      });
    } catch (error) {
      console.error("Erro ao assumir ticket:", error);

      delete dados.claims[canalId];
      salvarDados();

      await interaction.followUp({
        components: [
          containerAviso(
            "# Erro ao assumir",
            "Não foi possível assumir o ticket. Tente novamente.",
            COR_ERRO
          )
        ],
        flags: FLAGS_EFEMERO_V2,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    } finally {
      claimsEmAndamento.delete(canalId);
    }
  }

  // -------------------------------------
  // Abrir seletor de usuários
  // -------------------------------------

  if (
    interaction.isButton() &&
    interaction.customId.startsWith("ticket-users:")
  ) {
    const canalId = interaction.customId.split(":")[1];

    if (canalId !== interaction.channelId) {
      return responderErro(
        interaction,
        "Este controle não pertence a este ticket.",
        "# Controle inválido"
      );
    }

    const info = obterInfoTicket(interaction.channel);

    if (!info) {
      return responderErro(
        interaction,
        "Este canal não é um ticket.",
        "# Canal inválido"
      );
    }

    const autorizado =
      interaction.user.id === info.donoId ||
      membroDaEquipe(interaction.member);

    if (!autorizado) {
      return responderSemPermissao(interaction);
    }

    const menu = new UserSelectMenuBuilder()
      .setCustomId(`ticket-users-select:${canalId}`)
      .setPlaceholder("Selecione os usuários")
      .setMinValues(1)
      .setMaxValues(10);

    const container = new ContainerBuilder()
      .setAccentColor(COR_TICKET)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "# Adicionar/Remover Usuário"
        )
      )
      .addSeparatorComponents(separador())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "Selecione os usuários que deseja adicionar ou remover do ticket.\n" +
          "-# Usuários que já têm acesso serão removidos; os demais serão adicionados."
        )
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(menu)
      );

    return responderV2(interaction, container);
  }

  // -------------------------------------
  // Aplicar adição / remoção
  // -------------------------------------

  if (
    interaction.isUserSelectMenu() &&
    interaction.customId.startsWith("ticket-users-select:")
  ) {
    const canalId = interaction.customId.split(":")[1];

    if (canalId !== interaction.channelId) {
      return responderErro(
        interaction,
        "Este controle não pertence a este ticket.",
        "# Controle inválido"
      );
    }

    const info = obterInfoTicket(interaction.channel);

    if (!info) {
      return responderErro(
        interaction,
        "Este canal não é um ticket.",
        "# Canal inválido"
      );
    }

    const autorizado =
      interaction.user.id === info.donoId ||
      membroDaEquipe(interaction.member);

    if (!autorizado) {
      return responderSemPermissao(interaction);
    }

    if (usuariosEmOperacao.has(canalId)) {
      return responderErro(
        interaction,
        "Já existe uma atualização de usuários em andamento.",
        "# Operação em andamento"
      );
    }

    usuariosEmOperacao.add(canalId);

    await interaction.deferUpdate();

    try {
      const canal = interaction.channel;
      const adicionados = [];
      const removidos = [];
      const ignorados = [];

      for (const userId of interaction.values) {
        const mencao = `<@${userId}>`;

        if (userId === info.donoId) {
          ignorados.push(`${mencao} (proprietário do ticket)`);
          continue;
        }

        if (userId === client.user.id) {
          ignorados.push(`${mencao} (bot)`);
          continue;
        }

        const membro = await interaction.guild.members
          .fetch(userId)
          .catch(() => null);

        if (!membro) {
          ignorados.push(`${mencao} (não está no servidor)`);
          continue;
        }

        if (membroDaEquipe(membro)) {
          ignorados.push(`${mencao} (já faz parte da equipe)`);
          continue;
        }

        const thread = canal.isThread?.();
        const participante = thread
          ? await canal.members.fetch({ member: userId }).then(() => true).catch(() => false)
          : false;

        if (participante) {
          await canal.members.remove(userId, `Removido do ticket por ${interaction.user.tag}`);
          removidos.push(mencao);
        } else if (thread) {
          await canal.members.add(userId, `Adicionado ao ticket por ${interaction.user.tag}`);
          adicionados.push(mencao);
        } else {
          const permissao = canal.permissionOverwrites.cache.get(userId);
          const temAcesso = Boolean(permissao?.allow.has(PermissionFlagsBits.ViewChannel));
          if (temAcesso) {
            await canal.permissionOverwrites.delete(
              userId,
              `Removido do ticket por ${interaction.user.tag}`
            );
            removidos.push(mencao);
          } else {
            await canal.permissionOverwrites.edit(
              userId,
              { ViewChannel: true, SendMessages: true, ReadMessageHistory: true },
              { reason: `Adicionado ao ticket por ${interaction.user.tag}` }
            );
            adicionados.push(mencao);
          }
        }
      }

      const resumo = [];

      if (adicionados.length) {
        resumo.push(`**Adicionados:** ${adicionados.join(", ")}`);
      }

      if (removidos.length) {
        resumo.push(`**Removidos:** ${removidos.join(", ")}`);
      }

      if (ignorados.length) {
        resumo.push(`**Ignorados:** ${ignorados.join(", ")}`);
      }

      const container = containerAviso(
        "# Usuários atualizados",
        resumo.length
          ? resumo.join("\n")
          : "Nenhuma alteração foi necessária.",
        COR_SUCESSO
      );

      await interaction.editReply({
        components: [container],
        flags: FLAGS_V2,
        allowedMentions: { parse: [] }
      });
    } catch (error) {
      console.error("Erro ao gerenciar usuários do ticket:", error);

      await interaction.editReply({
        components: [
          containerAviso(
            "# Erro ao atualizar usuários",
            "Não foi possível atualizar os usuários do ticket. Verifique as permissões do bot.",
            COR_ERRO
          )
        ],
        flags: FLAGS_V2,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    } finally {
      usuariosEmOperacao.delete(canalId);
    }
  }
});

// =====================================
// CONTROLES DO PAINEL DE CARGOS
// =====================================

client.on("interactionCreate", async interaction => {
  if (!interaction.inGuild()) return;

  // -------------------------------------
  // Modal de pesquisa
  // -------------------------------------

  if (
    interaction.isModalSubmit() &&
    interaction.customId.startsWith("cargos:modal:")
  ) {
    const id = interaction.customId.split(":")[2];
    const estado = dados.rolePanels[id];

    if (!estado || estado.guildId !== interaction.guildId) {
      return responderErro(
        interaction,
        "Este painel expirou. Use `!cargos` novamente.",
        "# Painel expirado"
      );
    }

    if (estado.staffId !== interaction.user.id) {
      return responderSemPermissao(interaction);
    }

    const modalAuth=roleWhitelist.access(interaction.guild,interaction.member);
    if(!modalAuth||modalAuth.kind==="blocked")return responderSemPermissao(interaction);

    renovarPainelCargos(estado);

    estado.busca = interaction.fields
      .getTextInputValue("busca")
      .trim();

    estado.page = 1;
    salvarDados();

    await interaction.deferUpdate();
    await atualizarPainelCargos(interaction, estado);

    return;
  }

  // -------------------------------------
  // Botões do painel
  // -------------------------------------

  if (
    !(interaction.isButton() || (interaction.isStringSelectMenu?.() && interaction.customId.startsWith("cargos:aba:"))) ||
    !interaction.customId.startsWith("cargos:")
  ) return;

  const partes = interaction.customId.split(":");
  const acao = partes[1];
  const id = partes[2];
  const estado = dados.rolePanels[id];

  if (!estado || estado.guildId !== interaction.guildId) {
    return responderErro(
      interaction,
      "Este painel expirou. Use `!cargos` novamente.",
      "# Painel expirado"
    );
  }

  if (estado.staffId !== interaction.user.id) {
    return responderSemPermissao(interaction);
  }

  const authExecutor=roleWhitelist.access(interaction.guild,interaction.member);
  if (!authExecutor || authExecutor.kind==="blocked") {
    return responderSemPermissao(interaction);
  }

  renovarPainelCargos(estado);

  if (acao === "historico") {
    if ((authExecutor.kind==="whitelist"&&!authExecutor.profile.viewHistory) ||
        (authExecutor.kind==="native"&&!fichaCargos.autorizado(interaction.member))) {
      return responderSemPermissao(interaction);
    }
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await fichaCargos.abrir(interaction, estado.targetId, true, estado.id);
    } catch (error) {
      await fichaCargos.erro(interaction, error);
    }
    return;
  }

  if (acao === "buscar") {
    return interaction.showModal(
      criarModalBusca(id, estado.busca)
    ).catch(() => {});
  }

  if (acao === "pageinfo") {
    await interaction.deferUpdate();
    return atualizarPainelCargos(interaction, estado);
  }

  if (
    acao !== "filtro" &&
    acao !== "pagina" &&
    acao !== "aba" &&
    acao !== "role"
  ) {
    return responderErro(
      interaction,
      "Esta ação não é reconhecida por este painel.",
      "# Ação inválida"
    );
  }

  if (acao === "role" && paineisEmOperacao.has(id)) {
    return responderErro(
      interaction,
      "Já existe uma operação em andamento neste painel.",
      "# Operação em andamento"
    );
  }

  if (acao === "role") {
    paineisEmOperacao.add(id);
    // Uma carga antiga não pode redesenhar o alvo durante a próxima alteração.
    revisoesPainelCargos.set(estado,(revisoesPainelCargos.get(estado)||0)+1);
  }

  try {
    await interaction.deferUpdate();
    let alvoAtualizado = null;

    if (acao === "filtro") {
      const valor = partes[3];

      if (FILTROS_CARGOS.includes(valor)) {
        estado.filtro = valor;
        estado.page = 1;
      }
    }

    if (acao === "pagina" || acao === "aba") {
      const pagina = Number(acao === "aba" ? interaction.values[0] : partes[3]);

      if (Number.isInteger(pagina) && pagina > 0) {
        estado.page = pagina;
      }
    }

    if (acao === "role") {
      const cargoId = partes[3];

      const alvo = await interaction.guild.members
        .fetch({ user: estado.targetId, force: true })
        .catch(() => null);

      const erroAlvo = validarAlvo(
        interaction.guild,
        interaction.member,
        alvo
      );

      if (erroAlvo) {
        if (alvo) return await responderSemPermissao(interaction);

        return interaction.followUp({
          components: [
            containerAviso("# Não foi possível", erroAlvo, COR_ERRO)
          ],
          flags: FLAGS_EFEMERO_V2,
          allowedMentions: { parse: [] }
        });
      }

      const cargo =
        interaction.guild.roles.cache.get(cargoId) ||
        await interaction.guild.roles
          .fetch(cargoId)
          .catch(() => null);

      if (!cargoPermitido(interaction.guild, interaction.member, cargo, alvo)) {
        return await responderSemPermissao(interaction);
      }

      const possui = alvo.roles.cache.has(cargo.id);

      alvoAtualizado = await fichaCargos.alterarCargo({
        guild: interaction.guild, alvo, cargo,
        action: possui ? "remove" : "add", autor: interaction.user,
        executar: motivo => possui
          ? alvo.roles.remove(cargo, motivo)
          : alvo.roles.add(cargo, motivo)
      });

      try {
        // O RoleManager retorna o membro com o cargo aplicado após o sucesso
        // da API. Reutilizá-lo evita outra consulta REST antes de redesenhar.
        // O retrato continua impedindo dupla contagem quando chegar o Gateway.
        atualizarContagemMembro(alvoAtualizado);
        if (!possui) {
          const aplicado = roleWhitelist.applyRolePreset(
            interaction.guild, estado.targetId, cargo.id, interaction.user.id
          );
          if (aplicado) console.log(`[Whitelist de cargos] Preset aplicado a ${estado.targetId} pelo cargo ${cargo.id}.`);
        }
      } catch (error) {
        suspenderContagens(interaction.guild);
        console.warn("Não foi possível confirmar a contagem após alterar o cargo:", error.message);
      }
    }

    salvarDados();
    await atualizarPainelCargos(interaction, estado, alvoAtualizado);
  } catch (error) {
    console.error("Erro no painel de cargos:", error);

    await interaction.followUp({
      components: [
        containerAviso(
          "# Erro ao atualizar cargos",
          "Não foi possível concluir a operação. Verifique a hierarquia e as permissões do bot.",
          COR_ERRO
        )
      ],
      flags: FLAGS_EFEMERO_V2,
      allowedMentions: { parse: [] }
    }).catch(() => {});
  } finally {
    if (acao === "role") paineisEmOperacao.delete(id);
  }
});

// =====================================
// INICIALIZAÇÃO
// =====================================

// Mantém o data.json enxuto quando um canal de ticket é apagado manualmente.
client.on("channelDelete", canal => {
  if (
    dados.tickets[canal.id] ||
    dados.claims[canal.id] ||
    dados.pendingCloses[canal.id]
  ) {
    limparDadosTicket(canal.id);
    salvarDados();
  }
});

  client.once("clientReady", () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  let mostrandoServidores = false;
  const atualizarStatus = async () => {
    mostrandoServidores = !mostrandoServidores;
    // O valor inicial considera 13 servidores já existentes; novos servidores
    // entram na contagem conforme o bot recebe guildCreate.
    const quantidadeServidores =
      process.env.NODE_ENV === "test"
        ? client.guilds.cache.size
        : Math.max(13, client.guilds.cache.size);
    const quantidadeUsuarios = client.guilds.cache.reduce(
      (total, guild) => total + (guild.memberCount || 0),
      0
    );
    const rotulo = mostrandoServidores
      ? `${quantidadeServidores} ${quantidadeServidores === 1 ? "servidor" : "servidores"}`
      : `${quantidadeUsuarios} ${quantidadeUsuarios === 1 ? "usuário" : "usuários"}`;
    try {
      await client.user.setPresence({
        status: "idle",
        activities: []
      });
    } catch (error) {
      console.error("[Status] Não foi possível atualizar a presença:", error.message);
    }
  };
  if (typeof setInterval === "function") {
    const intervaloStatus = setInterval(() => void atualizarStatus(), 30_000);
    intervaloStatus?.unref?.();
  }
  void atualizarStatus();
  podarPaineisAntigos();
  recuperarExpiracoesPaineisCargos();
  recuperarFechamentosPendentes();
});

const configuracaoLumiya=require("./configuration")({
  client,commands,db:horasCall.store.db,
  apis:{nickname:nicknameSystem,whitelist:roleWhitelist,tickets:gestaoTickets,up:upSystem,
    initialRole:initialRoleSystem,autoCalls:autoCallsSystem,games:gamesSystem,media:protecaoMidia,
    instagram:protecaoMidia.instagram,ai:aiChatSystem,rankings:rankingsSystem,
    backups:backupsServidor,logs:serverLogs,bans:bansSystem},
  definitions:[
    ...["support","migration"].map(id=>({id,label:id==="support"?"Suporte e tickets":"Migração e ingresso",category:"Tickets",
      beforePublish:async(ctx,channel)=>ticketThreadAccess.grantStaffRoleAccess(channel,id),
      render:async ctx=>{const p=await painelComArte(id,ctx.guild);return {components:[p.component],files:p.files};}})),
    {id:"hall",label:"Diretrizes e boas-vindas",category:"Boas-vindas",render:ctx=>({components:[criarPainelHall(ctx.guild)]})},
    {id:"unmute",label:"Desmutar",category:"Moderação",render:ctx=>painelUnmute.panel(ctx.guild)},
    {id:"games",label:"Cargos de jogos",category:"Cargos",validate:ctx=>gamesSystem.validatePanel(ctx.guild),render:ctx=>({components:[gamesSystem.panel(ctx.guild)]})},
    {id:"up",label:"Progressão de cargos",category:"Cargos",render:ctx=>({components:[upSystem.publicPanel(ctx.guild)]})},
    {id:"instagram-ticket",label:"Tickets de verificação",category:"Instagram",render:ctx=>require("./instagram/ticket-panel").ticketPanel(ctx.guild)},
    {id:"instagram-media",label:"Instruções de envio",category:"Instagram",
      validate:(ctx,channel)=>{if(!protecaoMidia.instagram.isIntake(ctx.guild.id,channel.id))throw new Error("Configure este canal como origem de envios na categoria Instagram antes de publicar as instruções.");},
      render:ctx=>require("./instagram/media-panel").mediaPanel(ctx.guild)},
    {id:"instagram-entry",label:"Acesso à verificação",category:"Instagram",render:ctx=>protecaoMidia.instagram.entryPanel(ctx.guild)},
    {id:"rankings",label:"Rankings de atividade",category:"Rankings",render:ctx=>rankingsSystem.panel(ctx.guild)},
    {id:"ban-home",label:"Central de banimentos",category:"Moderação",render:ctx=>bansSystem.home(ctx.guild)},
    {id:"nickname-entry",label:"Acesso à proteção de nomes",category:"Segurança",render:ctx=>({components:[nicknameSystem.entryPanel(ctx.guild)]})},
    {id:"media-review-entry",label:"Acesso à revisão de mídias",category:"Moderação",render:ctx=>({components:[protecaoMidia.reviewEntry(ctx.guild)]})},
    {id:"command-center",label:"Central de comandos",category:"Geral",render:ctx=>{
      const session=centralComandos.store.session({id:randomUUID(),guildId:ctx.guild.id,userId:ctx.user?.id||client.user.id,permanent:true,view:"home",category:null,query:"",page:1,group:0,detail:null,hasMessage:true});
      return {components:[centralComandos.render(session,null,ctx.guild)]};
    }}
  ]
});
horasCall.beforeShutdown(()=>configuracaoLumiya.close());
commands.loadDirectory(path.join(__dirname, "commands"), { horasCall, fichaCargos });

client.login(process.env.DISCORD_TOKEN).catch(error => anticrash.loginFailure(error));
