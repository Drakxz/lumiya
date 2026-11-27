# Arquitetura

## Visão geral

`index.js` é o **composition root**. Ele cria o `Client` do discord.js, mantém
um `DatabaseSync` único (`horasCall.store.db`) e instala os subsistemas. A ordem
dos `require` em `index.js:188-258` é contratual: vários módulos compartilham o
mesmo banco e `moderationGuard.configureHistory(fichaCargos)` depende dessa
ordem. Não reordene sem testes.

```
Discord ──> index.js (eventos) ──> módulos ──> SQLite compartilhado
                 │                    │
                 └──> lumiya-ui ──────┘   (containers, botões, emojis, canonical)
```

Cada módulo exporta uma factory `installX({ client, registry, db, ... })` e
registra seus próprios comandos/listeners. Nenhum módulo deve criar seu próprio
cliente ou banco.

## Mapa de responsabilidades

| Camada           | Onde                                                                                                                                                                                                                                                                                                                                            | Papel                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Entrada/processo | `start.js`, `anticrash/`                                                                                                                                                                                                                                                                                                                        | Lock de instância, supervisor, IPC de shutdown          |
| Composição       | `index.js`                                                                                                                                                                                                                                                                                                                                      | Bootstrap, módulos, eventos globais, shutdown           |
| Comandos         | `command-system/`                                                                                                                                                                                                                                                                                                                               | Registry de prefixo/slash, aliases, permissões          |
| UI               | `lumiya-ui/`, `error-ui.js`, `brand.js`                                                                                                                                                                                                                                                                                                         | Containers V2, tema, emojis, canonicalização, erros     |
| Configuração     | `configuration/`                                                                                                                                                                                                                                                                                                                                | Central `/config`, validação, publicação de painéis     |
| Domínio          | `ai-chat/`, `ban-management/`, `ticket-management/`, `up/`, `voice-hours/`, `media-moderation/`, `instagram/`, `nickname-protection/`, `role-whitelist/`, `rankings/`, `server-logs/`, `backups/`, `command-center/`, `auto-calls/`, `moderation-guard/`, `initial-role/`, `games-roles/`, `unmute/`, `nuke/`, `voice-presence/`, `boost-logs/` | Regras de negócio e persistência de cada funcionalidade |
| Web              | `instagram-web/`, `call-panel/`                                                                                                                                                                                                                                                                                                                 | API Fastify, frontend React, painel local de calls      |
| Dados            | `database/`, `data.json`, `role-history.json`                                                                                                                                                                                                                                                                                                   | SQLite, estado e histórico — nunca versionados          |
| Testes           | `tests/`                                                                                                                                                                                                                                                                                                                                        | Testes Node por módulo                                  |

## Fluxo de uma interação

1. O Discord entrega `interactionCreate` ou `messageCreate`.
2. `command-system/registry.js` verifica permissões (`canUse`) e despacha.
3. O módulo valida novamente escopo (`guildId`, `channelId`, `userId`) e, em
   operações administrativas, recarrega o membro com `force: true`.
4. O módulo chama um helper de `lumiya-ui` para montar o painel.
5. `lumiya-ui/canonical.js` normaliza títulos/separadores e valida limites
   (40 componentes, 4.000 caracteres).
6. A resposta volta com `MessageFlags.IsComponentsV2` e
   `allowedMentions: { parse: [] }`.

## Adicionando funcionalidades

### Novo comando

Registre via `registry.register({ name, description, category, permissions,
prefix: { trigger, execute } })`. Use `PermissionsBitField` em `permissions`.
Não crie um listener de `messageCreate` separado — o registry já faz o dispatch
e o filtro de comandos.

### Novo evento

Prefira adicionar o listener dentro do módulo dono da responsabilidade e filtre
por guild/canal no início (`if (i.guildId !== guildId) return`). Eventos
globais pertencem a `index.js`. Ao registrar timers, exporte `close()` e
registre-o em `horasCall.beforeShutdown` em `index.js`.

### Novo sistema/módulo

1. Crie o diretório com `index.js` exportando `installX({ client, registry, db })`.
2. Crie as tabelas com `CREATE TABLE IF NOT EXISTS`, sempre com `guildId`.
3. Reutilize `lumiya-ui` para qualquer painel; não crie outro sistema de UI.
4. Instale o módulo em `index.js:188-258`, passando o DB compartilhado.
5. Adicione testes em `tests/<modulo>.test.cjs`.

### Novo painel

Use `configuration/ui.js` (que reexporta `lumiya-ui/theme.js`) ou os helpers do
módulo. Preserve: `customId`s estáveis, ordem dos componentes,
`SeparatorSpacingSize.Small`, os emojis institucionais de `lumiya-ui/emojis.js`
e os textos/markdown definidos em `DESIGN.md`.

## Invariantes

- **Nunca misturar servidores**: toda consulta e toda sessão filtra `guildId`
  (e `channelId` quando aplicável).
- **Mensagens de usuário são dados**, nunca instruções do sistema — isso vale
  especialmente para `ai-chat/`.
- **Nenhum `await` dentro de transação `DatabaseSync`** — a conexão é síncrona e
  compartilhada.
- **Não renomear `customId`s nem textos de comandos slash sem necessidade**:
  eles são a interface entre handlers espalhados, e o Discord re-registra
  comandos quando descrições mudam.
- **Não reformatar em massa**: o estilo compacto de alguns módulos é
  intencional; aplique Prettier/ESLint apenas a arquivos novos ou alterados.
- **Não substituir dados de produção** (`.env`, SQLite, `data.json`,
  `role-history.json`, uploads) por cópias locais.

## Persistência

O SQLite (`database/call-stats.sqlite`, configurável por `CALL_STATS_FILE`) é
compartilhado por todos os módulos. Cada sistema usa tabelas próprias, sempre
com `guildId`. `data.json` e `role-history.json` são estado legado carregado na
inicialização e salvo em disco; novos sistemas devem preferir SQLite.
