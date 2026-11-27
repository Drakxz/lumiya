# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Membros da comunidade Discord servida pelo bot (em especial o servidor **sla**) e operadores do servidor — administradores e moderadores que configuram e operam o bot.

- **Membros:** abrem tickets de suporte e migração, consultam o catálogo de comandos, acompanham cargos, horas de voz e rankings, e enviam fotografias pelo portal web opt-in. Qualquer membro pode postar no portal; não é exigido cargo administrativo.
- **Operadores:** configuram canais, cargos, limites, moderação e painéis permanentes; respondem tickets em tópicos privados; administram o portal. Proprietário ou membro com Administrator efetivo tem administração completa; cargos moderadores têm acesso operacional, não às configurações críticas; VIP altera apenas limite/cooldown.

## Product Purpose

Bot Discord para a comunidade que reúne suporte, migração, moderação, gestão de cargos, ficha, horas de voz, ranking/UP, jogos, chat com IA e um portal web de fotografias no estilo Instagram. O sucesso é uma comunidade operada com menos esforço manual de moderação/atendimento e com publicação de fotos segura, auditável e integrada ao próprio Discord.

O portal é **opt-in** (`INSTAGRAM_WEB_ENABLED=true`); sem isso o bot continua operando sem abrir servidor HTTP. Falhas de configuração do portal deixam o site offline sem derrubar os demais módulos.

## Positioning

Um único processo Discord.js 14 com banco SQLite **compartilhado** — sem segunda conexão Gateway, sem Redis/PostgreSQL e sem API interna entre processos. O portal web reaproveita o publicador real do Instagram (`instagram.publish`), o OAuth2 oficial do Discord e a moderação oficial da OpenAI, em vez de recriá-los. As fotos publicadas pelo site são idênticas às do fluxo antigo: nenhum selo, rodapé ou indicação de origem web é adicionado.

## Operating Context

- Servidor Discord **sla** (nome confirmado). O repositório/pacote chama-se `mds-bot`.
- Comandos por prefixo `!` e slash `/`, com um catálogo lógico compartilhado (`command-system/registry.js`) como fonte única.
- Painéis permanentes usam Discord Components V2; tickets abrem tópicos privados no canal do painel clicado.
- Estado em SQLite WAL (`CALL_STATS_FILE`, padrão `./database/call-stats.sqlite`), `data.json` e `role-history.json`; uma única instância é garantida por trava em `.bot-instance.lock`.
- Idioma de produto: **pt-BR**.
- Portal: Fastify no mesmo processo + SPA React/TypeScript/Vite, Inter hospedada localmente e Lucide; inicialização em `127.0.0.1:3000` quando o Discord fica pronto; produção atrás de Nginx/HTTPS (Docker ou VPS) com `WEB_TRUST_PROXY` restrito aos proxies controlados.
- Supervisor `start.js` com reinício exponencial e limite de cinco quedas em dez minutos.

## Capabilities and Constraints

**Capacidades confirmadas:** suporte/migração com tickets em tópicos privados; central de comandos com consulta pessoal e painéis que se atualizam por hash; moderação, guarda, banimentos, nicknames, boost logs, horas de voz, ranking/UP, jogos, chat IA, anticrash, backups; portal com login Discord (Authorization Code + PKCE S256, estado e CSRF), seleção de servidor, upload moderado de fotografias e de vídeos curtos, histórico, edição/exclusão, notificações, denúncias, revisão adicional e administração.

**Restrições duráveis:**
- Node.js >= 22.13 (o portal recomenda Node 24 LTS); discord.js 14; uma única instância/worker manipulando o SQLite.
- Moderação obrigatória com `omni-moderation-latest` antes de qualquer publicação; resultados inconclusivos/erros não aprovam; sem detector de pele, reconhecimento facial nem alegação de certeza sobre idade/consentimento.
- Upload: até 5 fotografias ou um único vídeo por publicação (sem misturar); máximo 10 MiB por imagem, 20 MiB por vídeo e 24 MiB finais; apenas JPEG, PNG e WebP estático, ou MP4/MOV/WebM com até 15 segundos; no máximo 25 MP / 12 mil pixels por dimensão; saída JPEG até 4096×4096. O vídeo é remuxado sem metadados e sem áudio antes da análise; quadros distribuídos pela duração, mudanças de cena e último quadro passam pelo `omni-moderation-latest`, e análise incompleta vai para revisão.
- Sessões opacas de 12 h com rotação, limite absoluto de 7 dias, cookie HttpOnly/SameSite=Lax/Secure; token OAuth revogado e descartado; nenhum access/refresh token armazenado.
- Esquema estrito de configuração: campos desconhecidos (incluindo desativar OpenAI) são rejeitados.
- Privacidade/LGPD: fotos recusadas descartadas na decisão; aprovadas/em revisão/falhas/incertas limpas após 7 dias; órfãs após 1 hora; notificações 30 dias; eventos/auditoria 90 dias; sem IP cru persistido; backups contêm dados pessoais e exigem acesso restrito.
- Entregas ambíguas não são reenviadas automaticamente; "Conferir entrega" apenas vincula uma mensagem já existente e confirmada.
- Sem funcionalidades simuladas: o escopo declara explicitamente o que não existe (feed público/interno, favoritos, ranking web, agendamento, HEIC, OCR, CAPTCHA, tradução, DMs do portal, editor de enquadramento livre).

