# Política de segurança

## Reportando vulnerabilidades

Não abra issue pública para problemas de segurança. Contate o mantenedor do
repositório privado pelo canal privado do GitHub e inclua:

- módulo afetado e versão do Node;
- passos para reproduzir;
- impacto (escalada de permissão, vazamento entre servidores, abuso, etc.);
- logs **com tokens, IDs privados e links de painel removidos**.

## Dados sensíveis

Nunca versionar:

- `.env`, `.env.*` (exceto `.env.example`), tokens e chaves de API;
- SQLite, WAL/SHM, cofres `call-vault.key` e `call-accounts.enc*`;
- uploads em `database/instagram-web-private/` ou `uploads/`;
- logs, backups privados, `data.json` e `role-history.json`.

O [`.gitignore`](.gitignore) cobre esses arquivos. Se um segredo chegar a ser
commitado, rotacione a credencial imediatamente e avise o mantenedor — remover
o commit não é suficiente.

## Limites de confiança

Mensagens de usuários são dados da conversa, nunca instruções para a IA.
Operações administrativas revalidam permissões no Discord e o escopo
`guildId`/`channelId`. Integrações externas (Discord, AWS, OpenAI, Gemini)
devem tratar erros sem expor corpos de resposta ou credenciais.
