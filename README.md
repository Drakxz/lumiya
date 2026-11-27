# Lumiya

Bot Discord e portal de fotografias de uma comunidade brasileira. O projeto é
CommonJS/Node.js, usa `discord.js` 14 e um único banco SQLite compartilhado.
Toda a identidade visual, os painéis Components V2 e a IA conversacional vivem
neste repositório.

## Requisitos

- Node.js **>= 22.13.0**. A instalação ativa usa 26.13.1; o container usa 24.
- Dependências do sistema para.renderização de painéis: `fonts-dejavu-core`,
  `fontconfig` e FFmpeg (os binários npm são instalados via `npm ci`).
- Discord com **Message Content Intent** habilitado e permissões de envio,
  leitura de histórico, anexos e mensagens de voz nos canais usados.

## Instalação

```sh
npm ci
cp .env.example .env       # nunca sobrescreva um .env existente
# preencha DISCORD_TOKEN e os provedores que serão usados
npm start
```

Não inicie uma segunda instância local enquanto a instância AWS estiver ativa:
isso duplica respostas e divergências de estado. A operação da instalação ativa
está descrita em [MIGRACAO-AWS.md](MIGRACAO-AWS.md).

## Testes e verificações

```sh
npm test            # node --test (908 testes)
npm run lint        # ESLint, somente leitura
npm run format:check
npm run check       # lint + testes + checagem do frontend
```

O portal web é opcional; habilite com `INSTAGRAM_WEB_ENABLED=true`. Para
desenvolvimento e build do frontend, veja
[instagram-web/README.md](instagram-web/README.md).

## Arquitetura

O ponto de composição é [`index.js`](index.js): ele cria o cliente Discord,
abre o SQLite compartilhado e instala os módulos. Cada módulo registrado em
`index.js` é autocontido e recebe apenas as dependências que precisa.

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — mapa de módulos, fluxos e como adicionar
  comandos, eventos, sistemas e painéis.
- [`DESIGN.md`](DESIGN.md) — identidade visual, emojis e regras dos painéis.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — fluxo de branches, PRs e segurança.
- [`.env.example`](.env.example) — todas as variáveis usadas, sem valores reais.

## Documentação dos módulos

| Área                       | Documentação                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat com IA, memória e voz | [AI-CHAT.md](AI-CHAT.md) · [BEDROCK-AUDIO.md](ai-chat/BEDROCK-AUDIO.md)                                                                                       |
| Central de configuração    | [configuration/README.md](configuration/README.md)                                                                                                            |
| Moderação de mídias        | [MEDIA-MODERATION.md](MEDIA-MODERATION.md)                                                                                                                    |
| Tickets e equipes          | [COMMAND-CENTER.md](COMMAND-CENTER.md) · [ticket-management/CONFIGURATION.md](ticket-management/CONFIGURATION.md)                                             |
| Backup e restauração       | [BACKUPS.md](BACKUPS.md)                                                                                                                                      |
| Calls e horas              | [VOICE-HOURS.md](VOICE-HOURS.md) · [AUTO-CALLS.md](AUTO-CALLS.md) · [CALL-PANEL.md](CALL-PANEL.md)                                                            |
| Cargos e whitelist         | [INITIAL-ROLE.md](INITIAL-ROLE.md) · [UP-CARGOS.md](UP-CARGOS.md) · [role-whitelist/README.md](role-whitelist/README.md) · [ROLE-HISTORY.md](ROLE-HISTORY.md) |
| Moderação e proteção       | [BANIMENTOS.md](BANIMENTOS.md) · [nickname-protection/README.md](nickname-protection/README.md) · [UNMUTE.md](UNMUTE.md) · [CLEAR.md](CLEAR.md)               |
| Portal de fotos            | [instagram-web/README.md](instagram-web/README.md) · [instagram-web/API.md](instagram-web/API.md) · [INSTAGRAM.md](INSTAGRAM.md)                              |
| Painéis e aparência        | [PANEL-ART.md](PANEL-ART.md) · [panel-art/COLORS.md](panel-art/COLORS.md) · [command-system/COMANDOS.md](command-system/COMANDOS.md)                          |
| Infraestrutura             | [MIGRACAO-AWS.md](MIGRACAO-AWS.md) · [ANTICRASH.md](ANTICRASH.md) · [PRODUCT.md](PRODUCT.md)                                                                  |

## Segurança

Nunca versionar `.env`, credenciais, bancos SQLite, chaves, uploads, logs ou
backups privados — o [`.gitignore`](.gitignore) cobre esses arquivos. Para
reportar um problema de segurança, siga [SECURITY.md](SECURITY.md).
