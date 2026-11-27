# API HTTP

Mesmo domínio do frontend. JSON UTF-8, IDs como strings, timestamps UTC em ms.
Erros: `{"error":"mensagem segura"}`. Listagens: `{"items":[...]}`.
Parâmetros comuns: `limit` (1–50), `offset` (0–100000).

Autenticação: cookie `iw_session`, HttpOnly. Toda mutação (exceto callback
OAuth) exige Origin igual a `APP_URL` e `X-CSRF-Token` retornado por
`GET /api/auth/me`. Não é permitida autenticação por um ID enviado no formulário.

## Públicas

| Método | Rota | Resultado |
|---|---|---|
| GET | `/api/health` | vivacidade HTTP |
| GET | `/api/status` | nome/logo/regras/limites públicos e disponibilidade geral |
| GET | `/api/auth/discord` | redirect OAuth com state e PKCE |
| GET | `/api/auth/discord/callback` | valida code/state, cria sessão |

## Conta / membro

| Método | Rota | Entrada / resultado |
|---|---|---|
| GET | `/api/auth/me`, `/api/profile` | identidade real, permissões web, quotas, CSRF |
| GET | `/api/guilds` | `{items:[{id,name,icon,configured,maintenance,admin}],defaultGuildId,csrf}`; servidores em comum com o bot, inclusive para membros sem cargo administrativo |
| POST | `/api/auth/logout` | encerra sessão atual |
| POST | `/api/auth/revoke` | encerra todas as sessões |
| POST | `/api/auth/renew` | rotaciona cookie e CSRF; consulte me novamente |
| POST | `/api/auth/native/exchange` | login de app nativo: `{code,codeVerifier,redirectUri?}`; troca o código pelo ticket de sessão, sem devolver token |
| GET | `/api/auth/native/consume?ticket=...` | consome o ticket único, cria o cookie e redireciona para `/app` |
| PATCH | `/api/profile` | `{handle,showInstagram,theme,notifications}` |
| GET | `/api/publications` | próprio histórico; `state`, `search`, paginação |
| POST | `/api/publications` | multipart: `data` JSON `{caption,handle,consent:true}` + `images` repetido (fotos JPG/PNG/WebP ou um único vídeo MP4/MOV/WebM); header `Idempotency-Key` (16–100 caracteres) |
| GET | `/api/publications/:id` | somente do autor |
| GET | `/api/publications/:id/preview` | componentes gerados pelo renderizador original |
| POST | `/api/preview` | `{caption}`; prévia do próprio usuário |
| PATCH | `/api/publications/:id` | `{caption,handle,consent:true}`; nova análise |
| DELETE | `/api/publications/:id` | exclusão autorizada no Discord |
| POST | `/api/publications/:id/review` | `{reason}`; apenas revisão elegível |
| POST | `/api/publications/:id/retry` | retry de falha temporária final elegível |
| POST | `/api/publications/:id/report` | `{reason}`; aceita também ID do post legado |
| GET | `/api/publications/:id/images/:image` | JPEG ou vídeo privado; só autor + estado publicado |
| GET | `/api/notifications` | próprias notificações paginadas |
| PATCH | `/api/notifications/:id` | marca própria notificação lida |

Resposta do upload: HTTP 202 com publicação persistida. Repetição da mesma chave
retorna a publicação já existente. Não reutilize a chave para outro conteúdo.
O progresso é obtido consultando a publicação; não existe percentual artificial
da análise de IA.

Vídeos são aceitos quando `allowVideo` está ativo: no máximo um por publicação,
sem misturar com fotografias, até `maxVideoBytes` e `maxVideoSeconds`. O arquivo
é validado e remuxado sem metadados e sem áudio. A análise usa o mesmo
processador do bot: quadros ao longo da duração, mudanças de cena e último
quadro passam pelo `omni-moderation-latest`; resultado inconclusivo, bloqueio
ou cobertura incompleta não aprova automaticamente.

