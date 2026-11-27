# DESIGN — Lumiya

<!-- impeccable:design-schema 1 -->

## Platform

Discord Components V2, Node.js/discord.js 14.28.1. Superfícies privadas de
configuração e mensagens públicas permanentes. Sem dashboard externo.

## Brand commitments

A Lumiya é uma companheira de moderação, segurança e gerenciamento: fofa,
delicada, moderna e profissional. Nunca infantil. Em segurança e moderação a
linguagem é objetiva; em confirmações e boas-vindas, calorosa e discreta.

A cor de destaque padrão é `#C4A7E7`. Personalizações por servidor podem
substituir a cor, mas não os identificadores funcionais dos componentes.

## Palette

| Token | Valor | Uso |
| --- | --- | --- |
| `accent` | `#C4A7E7` | Container principal, botão primário, cor padrão dos painéis |
| `lilac` | `#E8D8F5` | Containers de estado e agrupamentos secundários |
| `rose` | `#F6DCEA` | Acentos afetuosos pontuais |
| `white` | `#FFFFFF` | Texto principal, contraste sobre lilás |
| `ink` | `#F7F3FB` | Fundo claro simulado por texto, nunca por imagem |

Não há gradientes, brilhos ou simulações de container por imagem. Um container
é sempre um `ContainerBuilder` real com `MessageFlags.IsComponentsV2`.

## Emojis

Três emojis de marca, com fallback Unicode quando ausentes:
lua `🌙`, estrela `✨`, coração `💜`. Eles aparecem em títulos, botões e
confirmações, nunca em toda linha.

Os estados e ações usam os emojis institucionais definidos em
`lumiya-ui/emojis.js`, sempre com texto explícito:

| Emoji | Uso |
| --- | --- |
| `<:off:1575879783894622321>` | Ativar |
| `<:on1:1575879743436492890>` | Desativar |
| `<:online:1575879824642277637>` | Ativo / Ativado |
| `<:noincomod:1575879858448506880>` | Desativado |
| `<:idle:1575879922767888404>` | Não configurado |
| `<a:loadingBot:1575884281748783295>` | carregando |

`emojis.panelText()` aplica os ícones a textos já existentes sem alterar a
palavra; `emojis.toggleEmoji()` fornece o ícone da ação em botões via
`setEmoji()`. `theme.text()` e `error-ui.statusText()` já aplicam o helper,
então novos painéis herdam o padrão automaticamente.

## Typography

Texto hierárquico nativo do Discord: `###` para títulos, `-#` para
subtítulos e rodapés. Nenhum texto gigante, nenhum kicker acima
do título. Corpo curto, com no máximo 4.000 caracteres por painel.

## Spatial system

- Cada tela começa diretamente com o título e o conteúdo. Não adicionar
  breadcrumbs `Painel › ...` nem um container separado só para navegação textual.
- O primeiro container traz título, subtítulo e thumbnail configurável.
- Containers seguintes separam **estado**, **configurações** e **ações**.
- Separadores com divisor e espaçamento pequeno entre seções.
- Uma linha de ações por agrupamento; no máximo cinco botões por linha.
- Mensagens de erro, sucesso e acesso usam o mesmo vocabulário visual.

## Components

- `ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`,
  `ThumbnailBuilder`, `SeparatorBuilder`, `MediaGalleryBuilder`,
  `ActionRowBuilder`, `ButtonBuilder`, selects nativos e `ModalBuilder`.
- Modais usam `LabelBuilder` com texto, select, canal, cargo ou usuário,
  preenchidos com valores atuais quando disponíveis.
- Upload em modal usa `FileUploadBuilder`; URLs passam por validação de
  rede antes do download.
- Nenhum botão sem rota real. Prévia desativa controles em vez de fingir ação.
- Limites: 40 componentes e 4.000 caracteres por mensagem, validados antes
  de editar ou publicar.

## Navigation

`/config` abre a central em resposta efêmera. O menu principal oferece
um seletor de funções, `Aparência`, `Todos os painéis` e `Acesso`, além de
pesquisa, atualização, publicações e `Logs (opcional)`.
Cada função reúne `Configurar`, `Publicar painel`, `Personalizar` e
`Painéis publicados`. A seleção de templates e de mensagens é limitada à
função atual; a publicação pede canal e confirmação. Configurações usam
rótulos de ação, não nomes técnicos de comandos. Voltar retorna à função,
e Início limpa os filtros e rascunhos selecionados na navegação.

Logs não criam canais na entrada do bot. `Ativar logs` explica os canais e
a privacidade antes de pedir confirmação; só então cria/reutiliza os destinos
e vincula cada módulo. Falhas parciais exibem a contagem real e permitem
tentar novamente sem duplicar canais nem apagar históricos.

`guildCreate` envia o onboarding uma única vez, nunca de forma retroativa.
O painel de onboarding tem dois containers: apresentação com avatar da
Lumiya e seleção de funções com botão para a central.

## Copy

- Sucesso: `♡ Prontinho! Suas alterações foram salvas.`
- Erro: `Ops! ... Pode tentar novamente?`
- Sem permissão: `Essa configuração está disponível apenas para pessoas autorizadas.`
- Vazio: `Ainda não temos nada por aqui. Que tal começar a configurar?`
- Ativado: `Tudo certo! Já estou cuidando disso por você. ♡`

## Architecture

`lumiya-ui/theme.js` centraliza tokens, emojis, breadcrumbs, containers,
estados, navegação, modais, validação e feedback. `lumiya-ui/shell.js` aplica
o acabamento do `/config` aos templates, sem inserir containers extras; `lumiya-ui/canonical.js`
normaliza acento e separadores nos painéis operacionais existentes sem alterar
ações: títulos compactos `###` e lua discreta, sem consumir
novos componentes. Exemplos em blocos de código, anexos e cores personalizadas
ou semânticas são preservados; a decoração cede espaço ao conteúdo no limite
de texto. Templates e painéis públicos compartilham a escala de títulos.
A central de comandos inclui pesquisa com legenda, limpeza de filtros e
navegação explícita; sua versão visual participa da atualização dos painéis
permanentes, que são editados sem duplicação.
`configuration/ui.js` reexporta essa API para o editor e a central. `configuration/views.js`
compõe telas; `configuration/controller.js` roteia ações e revalida permissões.
`configuration/render.js` e `runtime.js` aplicam personalizações aos painéis
públicos sem duplicar renderizadores. Cada módulo continua dono das suas
regras de negócio e permanece integrado por adaptadores, não por cópias.
