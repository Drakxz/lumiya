# Login nativo com Discord Social SDK (especificação)

Objetivo: o usuário toca em **Entrar com Discord** em um aplicativo nativo, a autorização acontece dentro do aplicativo oficial do Discord (celular) ou no overlay/cliente (desktop), e o aplicativo retorna ao site já autenticado.

> Estado: **suporte de servidor existente, integrações do SDK escritas e configurações de projeto Android/Gradle e iOS/XcodeGen em `native-app/`**. As integrações nativas ainda não foram compiladas nem testadas em aparelhos. Faltam os binários oficiais do SDK, toolchains e assinatura. Consulte `native-app/README.md` para instalação, build e validação. O login web permanece inalterado; nenhum APK/IPA foi gerado ou publicado.

## Por que o site não faz isso sozinho

Para escopos de conta (`identify`), o Discord **não** abre o link `discord.com/oauth2/authorize` dentro do aplicativo quando ele vem de um site. O próprio Discord explica que não deep-linka esse fluxo porque não consegue devolver o usuário ao navegador/tab correto com o `state`, os cookies e o `code_verifier`. O deep link funciona só para bot/comandos e para apps nativos que usam o Social SDK com redirect próprio.

## Pré-requisitos no Discord Developer Portal

1. Aplicação com **Social SDK habilitado**.
2. Em **OAuth2 → Redirects**, cadastrar:
   - Celular (iOS e Android): `discord-SEU_CLIENT_ID:/authorize/callback`
   - Desktop: `http://127.0.0.1:<porta>/callback` (a porta é escolhida pelo app nativo)
3. `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET` já configurados no `.env` do servidor — o segredo continua **apenas no servidor**.
4. No projeto nativo: registrar o URL scheme `discord-SEU_CLIENT_ID` (iOS `Info.plist` / Android `intent-filter`) e, no iOS, incluir `discord` em `LSApplicationQueriesSchemes`.

## Fluxo

1. O app cria um par PKCE (verifier aleatório de 32 bytes em base64url; challenge = `BASE64URL(SHA256(verifier))`).
2. O app chama `Client::Authorize` com `client_id`, escopo `identify`, `code_challenge` e `code_challenge_method=S256`.
3. O SDK abre o aplicativo oficial do Discord se ele estiver instalado e logado; caso contrário, abre o navegador. O usuário vê a tela de autorização e confirma.
4. O SDK devolve `code` e o `code_verifier`. No desktop, o redirect é o loopback; no celular, o custom scheme.
5. O app envia `code` e `code_verifier` ao servidor em `POST /api/auth/native/exchange` (não guarda token).
6. O servidor troca o código na API oficial do Discord usando o `client_secret`, valida o usuário, revoga o token e cria um **ticket de login de uso único** com validade de 5 minutos.
7. O app abre `https://3.12.169.220.nip.io/api/auth/native/consume?ticket=...` no navegador do sistema (ou WebView do app).
8. O servidor consome o ticket, cria a sessão HttpOnly/SameSite=Lax/Secure e redireciona para `/app`.

Nenhum access token ou refresh token é devolvido ao app ou colocado na URL. O ticket é aleatório, de uso único e armazenado apenas como hash.

## Contrato do servidor

### `POST /api/auth/native/exchange`

Corpo JSON estrito:

```json
{
  "code": "código_devolvido_pelo_sdk",
  "codeVerifier": "verifier_base64url_de_43_a_128_caracteres",
  "redirectUri": "discord-1569908118698332191:/authorize/callback"
}
```

`redirectUri` é opcional; sem ele, usa o custom scheme do celular. No desktop, envie o loopback exato usado no SDK. Resposta `200`:

```json
{ "url": "/api/auth/native/consume?ticket=..." }
```

Erros: `400` corpo/redirect inválidos, `401` autorização recusada pelo Discord, `404/410` link inválido no consume.

### `GET /api/auth/native/consume?ticket=...`

Consome o ticket uma vez, define o cookie `iw_session` e responde `302` para `/app`. Não requer sessão nem CSRF: a posse do ticket é a prova. Falha se expirado ou já usado.

## Responsabilidades do app nativo

- Usar o SDK oficial, não reimplementar OAuth com WebView escondida.
- Nunca embutir `client_secret`.
- Nunca logar `code`, `code_verifier`, token ou ticket.
- Abrir a URL devolvida no navegador do sistema para o cookie ser criado no domínio do site.
- Tratar ausência do app Discord, usuário sem login no app, autorização negada e rede indisponível.
- No desktop, se o overlay estiver desativado, o SDK mostra a autorização na janela do cliente Discord.

## Limitações atuais

- Não há como transformar o site em app nativo: é preciso compilar e distribuir um binário por plataforma.
- O fluxo de celular depende de SDK 1.5+ e do redirect `discord-ID:/authorize/callback` cadastrado.
- Se o Discord não estiver instalado, o SDK faz fallback para navegador — nesse caso a experiência volta a ser a do site.