### Perfil e insígnias

`/api/auth/me` inclui `banner`, `badges` (`id`, `kind`, `label`, `description`),
`accountBadges`, `accountCreatedAt`, `boostingSince` e a cor de cada cargo em
`roles[].color`. As insígnias de proprietário, administrador, moderador, VIP e
impulsionador refletem as permissões, cargos configurados e impulsionamento do
servidor atual. `accountBadges` separa os distintivos da conta exibidos ao lado
do @: os flags públicos, o boost confirmado neste servidor (sem nível global) e,
quando autorizado, Nitro. As imagens locais têm atribuição em
`frontend/public/discord-badges/LICENSE.txt`.

`GET /api/profile` acrescenta `accountBadgesSource` (`official-api` ou
`visible-profile`), `accountBadgesCheckedAt` e, quando disponível, a lista
visual nativa (`id` `native:*` e `icon`). Essa consulta opcional reutiliza
`DISCORD_BIO_CHECK_USER_TOKEN` — token de uma **conta secundária**, nunca de bot
— para ler as insígnias que essa conta consegue ver. O ID consultado é sempre o
do membro autenticado, no servidor selecionado, e a consulta acontece só no
backend: o token não vai ao navegador, não é gravado e não altera permissões.
É uma API não oficial, sujeita a falha e a punição da conta; se ela falhar, o
perfil continua com os dados oficiais. Resultados ficam em cache por 5 minutos
(falhas, 1 minuto). `WEB_PROFILE_BADGES_USER_LOOKUP_ENABLED=false` desliga
somente essa exibição visual.

Nitro exige `DISCORD_IDENTIFY_PREMIUM_ENABLED=true` **somente após aprovação
do Discord para o escopo de parceiro `identify.premium`**. O padrão é `false`:
habilitar sem aprovação pode impedir o login. Com aprovação, um novo login
solicita consentimento; somente o campo oficial `premium_type`, com esse escopo
efetivamente concedido, gera o registro `{type,checkedAt}` no perfil armazenado.
O distintivo vale por até 12 horas como confirmação feita no login, não como
verificação contínua da assinatura. Tokens continuam revogados e não armazenados.
Nitro nunca é deduzido de avatar animado, banner ou boost.

A API de bot não expõe todos os distintivos do cliente Discord (por exemplo,
níveis globais de boost). Sem a consulta visual opcional, esses distintivos não
são inventados; com ela, aparecem apenas as imagens que a conta de consulta
realmente consegue ver.

`GET /api/profile` também consulta o banner global do usuário no Discord,
priorizando o banner específico do servidor quando disponível. Essa consulta
ocorre apenas ao abrir o perfil. Se o Discord não responder ou a imagem falhar,
a interface mantém uma capa decorativa, sem impedir o uso das preferências.

### Fotografias de destaque

- `GET /api/latest-photo`: público; redireciona à primeira imagem da última publicação real do bot no servidor principal, sem aceitar seleção de outro servidor.
- `GET /api/me/latest-photo?guildId=...`: exige sessão e acesso ao servidor selecionado; redireciona à primeira imagem da última publicação do próprio usuário. Não aceita ID de outro autor.
- Ambos consultam mensagens registradas em `instagram_posts`, inclusive publicações fora do portal, e usam `Cache-Control: no-store` (privado na rota pessoal). Retornam 404 quando não existe imagem acessível. A CDN do Discord mantém suas próprias regras de cache.

### Onde publicar

Após o login, o site consulta `/api/guilds` e pergunta em qual comunidade a pessoa
quer postar, mesmo quando há somente uma opção. Não é necessário ser administrador.
Servidores ainda sem Instagram configurado ou em manutenção são sinalizados.

As rotas de status, perfil, publicação, prévia, imagens, notificações e moderação
aceitam `?guildId=ID`. O frontend envia explicitamente o servidor escolhido em cada
requisição, inclusive no upload e nas URLs das fotos. Sem o parâmetro, integrações
existentes continuam usando `DISCORD_GUILD_ID` como padrão.

