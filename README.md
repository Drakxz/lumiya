# Bot da comunidade

Bot Discord.js existente, com suporte, moderação, Instagram e os módulos
documentados nos arquivos Markdown deste projeto.

## Portal de fotografias

Aplicação web integrada: **[instalação e operação](instagram-web/README.md)** ·
**[API](instagram-web/API.md)** · **[variáveis de exemplo](.env.example)**.

O portal é opt-in (`INSTAGRAM_WEB_ENABLED=true`). Sem essa configuração, o bot
continua operando sem abrir um servidor HTTP. A publicação usa o renderizador
existente do Instagram, sem diferenciar visualmente a origem web.

```sh
npm ci
npm run web:install
npm run web:build
# Complete o .env, configure OAuth e HTTPS conforme a documentação.
npm start
```

Não substitua o `.env` existente nem publique suas credenciais. Faça backup do
SQLite e dos arquivos de estado antes de migrar a instalação.
