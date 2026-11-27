# Arte dos painéis por servidor

## Imagens desativadas por servidor

`panel-art/settings.json` define `imagesEnabled: false` para o servidor
`1331871489368260619`. Suporte, migração, hall, cargos de Games, desmutar e
painéis gerais do Instagram não recebem banners ou miniaturas personalizadas.
Textos, menus e botões são preservados; fotos publicadas pelos membros e mídias
de moderação não são alteradas. Os demais servidores mantêm suas artes.
Para reativar depois, altere a opção para `true` e reinicie o bot.

Painéis de abertura de suporte, migração e verificação do Instagram são
reconhecidos pelos controles permanentes. A limpeza de mensagens por inatividade
não os apaga, inclusive depois de reinícios ou de cliques de membros.

`!painel` e `!migracao` geram a imagem do painel no momento da publicação,
usando o nome do servidor onde o comando foi executado.

`!hall` publica um painel geral de boas-vindas e diretrizes da comunidade,
com um resumo das Diretrizes do Discord e a imagem fornecida hospedada no CDN.
Ele é publicado diretamente na URL da galeria, sem imagem gerada/anexada.

- A marca canônica `mds` é detectada (`/\bmds\b/i`) e substituída por
  `serverName(guild)` (`brand.js`). Servidores sem nome disponível usam um
  rótulo neutro.
- As artes base ficam em `panel-art/support.png` e `panel-art/migration.jpg`.
  As URLs antigas do Discord estavam expiradas, então as imagens foram
  copiadas para o projeto.
- No servidor `sla` (id `1571755216519438347` ou nome `sla`), `!painel` usa a URL
  `SLA_SUPPORT_ART` (em `panel-art/index.js`) **diretamente** na galeria de mídia:
  não há geração nem anexo de PNG, e não há substituição de marca. `!migracao`
  também usa diretamente `SLA_MIGRATION_ART`, sem gerar nem anexar imagem.
- O resultado é um PNG anexado à mensagem (`attachment://arte-<tipo>.png`)
  e é cacheado em memória por servidor, evitando regeneração a cada comando.
- Painéis republicados por restauração de backup também recebem a arte do
  servidor de destino.
- Se a geração falhar, o painel é publicado com a arte antiga e o erro vai
  para o log; a falha não impede o comando.

Fontes usadas no texto: `panel-art/font.ttf` (Georgia Italic) e
`@napi-rs/canvas` para desenhar, `sharp` para mesclar a região da marca.