O ID escolhido não concede acesso: a participação e as permissões nativas são
verificadas no servidor indicado. O job preserva o destino na publicação e verifica
novamente o acesso antes da entrega, sem redirecionar fotos para outro servidor.
Histórico, quotas, restrições, notificações e dados administrativos são separados
por servidor. O contexto de requisições simultâneas e jobs usa AsyncLocalStorage.

## Moderação (cargo configurado ou administrador)

| Método | Rota | Entrada / resultado |
|---|---|---|
| GET | `/api/admin/stats` | `days=1/7/30` (até 90), contagens e durações reais |
| GET | `/api/admin/publications` | paginação, `state`, `user` (ID exato), sem casos graves |
| DELETE | `/api/admin/publications/:id` | `{reason}` |
| POST | `/api/admin/publications/:id/review` | `{approve:boolean,reason}`; nunca ignora OpenAI |
| POST | `/api/admin/publications/:id/reveal` | `{reason}`; acesso auditado à revisão comum |
| GET | `/api/admin/publications/:id/images/:image` | bytes privados de revisão elegível, acesso auditado |
| POST | `/api/admin/publications/:id/reconcile` | `{messageId,reason}`; vincula apenas entrega existente e validada |
| GET | `/api/admin/users` | contas que já acessaram o portal; busca ID por `search` |
| POST | `/api/admin/users/:id/restrict` | `{hours,reason,dailyLimit:null}`; só a plataforma |
| POST | `/api/admin/users/:id/unrestrict` | `{reason}` |
| GET | `/api/admin/reports` | denúncias privadas, paginação |
| PATCH | `/api/admin/reports/:id` | `{reason}`; encerra denúncia |
| GET | `/api/admin/logs` | auditoria paginada, sem fotos/segredos |

## Administração (proprietário ou Administrator real)

### Seleção de servidor

| Método | Rota | Resultado |
|---|---|---|
| GET | `/api/admin/guilds` | `{items:[{id,name,icon,primary}],defaultGuildId}`; somente servidores do bot em que a conta é proprietária ou Administrator |
| GET | `/api/admin/guilds/:guildId/settings` | configurações, canais de texto e cargos apenas do servidor escolhido |
| PATCH | `/api/admin/guilds/:guildId/settings` | objeto completo `settings`; valida permissão atual, canais/cargos do servidor e permissões do bot |

Por padrão o login usa apenas o escopo OAuth `identify`. A lista de servidores
e as permissões são verificadas pelo próprio bot, sem armazenar tokens Discord.
`/api/auth/me` inclui `canManageGuilds` e `adminOnly`: administradores que não têm
acesso ao servidor principal podem entrar apenas no gerenciamento dos seus servidores.

Cada configuração é persistida por `guildId`. O canal de Instagram também atualiza
`instagram_settings` do servidor escolhido e passa a valer no bot imediatamente.
Servidores ainda não configurados retornam `settings.channelId` vazio; é obrigatório
escolher um canal antes de salvar. A alteração de configurações e do destino ocorre
na mesma transação e gera auditoria.

Publicações, moderação, membros e auditoria usam o servidor escolhido. As
configurações web de cada servidor passam a valer quando ele é selecionado,
sem transferir dados nem liberar acesso à administração de outros servidores.

### Rotas com servidor padrão (compatibilidade)

`GET /api/admin/settings`: configurações, canais e cargos reais, versão de política.

`PATCH /api/admin/settings`: objeto completo retornado em `settings`, validado
por `config.js`. Cargos precisam existir; destino precisa ser de texto e ter
permissões do bot; logs precisam ser privados. Não há campos para desativar
OpenAI ou modificar layout de publicações. Alterações geram auditoria.

Requisições não autorizadas são rejeitadas também ao acessar URLs diretamente.
Política, pontuações e credenciais não fazem parte das respostas aos membros.
