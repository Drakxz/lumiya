# Central Lumiya

## Inventário e integração

O ponto de composição é `index.js`; o cliente é único, supervisionado por
`start.js`. Comandos, aliases, permissões e sincronização slash pertencem a
`command-system/registry.js`. O SQLite compartilhado é `horasCall.store.db`
(`database/call-stats.sqlite`, WAL). `data.json` preserva tickets legados.

Sistemas existentes examinados: tickets/áreas/equipe/metas e acesso a threads;
histórico, whitelist, presets e proteção de cargos; cargo inicial; jogos;
UP/bio/manutenção; horas de voz e rankings; apelidos/IA/avisos; moderação de
mídia/revisão/escopo/remapeamento; Instagram/verificação/tickets/envios/portal
web; banimentos/limites; logs/boosts; backups/restauração; calls automáticas,
presença e painel privado de contas; chat IA; clear/nuke; anticrash.

Não há um Anti-Raid autônomo: a central não anuncia esse sistema. Credenciais,
painel de contas e configuração global de provedores não são expostos a
administradores de servidores. O portal web e suas sessões não são duplicados.

As configurações funcionais continuam nos módulos/tabelas originais.
Os adaptadores da central abrem os fluxos reais, sem copiar suas regras.
`panel-art/appearance.js`, os renderizadores públicos e o registro de comandos
são os pontos de extensão da personalização. Não se alteram custom IDs ou
valores funcionais das opções.

## Direção da superfície

Modo: operação nativa no Discord. Identidade existente preservada por padrão;
central e onboarding em lilás `#C4A7E7`, separadores pequenos, tipografia nativa,
uma tarefa por tela. Os três emojis da Lumiya têm fallback Unicode.
Onboarding apresenta o bot; central mostra estado real e conduz aos módulos;
editor mostra rascunho, prévia privada e publicação explícita.

Entradas: `/config` e `guildCreate`. Nenhum convite ou anúncio de comunidade
no onboarding. Sem coletores permanentes, sem uma segunda conexão de bot.
Permissão é consultada novamente em cada interação. Rascunhos persistem com
revisão otimista; publicação e exclusão são operações explícitas e auditadas.

As imagens personalizadas são sanitizadas e guardadas no SQLite, não apenas
em URLs temporárias. Prévia e publicação compartilham o mesmo renderizador;
controles da prévia ficam desativados. Padrões anteriores do mds, inclusive
ausência de imagens, continuam válidos até personalização explícita.

## Uso

- `/config`: abre a central privada. `!config` publica apenas um botão de acesso.
- **Personalização**: escolhe entre os renderizadores públicos registrados,
  edita um rascunho persistente, faz a prévia e salva a configuração.
- **Atualizar publicados**: edita mensagens existentes, individualmente ou em
  lotes de até 25. Não cria cópias quando uma atualização falha.
- **Publicar**: escolhe um canal de texto; usa a versão salva, não o rascunho.
- **Vincular existente**: importa uma mensagem reconhecida da própria Lumiya,
  validando canal, autoria e servidor, sem modificar a mensagem.
- **Excluir** exige confirmação. **Republicar** permite selecionar outro
  canal quando o destino anterior foi removido.
- **Boas-vindas**: recepção de membros opt-in; não substitui o cargo inicial.
- **Configurações gerais**: só o proprietário pode delegar acesso à central.
  Delegação não concede permissões de moderação, acesso a canais ocultos,
  nem substitui a autorização própria dos módulos.

### Templates públicos

Suporte, migração, diretrizes, desmutar, cargos de jogos, UP, acesso à
verificação do Instagram, tickets de verificação, instruções de envio,
rankings, banimentos, acesso à proteção de nomes, acesso à revisão de mídia,
central de comandos, onboarding e recepção de membros.

Painéis individuais de atendimentos, punições, posts de membros e resultados
de ações não se tornam templates genéricos: isso preserva os IDs, estados,
avisos de segurança e permissões essenciais de cada fluxo.

### Imagens

Oito posições/recursos independentes: banner superior, imagem principal,
banner inferior, thumbnail, avatar do servidor, avatar da Lumiya, banner do
servidor e ícone. Cada recurso pode usar o padrão, ficar oculto, usar recursos
atuais do Discord ou uma imagem armazenada.

URLs precisam ser HTTPS públicas. O download valida todas as respostas DNS,
fixa o IP utilizado na conexão TLS, valida redirecionamentos e limita tamanho
e tempo. PNG, JPEG, WebP e GIF são decodificados com limite de pixels,
normalizados para PNG e armazenados em BLOB; GIF personalizado é estático.
Até 5 MB por arquivo, 30 MB por servidor e uma conversão simultânea.
O botão de limpeza remove apenas imagens sem referência em configurações
salvas ou rascunhos daquele servidor.

Arquivos são anexados novamente em cada renderização. Não existe endpoint
público novo nem leitura de anexos fora do upload autorizado pelo administrador.
Não há dependência de URL temporária após o armazenamento. Não são alteradas
fotos reais do servidor ou da conta do bot.

