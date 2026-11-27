# Login nativo — Android e iOS

Código de integração do Discord Social SDK: **aplicativo nativo → Discord → site autenticado no navegador**.
Não é um APK/IPA pronto. A compilação e o login real ainda precisam ser validados:
os binários oficiais do SDK, Android SDK/NDK, Xcode e assinaturas não estão incluídos.
O botão do site continua usando OAuth web até haver aplicativos compilados e distribuídos.

## Configuração no Discord

1. Habilite o Social SDK na aplicação pelo [Developer Portal](https://discord.com/developers/applications).
2. Cadastre **exatamente** `discord-1569908118698332191:/authorize/callback` em OAuth2 → Redirects.
3. Baixe o **SDK C++ 1.9 ou posterior**, com os pacotes para Android e iOS. O fluxo mobile existe desde 1.5; os projetos usam C++20, conforme a documentação atual.
4. Mantenha o client secret somente no servidor. Não habilite Public Client para este fluxo: o servidor já faz a troca confidencial.

Coloque os arquivos oficiais nestes caminhos (não entram no controle de versão):

```text
native-app/sdk/
  include/                         # todos os headers oficiais, inclusive discordpp.h
  android/discord_partner_sdk.aar   # pacote oficial com Prefab e classes Java
  ios/discord_partner_sdk.xcframework/
```

Não substitua as bibliotecas por mocks. Execute `node native-app/check.mjs` para verificar arquivos e configuração.
Esse comando **não** compila nem comprova o funcionamento do login.

## Android

Requisitos: Android Studio, **JDK 17**, **Gradle 8.9**, Android SDK 35, NDK com C++20 e CMake 3.22.1.

1. Abra `native-app/android` no Android Studio.
2. Instale SDK/NDK/CMake pelo SDK Manager e configure o SDK em `local.properties` se necessário.
3. Confirme que o AAR oficial tem suporte ao ABI `arm64-v8a` (configuração atual).
4. Na pasta `native-app/android`, compile com uma instalação de Gradle 8.9:

   ```sh
   gradle :app:assembleDebug
   ```

   O repositório não inclui Gradle Wrapper/JAR. Use Gradle 8.9 instalado ou gere o wrapper com essa versão.

5. Instale `app/build/outputs/apk/debug/app-debug.apk` em um aparelho de teste.

`gradle.properties` centraliza `discordClientId` e `siteUrl`. O Gradle usa o mesmo ID no manifesto e no código.
O retorno OAuth pertence à **`com.discord.socialsdk.AuthenticationActivity`**, não à MainActivity.
`DiscordSocialSdkInit.setEngineActivity` é chamado antes da autorização.

O app impede logins simultâneos, executa callbacks do SDK na thread principal, permite cancelar e expira a tentativa após dois minutos.
Ao destruir a Activity, cancela a tentativa; se o Android encerrar o processo durante o login, entre novamente.
O PKCE não é persistido. Falhas de rede exigem uma nova autorização, pois códigos OAuth são de uso único.

Para distribuir, configure assinatura release em seu ambiente. Nenhuma chave de assinatura está no código.

## iOS

Requisitos: **Mac com Xcode**, **XcodeGen** e o XCFramework oficial.

1. Na pasta `native-app/ios`, execute:

   ```sh
   xcodegen generate
   open SLAFotos.xcodeproj
   ```

2. Em Signing & Capabilities, selecione seu **Team** e um Bundle Identifier autorizado.
3. Confirme `DISCORD_CLIENT_ID` e `SITE_URL` nos Build Settings gerados por `project.yml`.
4. Compile para um iPhone real. Para simular, o XCFramework precisa incluir uma slice de simulador.
5. Para distribuição, use Archive/TestFlight/App Store com sua conta Apple Developer.

O projeto inclui a ponte Swift/Objective-C++, o carregamento da tela inicial e o scheme `discord-ID`.
O SDK gerencia o callback da autorização e valida o state; o app não extrai o código diretamente de uma URL não validada.
Uma única tentativa pode ficar ativa, com cancelamento e limite de dois minutos.

## Retorno ao site

1. O SDK gera PKCE, solicita **somente `identify`** e abre o Discord se suportado/instalado.
2. Sem o Discord, o SDK pode abrir a autorização no navegador.
3. O callback entrega código, verifier e redirect real usado pelo SDK.
4. O app confere o redirect e envia os dados a `POST /api/auth/native/exchange` via HTTPS.
5. O servidor troca o código, revoga o token e devolve um ticket de uso único.
6. O app aceita somente `/api/auth/native/consume?ticket=...` na origem HTTPS configurada.
7. O navegador do sistema abre o link, recebe a sessão HttpOnly e vai para `/app`.

Nenhum client secret, access token ou refresh token é entregue ao app. Códigos/verifiers/tickets não são logados.
Os clientes recusam redirecionamentos HTTP no POST de troca e oferecem **Entrar pelo navegador** como alternativa.
Não há WebView, protocolo `discord://` improvisado ou alteração do login web existente.

## Validação necessária antes de liberar

- Android e iOS reais: Discord instalado e logado, instalado sem login e ausente.
- Autorizar → aplicativo → navegador → `/app` → seleção de servidor.
- Recusar, cancelar, repetir tentativa, rotação/recriação e encerramento do app durante a autorização.
- Sem rede, erro de servidor, timeout, certificado TLS inválido e redirect incompatível.
- Consumir ticket duas vezes e após expirar: não deve criar nova sessão.
- Telas pequenas, fontes ampliadas, TalkBack/VoiceOver e orientação horizontal.

Testes do contrato de servidor: `node --test tests/instagram-web.test.cjs`.
Eles usam respostas simuladas do Discord e não substituem a validação do SDK nos aparelhos.

O `reference-client.mjs` é somente uma ferramenta manual de diagnóstico do servidor; não é o login nativo nem parte do aplicativo distribuído.

Documentação oficial:
- https://docs.discord.com/developers/discord-social-sdk/development-guides/account-linking-on-mobile
- https://docs.discord.com/developers/discord-social-sdk/getting-started/using-c++
