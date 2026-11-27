# Fotografias da comunidade

Portal funcional integrado ao bot, **desativado por padrão**. Não integra a API
do Instagram real e não cria outra conexão Gateway.

## Arquitetura e preservação do bot

Análise do projeto original:

| Recurso | Implementação reutilizada |
|---|---|
| Processo / supervisão | `start.js`, `index.js`, `anticrash/` |
| Discord | instância existente de Discord.js 14 |
| Banco | `horasCall.store.db`, SQLite WAL, `database/call-stats.sqlite` |
| Publicação / layout | `instagram/index.js`: `publish`, `render` |
| Curtidas, comentários, perfil e exclusão | interações `insta:*` existentes |
| @ opcional | `instagram_submissions`, exibido somente no botão de perfil |
| Moderação oficial | `media-moderation/openai.js`, SDK oficial OpenAI |
| Preparação de imagens | Sharp, `file-type` já instalados |
| Acesso web | Participação no destino e políticas de segurança do portal |

O novo módulo usa Fastify no mesmo processo do bot e tabelas prefixadas `iw_`.
O frontend é React + TypeScript + Vite, com Inter hospedada localmente e Lucide.
Uma SPA estática evita introduzir um segundo servidor Next.js/SSR, Redis,
Prisma ou PostgreSQL onde não são necessários. Não existe endpoint interno de
publicação nem segredo compartilhado com o navegador.

`instagram.publish` continua sendo o único emissor das fotografias. Sua entrada
agora também aceita um vetor de imagens. Para uma fotografia, os componentes,
flags, galeria, separadores, textos, emojis e botões são idênticos aos do fluxo
antigo. Nenhum selo, rodapé ou indicação de origem web é adicionado. A origem é
registrada internamente pela tabela `iw_publications` e pelo `sourceId`.
As interações e o refresh existente preservam todas as imagens da galeria.

## Instalação local

Recomendado: **Node 24 LTS**, npm, acesso ao servidor pelo bot. Não inicie duas
instâncias do bot usando os mesmos arquivos.

```powershell
npm ci
npm run web:install
npm run web:build
```

Acrescente as variáveis de `.env.example` ao seu `.env` **sem sobrescrever os
tokens/configurações existentes**. Gere um segredo exclusivo:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Preencha:

- `DISCORD_CLIENT_ID`: ID da aplicação do bot.
- `DISCORD_CLIENT_SECRET`: segredo OAuth2 da mesma aplicação.
- `DISCORD_GUILD_ID`: servidor padrão da home pública e das integrações sem seleção explícita.
- `APP_URL`: origem pública do site, por exemplo `https://fotos.seudominio.com`.
- `DISCORD_REDIRECT_URI`: exatamente a origem acima seguida de
  `/api/auth/discord/callback`.
- `SESSION_SECRET`: o segredo aleatório gerado.
- `OPENAI_API_KEY`: chave OpenAI com acesso a `/v1/moderations`.
- `OPENAI_MODERATION_MODEL=omni-moderation-latest`.
- `DISCORD_SERVER_INVITE`: convite do servidor, caso ainda não configurado.
- `DISCORD_INSTAGRAM_CHANNEL_ID`: necessário se `!instagram` ainda não
  configurou um destino.
- `INSTAGRAM_WEB_ENABLED=true`: somente depois das configurações.

O token Bedrock e a assinatura ChatGPT **não** autenticam o endpoint obrigatório
da OpenAI. A chave nunca é enviada ao frontend.

```powershell
npm start
```

O bot inicia o HTTP em `127.0.0.1:3000` quando o Discord estiver pronto.
Falhas de configuração deixam o site offline sem derrubar os demais módulos.
Um frontend não compilado é recusado em produção.

### Desenvolvimento

Use temporariamente:

```env
NODE_ENV=development
APP_URL=http://localhost:5173
DISCORD_REDIRECT_URI=http://localhost:5173/api/auth/discord/callback
WEB_HOST=127.0.0.1
PORT=3000
```

Execute o bot e, em outro terminal, `npm run web:dev`. O Vite encaminha `/api`
ao backend; cookies, OAuth e CSRF continuam reais. Cadastre também a URI de
desenvolvimento no Discord. Não use o fixture de testes como servidor de uso.

## OAuth2 oficial

1. Discord Developer Portal → aplicação do bot → OAuth2.
2. Cadastre a Redirect URI exata, inclusive protocolo, host, porta e caminho.
3. Copie Client ID / Client Secret para o `.env` privado.
4. Por padrão o login solicita apenas `identify`, com Authorization Code, state e PKCE S256.
5. O token OAuth é usado para identificar a conta, revogado e descartado; não
   são armazenados access tokens ou refresh tokens.