**Em aberto (não inventados):** quais outros servidores além de sla usam o bot; validação real de login OAuth, publicação no servidor, uso da chave OpenAI, implantação Docker/VPS e auditoria externa de segurança — o repositório afirma que nada disso foi feito e não devem ser tratados como prontos.

## Fotografias de destaque

A tela de login apresenta publicamente a primeira imagem da última publicação real do bot no servidor principal, sem legenda ou identificação do autor. Na home autenticada, o destaque é a última fotografia publicada pelo próprio membro no servidor selecionado, mediante verificação de sessão e acesso. Isso não cria um feed público: são dois destaques individuais, incluindo publicações feitas diretamente pelo Discord. As imagens são consultadas nas mensagens reais, sem copiar arquivos nem alterar a retenção do portal. Quando indisponíveis, a interface preserva o banner/logo e a ilustração anteriores.

## Login nativo (planejado)

Para abrir a autorização dentro do aplicativo oficial do Discord no celular e no desktop, é necessário um aplicativo nativo com Discord Social SDK 1.5+, PKCE e redirect `discord-ID_DO_APP:/authorize/callback` (celular) ou loopback `127.0.0.1` (desktop). O servidor já expõe a troca do código por um ticket de login único, sem devolver tokens; a especificação está em `NATIVE-APP.md`. O aplicativo nativo, a assinatura e a distribuição **não** foram feitos e não devem ser tratados como prontos.

## Brand Commitments

- Nome do servidor: **sla**; quando o servidor não estiver disponível, usar rótulo neutro (`Servidor`) em vez de atribuir identidade errada.
- No servidor sla, títulos de painel usam **texto simples, sem emojis decorativos** (`brand.js`: `TEXTO_SLA_ID`, `prefereTexto`).
- Voz e conteúdo em **pt-BR**.
- Nenhum selo/rodapé de origem web nas fotografias publicadas.
- Não atribuir ao bot uma identidade de marca própria como padrão silencioso; o nome do servidor vem do servidor real.

## Evidence on Hand

- Documentação extensa no próprio repositório: `README.md`, `COMMAND-CENTER.md`, `INSTAGRAM.md`, `AUTO-CALLS.md`, `BACKUPS.md`, `BANIMENTOS.md`, `BOOST-LOGS.md`, `CALL-PANEL.md`, `CLEAR.md`, `ERROR-UI.md`, `INITIAL-ROLE.md`, `MEDIA-MODERATION.md`, `NUKE.md`, `PANEL-ART.md`, `ROLE-HISTORY.md`, `UNMUTE.md`, `UP-CARGOS.md`, `VOICE-HOURS.md` e `instagram-web/README.md` / `instagram-web/API.md`.
- `package.json`, `.env.example`, `brand.js`, `start.js`, `index.js`, `command-system/registry.js`, `instagram/index.js`, `media-moderation/openai.js`; testes em `tests/` e suíte web (`npm run web:check`, `web:e2e`).
- Imagens de referência presentes: `horas-reference.jpg`, `horas-reference-actual.jpg`, `horas-base-ref.png`, `hours-ref.png`, `hours-bg.png`, `emoji*.png`.
- **Ausências que o trabalho futuro não deve fabricar:** não há depoimentos, clientes, benchmarks, preços, licenças de terceiros nem prova de deploy/validação pública; a documentação afirma explicitamente que login OAuth real, publicação real, uso da OpenAI real, deploy e auditoria externa **não** foram feitos.

## Product Principles

1. **Preservar o núcleo:** manter um único processo, uma conexão Discord e um SQLite compartilhado; nunca introduzir segundo Gateway, Redis ou PostgreSQL como efeito colateral.
2. **Reutilizar mecanismos reais:** publicador, OAuth, permissões e moderação existentes são a fonte da verdade; não criar atalhos, botões simulados ou conteúdo que contorne verificação.
3. **Segurança e privacidade por construção:** moderação obrigatória antes da publicação, menor privilégio, retenção definida e nenhuma promessa legal ou de certeza que o software não pode cumprir.
4. **Respeitar a identidade do servidor:** idioma pt-BR, nome vindo do servidor real e títulos sem emojis onde configurado; rótulo neutro quando o servidor não estiver disponível.
5. **Degradar sem derrubar:** módulos opcionais falham isoladamente; configuração inválida do portal não interrompe moderação, suporte nem os demais comandos.

<!-- Decisões de fluxo de trabalho (não são verdade de produto): buildPath=code, registrada em .impeccable/config.json. -->