## Gerenciamento de acesso

`configuration/access.js` é o serviço central de permissões do `/config`.
O dono do servidor tem acesso permanente e irrestrito. Administrador,
Gerenciar Servidor, Gerenciar Cargos e permissões de moderação (Gerenciar
Mensagens, Banir, Expulsar e Moderar Membros) concedem acesso automático ao
`/config` com nível de gerenciamento nas funcionalidades, mas nunca ao
gerenciamento do próprio sistema de acesso.
Isso também inclui a equipe com Gerenciar Canais, Gerenciar Tópicos,
Silenciar Membros, Ensurdecer Membros ou Mover Membros. Cargos sem essas
permissões precisam ser autorizados pelo dono em **Acesso**; nomes de cargos,
por si só, não concedem privilégios.

Acessos são concedidos por cargo ou por membro, com três níveis — sem acesso,
visualização e gerenciamento — por funcionalidade. As permissões efetivas
são a união dos vínculos diretos e de cargo, limitadas ao teto do sistema:
`access.manage` pertence somente ao dono. Concessões temporárias expiram
automaticamente mesmo após reinicialização, e a expiração é registrada no
histórico uma única vez.

O painel **Acesso** do `/config` usa o mesmo design system do restante da
central e exibe visão geral, acesso por cargo, acesso individual, permissões
específicas e histórico. Formulários nativos preenchem os valores atuais e
usam seletores de cargo e membro. Revogações pedem confirmação e invalidam
sessões abertas dos usuários afetados. Qualquer alteração é registrada e,
quando há canal de logs configurado, também é enviada para lá.

Todas as telas e ações do `/config` filtram funcionalidades pelas permissões
efetivas. Ocultar um botão nunca é a única proteção: a verificação é feita no
backend em cada interação, formulário e ação.

## Identidade visual 2026

`lumiya-ui/theme.js` é a fonte única de tokens, emojis, breadcrumbs,
containers, estados, navegação, modais, validação e mensagens de feedback.
A cor padrão dos painéis passou a ser `#C4A7E7`; servidores com cor
personalizada mantêm a própria configuração.

A central usa quatro destinos explícitos — Funções, Aparência, Templates e
Acesso — com busca, atualização, publicações e navegação de volta. Cada tela
administrativa é composta por containers separados: cabeçalho com breadcrumb
e thumbnail, estado do sistema, configurações e ações. Modais são preenchidos
com valores atuais e aceitam texto, selects e seletores nativos.

## Arquitetura e extensão

- `index.js`: composição, `/config`, eventos e importação dos registros legados.
- `store.js`: tabelas `lumiya_*` no SQLite compartilhado; migrações aditivas,
  isolamento por servidor, CAS de rascunhos/configurações e histórico.
- `runtime.js`: ponte leve para os renderizadores existentes, arquivos e
  contexto assíncrono por requisição. Sem patch global do Discord.js/REST.
- `panels.js` / `render.js`: registro e renderização única para publicação e
  prévia. Os identificadores internos e valores das opções nunca são editados.
- `systems.js`: descoberta pelo registro atual de comandos, adaptadores
  privados dos fluxos reais e exposição informativa de comandos operacionais.
- `controller.js` / `views.js` / `ui.js`: um listener da central, navegação
  persistente, formulários e Components V2; nenhum collector permanente.
- `assets.js`: transporte protegido e sanitização.
- `publisher.js`: permissões do ator e do bot, locks de publicação, edição,
  exclusão e republicação. Valida pré-requisitos de cada template.

Para adicionar um template: `hub.panels.register({id,label,category,render,
validate?,beforePublish?})`. `render(context)` retorna um payload V2 ou um
ContainerBuilder. `validate` não pode executar ações; `beforePublish` reutiliza
pré-requisitos do módulo antes do envio, como acesso da equipe aos tickets.
Novos módulos podem declarar `configuration:{label}` no registro do comando
para expor um fluxo administrativo seguro; comandos operacionais não são
executados automaticamente pela central.

Onboarding tem claim SQLite anterior ao envio. Envio de resultado incerto não
é repetido automaticamente. O bot não envia onboarding retroativo a todos os
servidores durante o deploy; servidores existentes acessam `/config` ou fazem
uma publicação explícita.

Painéis registrados pelas tabelas legadas são importados sem recriar mensagens.
Mensagens antigas sem registro podem ser vinculadas pelo administrador.
Menus públicos continuam encaminhando para respostas privadas após reinícios.
Sessões da central expiram em 30 minutos; rascunhos e versões salvas persistem.

## Verificação

`tests/configuration.test.cjs`, `tests/configuration-assets.test.cjs` e o
bootstrap real cobrem fluxo do editor, permissões, CAS, imagens/SSRF,
onboarding, prévia dos templates, publicação, exclusão e recuperação.
Os testes usam clientes simulados e bancos isolados, nunca um segundo login
do bot de produção. Não exigem credenciais de usuário do Discord.