6. Participação, cargos e permissões são consultados pelo bot a cada requisição
   protegida, não por dados fornecidos pelo navegador.

Sessões: identificador opaco aleatório, somente seu hash no banco, cookie
HttpOnly/SameSite=Lax/Secure em HTTPS. Duração de 12 h, renovação com rotação,
limite absoluto de sete dias. A interface renova a sessão a cada quatro horas
enquanto estiver aberta. Logout e revogação de todas as sessões são suportados.
Solicitações mutáveis exigem token CSRF e Origin exato.

**Validação real pendente de implantação:** é necessário testar o login na
aplicação Discord escolhida, com a URI pública e sua configuração OAuth2,
incluindo suporte a PKCE. Os testes automatizados não substituem essa etapa.
O código não remove PKCE nem relaxa state caso o provedor recuse o fluxo.

## Canais, verificação e cargos

### Insígnias da conta

O perfil exibe as imagens dos distintivos nativos do Discord ao lado do @. A
fonte principal é a consulta visual opcional feita com
`DISCORD_BIO_CHECK_USER_TOKEN` — o token de uma **conta secundária** já usado na
verificação de bio. Ela mostra as mesmas imagens do cliente, incluindo Nitro,
boost e insígnias antigas, porque lê o perfil como aquela conta. É somente
exibição: não concede cargos, não altera permissões, não grava o token e usa
sempre o ID do próprio membro logado, no servidor selecionado.

Essa consulta usa uma API não oficial: pode falhar ou expor a conta secundária a
punições. Se falhar, o site mantém os flags públicos da API oficial. Resultados
ficam em cache por 5 minutos (falhas, 1 minuto) e
`WEB_PROFILE_BADGES_USER_LOOKUP_ENABLED=false` desliga apenas a exibição visual,
sem afetar a verificação de bio.

Alternativa oficial: Nitro depende do escopo `identify.premium`, restrito a
parceiros aprovados pelo Discord. Só após essa aprovação configure
`DISCORD_IDENTIFY_PREMIUM_ENABLED=true` e faça um novo login para consentir a
consulta. O padrão permanece `false` para não interromper a autenticação. O site
guarda apenas tipo e data da confirmação, não tokens, e exibe o distintivo por
até 12 horas. Nenhuma insígnia é deduzida pelo avatar ou banner.

### Seleção e permissões

Após o login, a interface detecta os servidores em comum entre a conta e o bot
e pergunta **“Onde você quer postar?”**. A escolha está disponível para qualquer
membro, sem exigir cargo administrativo. O botão **Trocar servidor** permite
escolher outra comunidade; o formulário também mostra o destino antes do envio.
Servidores sem Instagram configurado ou em manutenção recebem um aviso.

Histórico, limites, restrições, notificações e administração são separados por
servidor. As configurações de cada comunidade são aplicadas aos seus próprios
envios. O bot verifica novamente a participação e as permissões antes de publicar;
sair do servidor não redireciona a fotografia para outra comunidade.

Configure primeiro o sistema existente usando `!instagram`. O portal utiliza
o destino da comunidade escolhida, que também pode ser configurado pelo seletor
de servidores na administração web. O usuário deve ser membro do destino e
poder visualizar seu canal. Pelo site, não é necessário ter acesso ao canal de
envio, enviar mensagens/anexos no Discord, participar do servidor de origem ou
concluir a verificação por ticket. Isso não altera as permissões dos canais no
Discord. Moderação, restrições, limites e políticas configuradas no portal
continuam sendo aplicados, inclusive antes da entrega.

Permissões específicas do bot no destino:
**Ver Canal, Enviar Mensagens, Anexar Arquivos, Ler Histórico**.
Para criar/administrar canais e outras funções antigas, mantenha as permissões
já documentadas pelo bot. O portal não exige Administrator para o bot.

Proprietário do servidor ou membro com **Administrator efetivo** recebe
administração completa. Nomes de cargo não concedem acesso. Cargos moderadores
configurados têm acesso operacional, mas não às configurações críticas.
VIP altera somente limite/cooldown; não desativa a moderação.

Configurações do portal: canal, logs privados, cargos autorizados/proibidos,
moderadores e VIP, limites, tempo mínimo no servidor, legenda/@, manutenção,
revisão adicional, palavras para revisão, identidade visual e regras do **site**.
Campos desconhecidos, incluindo opções de layout ou desativação da OpenAI,
são rejeitados pelo schema estrito.

## Pipeline de segurança

1. Login, participação, permissões, restrições, CSRF e rate limits.
2. Até cinco arquivos, no máximo 10 MiB cada e 24 MiB finais por envio.
3. Extensão, MIME e assinatura devem corresponder.
4. Sharp deve decodificar: somente JPEG, PNG e WebP estático; sem SVG, HTML,
   GIF, vídeo ou HEIC.
