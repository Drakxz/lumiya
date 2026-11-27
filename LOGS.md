# Cartões de logs — Lumiya

`lumiya-ui/logs.js` é a base visual dos registros enviados ao Discord.
Os eventos existentes mantêm seus destinos, autorizações, persistência,
deduplicação e tratamento de falhas. Não há interceptação global de `send`.

## Ativação opcional pelo /config

Nenhum canal de logs é criado ao adicionar a Lumiya ao servidor ou ao reiniciar
sem consentimento. Eventos de impulsionamento também não ativam a criação.

Em `/config` → **Logs (opcional)** → **Ativar logs**, a pessoa revisa os canais
e confirma **Criar e vincular logs**. O bot prepara a categoria privada
**Logs da Lumiya**, cria/reutiliza os canais e vincula automaticamente suporte,
migração, movimentação de chat, Passtime, gestão, cargos, mídias, apelidos,
backups, banimentos e impulsionamentos. O servidor especial de Instagram
mantém sua política de somente `logs-instagram`, sem categoria adicional.

O ator e o bot precisam de **Gerenciar canais**; acessos somente de visualização
não podem ativar nem alterar destinos. A confirmação revalida permissões.
Somente bot, dono e administradores têm acesso por padrão. Os nomes de
categorias existentes, canais e históricos são preservados.

O consentimento da organização automática fica em `bot_log_setup`, separado
dos destinos de `bot_log_channels`: vínculos antigos/manuais não implicam
consentimento. Depois de uma configuração completa, os canais podem ser
verificados/reparados em reinícios sem duplicação. Falhas parciais mostram
quantos canais foram vinculados e permitem repetir a configuração.
Também é possível selecionar manualmente um canal privado por tipo de log.

## Composição

- Cabeçalho: título destacado do embed, ícone discreto, descrição curta e
  thumbnail opcional do usuário/servidor relacionado ao evento.
- Informações: campos nativos, alinhados em colunas para dados curtos e em
  largura completa para motivos e conteúdos extensos.
- Detalhes: motivo, executor, resultado, IDs e contexto disponível.
- Conteúdo: comparação textual antes/depois, quando fornecida pelo emissor.
- Identificadores: IDs disponíveis do servidor, usuário, canal e mensagem.
- Rodapé: Lumiya, data/hora de Brasília, origem e identificador do registro,
  além do timestamp nativo do Discord.

**Todos os logs usam embeds tradicionais. Não usam containers, componentes,
nem a flag `IsComponentsV2`.** Os painéis e respostas de comandos não foram
migrados: esta é uma regra específica para logs.

A cor muda
discretamente por categoria: moderação roxa, segurança pêssego, comunidade
rosa-lilás, configuração/backups azul-arroxeado, membros lavanda, mensagens
cinza-arroxeado, voz azul-lavanda e mídia lilás `#C4A7E7`.
Fundo, bordas e tipografia pertencem ao cliente Discord: o cartão respeita
tanto o tema escuro quanto o tema claro do usuário.

## Integrações existentes

| Emissor | Eventos preservados |
| --- | --- |
| `media-moderation/logs.js` | Aprovação, bloqueio, revisão, erro técnico, resultado superficial e publicação efetiva do Instagram |
| `role-whitelist/addition-log.js` | Adições de cargos confirmadas pela auditoria e solicitante confirmado |
| `ban-management/index.js` | Banimento, desbanimento e resumo de desbanimento em massa |
| `ticket-management/index.js` | Atividades administrativas dos tickets por área |
| `nickname-protection/index.js` | Auditoria da proteção de apelidos e avisos |
| `backups/index.js` | Relatórios da rotina de backup |
| `configuration/index.js` | Alterações administrativas, acessos, publicações e destinos de logs |
| `instagram-web/index.js` | Auditoria entregue pelo portal web |
| `boost-logs/index.js` | Impulsionamentos confirmados pelo Discord |

Categorias de mensagem, voz e membros podem ser reutilizadas por novos
emissores. Este trabalho **não cria capturas de eventos ausentes** (por
exemplo anti-raid, exclusões de mensagens ou entradas/saídas).
Avisos públicos, DMs de punição e respostas de comandos não são logs de
auditoria e continuam seguindo suas próprias regras.

## API

`card({category, title, subtitle, summary, details, preview, metadata,
avatarURL, botAvatarURL, imageURL, at, source, eventId})` retorna o payload
pronto para `channel.send`, com `embeds` e sem `components` ou `flags`.
Os blocos aceitam texto formatado ou pares `[rótulo, valor]`.
Use `safe(valor)` para conteúdo não confiável; menções são desativadas em
todos os cartões. `fromPayload` é um adaptador para emissores legados de
metadados textuais, como os recibos de banimento; não é um conversor de
controles interativos nem de galerias.

`preview` aceita blocos textuais, como antes/depois. `imageURL` habilita um
preview de imagem por HTTPS **somente quando o emissor tiver certeza de que
a imagem pode ser publicada naquele canal**. Nenhum emissor de moderação de
mídia fornece essa opção; o sigilo das mídias retidas continua preservado.
`botAvatarURL` identifica a Lumiya no cabeçalho sem consultas adicionais.

O renderizador não faz consultas, downloads, chamadas à IA ou gravações.
O emissor continua responsável pela segurança e entrega do evento.

## Limites e privacidade

- Texto dividido por linhas, sem quebrar pares Unicode; um embed por registro,
  abaixo dos 6.000 caracteres totais, com até 25 campos, nomes de até 256 e
  valores de até 1.024 caracteres.
- Detalhes excedentes são preservados em `lumiya-log-detalhes.txt`, no mesmo
  destino do log, em vez de desaparecer por truncamento.
- Thumbnail somente por HTTPS; nenhuma URL é baixada pelo bot.
- Logs de moderação de mídia continuam **somente com metadados**. Não
  encaminham imagens retidas, legendas, caminhos locais, transcrições ou
  respostas brutas da IA. A thumbnail é o ícone do servidor.
- O log da central exibe apenas campos administrativos explicitamente
  permitidos; não serializa arbitrariamente objetos de configuração.
- Nenhum log é reenviado retroativamente por causa desta mudança visual.
- O bot precisa de **Inserir links / Embed Links** no destino para exibir
  embeds; relatórios excepcionalmente longos também precisam de **Anexar
  arquivos**. Canais provisionados pelo módulo `server-logs` já concedem
  ambas ao bot. Nenhuma permissão de membros é ampliada por este renderizador.

## Validação

`tests/lumiya-logs.test.cjs` cobre categorias, estrutura, limites, ausência de
menções, detalhes extensos, thumbnails inválidas e adaptador sem mutação.
As suítes dos módulos verificam entrega, permissões, isolamento entre
servidores, deduplicação e privacidade.

Não há cliente Discord controlável nesta instalação de desenvolvimento.
Os testes validam os payloads nativos; uma inspeção visual real no celular
e desktop precisa ser feita no cliente Discord, sem provocar punições ou
publicações artificiais em produção.