5. Máximo de 25 milhões de pixels / 12 mil pixels por dimensão; saída JPEG de
   até 4096 × 4096, orientação corrigida e metadados removidos.
6. Nomes aleatórios, SHA-256 dos bytes finais, armazenamento privado com
   permissões restritas. Duas preparações de upload no máximo.
7. Admissão transacional, chave de idempotência, cooldown, limite diário, máximo
   de duas pendências e deduplicação das fotografias recentes do próprio autor.
8. Worker persistente, uma publicação por vez, analisa cada imagem e o texto
   pela API oficial `omni-moderation-latest`.
9. Política `web-omni-v1`: flags/categorias oficiais e tipos suportados; não usa
   um limiar arbitrário de pontuação nem um detector de pele.
10. Flags proibidas recusam; resultados inconclusivos/erros não aprovam.
    Regras adicionais ou aprovação manual extra só recebem imagens que já
    passaram pela análise obrigatória.
11. Nova checagem de permissões, limites e integridade antes da chamada ao
    mesmo publicador do Instagram.
12. Recibo no banco, notificação interna, progresso real via polling enquanto
    houver tarefas ativas. Percentual é mostrado apenas no upload real.

429, timeouts e 5xx têm tentativas limitadas e backoff. O cliente compartilhado
faz retries de transporte; a fila faz até quatro execuções. Falhas finais
elegíveis podem ser tentadas novamente pelo autor enquanto os arquivos existirem.
Nenhuma falha transforma uma imagem não analisada em aprovada.

Suspeitas graves são bloqueadas sem possibilidade de liberação comum, sem
galeria administrativa, exportação de imagens ou cópias em logs. Não há
reconhecimento facial nem alegação de certeza sobre idade ou consentimento.
A administração precisa definir o procedimento jurídico/especializado aplicável
à sua comunidade; o software não automatiza investigações ou denúncias legais.

## Entrega, reinícios e reconciliação

A tarefa é marcada antes de cada fase. Reinícios recuperam análises pendentes.
Um envio interrompido ao Discord vira `uncertain`: **não é reenviado
automaticamente**, pois a API pode ter recebido a mensagem antes da conexão cair.
O nonce do publicador continua sendo utilizado, mas sua janela curta não é
tratada como garantia permanente de exactly-once.

O painel permite **Conferir entrega**: informe o ID de uma mensagem já existente
e um motivo. O backend exige aprovação válida e confere bot emissor, autor,
nomes dos arquivos, legenda e IDs dos quatro botões antes de vincular a mensagem.
Isso não publica nem libera conteúdo novo. Se não existir mensagem confirmável,
apague/cancele a tarefa e investigue; não force o banco para reenviar.

Exclusões via portal removem a mensagem e atualizam os registros. O evento
`messageDelete` sincroniza exclusões observadas enquanto o bot está conectado.
Exclusões ocorridas durante um período offline podem exigir conferência manual.
O estado legado do Instagram continua sendo preservado.

Edições de legenda/@ passam novamente pela análise antes de alterar a mensagem.
Para evitar baixar novamente arquivos arbitrários, edições exigem os bytes
privados originais e ficam disponíveis por até sete dias.
Uma edição recusada não substitui a mensagem original já presente no Discord;
o histórico registra a tentativa recusada e conserva o link da mensagem anterior.

## Privacidade e retenção

- Fotos recusadas: descartadas imediatamente após a decisão.
- Fotos aprovadas/em revisão/falhas/entrega incerta: limpeza após sete dias,
  executada na inicialização e a cada hora.
- Arquivos órfãos de uma gravação interrompida: removidos após uma hora.
- Sessões expiradas: limpas; notificações: 30 dias; eventos/auditoria: 90 dias.
- Histórico de publicações e referências de moderação: preservados no SQLite;
  atendimentos de eliminação de dados devem ser processados pela administração.
- Sem IPs crus persistidos: rate limit em memória com chave hash.
- Backups também contêm dados pessoais e exigem acesso restrito e prazo de
  retenção definido pelo operador.

Imagens privadas não ficam sob a raiz estática. Imagens de revisão só podem ser
abertas por moderador autorizado, com registro de acesso; conteúdo grave não
está acessível nem por esse endpoint. URLs de miniatura exigem sessão e autoria.
As páginas legais incluídas são uma base técnica: complete o canal de contato do
controlador e revise termos/retenção com o responsável por LGPD antes de publicar.
Não se promete apagar cópias já obtidas por outros membros/Discord.

## Hospedagem em VPS / HTTPS

1. Aponte um registro DNS para a VPS e configure firewall: somente 80/443 e SSH
   restrito; não exponha SQLite, armazenamento, portas de desenvolvimento ou 3000.
2. Instale Node 24 e execute com um supervisor, **ou** use o Docker fornecido.
3. Configure Nginx no host usando `deploy/nginx.conf`. Substitua o domínio,
   emita certificados com Certbot e habilite renovação automática.
4. `APP_URL` e Redirect URI precisam corresponder ao HTTPS público.
5. Configure `WEB_TRUST_PROXY` apenas com os IPs/CIDRs do seu proxy.
   Nginx deve sobrescrever `X-Forwarded-For`.
6. No Docker, a rede dedicada usa `172.30.0.0/24`; somente o gateway
   `172.30.0.1/32` é confiável. Ajuste ambos se houver conflito de sub-rede.
7. Confira `/api/health`, `/api/status`, login, upload legítimo, recibo no canal,
   exclusão e perda de permissões usando contas de teste autorizadas.

### Docker sem perder o estado existente

Pare primeiro a instância antiga. Faça backup consistente do SQLite e dos
arquivos legados. Crie `state/`, copie **seus arquivos existentes** `data.json`
e `role-history.json` para ele. Não sobrescreva um estado mais novo.
O volume `./database` reutiliza o banco original; ajuste `CALL_STATS_FILE` e os
mounts se ele estiver em outro caminho. No Linux, dê ao usuário UID 1000
permissão de gravação somente nos diretórios de estado/banco/logs.

```sh
docker compose build
docker compose up -d
docker compose logs --tail=100 bot
```

Só uma instância HTTP/worker deve manipular este SQLite. Escala horizontal
exigiria uma migração explícita para fila/banco coordenados; esta entrega não
finge oferecer coordenação distribuída.

O supervisor do bot permite cinco segundos para encerramento. Se uma requisição
externa ultrapassar essa janela, a recuperação persistente trata o reinício sem
reenviar entregas ambíguas. O hook novo fecha HTTP/worker antes do banco.

## Backup e recuperação

Em Node 24:

```sh
npm run web:backup -- /caminho/privado/snapshot
```

O script usa `node:sqlite.backup`, incluindo o WAL de maneira consistente.
Para um snapshot completo, pare o bot e copie também `state/`/arquivos legados,
configurações secretas criptografadas e armazenamento privado, caso seja
necessário preservar tarefas pendentes. Criptografe o backup e restrinja acesso.
Não copie apenas o `.sqlite` de um banco ativo ignorando WAL/SHM.

Para recuperar, pare todas as instâncias, restaure o banco e o estado do mesmo
snapshot, recoloque as permissões e inicie uma única instância. Tarefas em análise
são retomadas; entregas ambíguas ficam em conferência. Não restaure backups
antigos por cima de dados novos sem avaliar os registros de entrega no Discord.

## Testes

```sh
npm test
npm run web:check
npm run web:build
npm --prefix instagram-web/frontend exec -- playwright install chromium
npm run web:e2e
```

Os testes unitários/integração usam SQLite em memória, fotografias sintéticas
legítimas, HTTP Fastify real e mocks de Discord/OpenAI. Testes de violações graves
usam somente flags simuladas — nenhum material ilegal é criado/coletado.
Playwright usa Chromium desktop/mobile e o backend real com um fixture isolado
e sem segredos. O fixture não é importado pelo código de produção.
Os testes de layout comparam o payload da entrada antiga e o da entrada web.

Não foram feitos login OAuth real, publicações no seu servidor, uso da sua
OpenAI, implantação Docker/VPS ou auditoria externa de segurança. Configure e
valide essas integrações antes de considerar a instalação pronta para público.

## Escopo e extensões não incluídas

O fluxo principal é real: autenticação, permissões, envio, moderação, publicação,
histórico, edição/exclusão, perfil, notificações, denúncias, revisão adicional,
administração, configurações, auditoria e implantação.

Não há botões simulando recursos futuros. Não foram implementados os opcionais
de feed público/interno, favoritos, ranking web, agendamento, HEIC, OCR, CAPTCHA,
outros perfis sociais, campos música/categorias, tradução ou DMs do portal.
O recorte disponível é quadrado central, não um editor de enquadramento livre.
A área administrativa concentra o histórico recebido pelo portal; não importa
automaticamente todo o legado para a fila web. Limites específicos são por plano
comum/VIP; uma interface completa de exceções individuais, horários de operação,
gráficos avançados, notas de moderação e busca global de membros do Discord não
foram adicionadas. A gestão existente no Discord continua operando separadamente.

Esses itens são limitações explícitas, não funcionalidades escondidas, vazias
ou habilitadas sem implementação.
