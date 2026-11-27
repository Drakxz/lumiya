# Contribuindo

Obrigado por ajudar a manter a Lumiya. Este documento descreve o fluxo seguro
de desenvolvimento; a instalação ativa na AWS é operada pelo mantenedor.

## Antes de começar

```sh
npm ci
cp .env.example .env
# preencha apenas o necessário; nunca commite o .env
npm test
```

Requisitos: Node >= 22.13.0, dependências de sistema para canvas/FFmpeg e um
bot de teste em servidor próprio. **Não inicie o bot local enquanto a instância
AWS estiver ativa** — isso duplica respostas e cria estados divergentes
([MIGRACAO-AWS.md](MIGRACAO-AWS.md)).

## Branches

- `main` — código estável, protegido por PR.
- `feat/<descricao>` — funcionalidades.
- `fix/<descricao>` — correções.
- `docs/<descricao>` — documentação.
- `refactor/<descricao>` — mudanças internas sem alterar comportamento.

Crie branches a partir de `main` atualizado. Não faça push direto na `main`.

## Convenção de commits

Use Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`refactor:`, `perf:`. Exemplo: `fix(nuke): adiciona lock contra execução
concorrente`.

## Antes de abrir o PR

```sh
npm run lint
npm run format:check
npm test
npm run web:check   # se mexeu no portal
npm run web:build   # se mexeu no portal
npm audit
```

Checklist:

- [ ] A mudança preserva funcionalidades, personalidade e aparência existentes.
- [ ] Novas tabelas filtram por `guildId`; novos handlers validam guild/canal.
- [ ] Nenhum segredo, `.env`, banco, log, upload ou chave foi adicionado.
- [ ] `customId`s, textos de slash commands e emojis institucionais intactos.
- [ ] `DESIGN.md`/`ARCHITECTURE.md` atualizados quando aplicável.
- [ ] Testes novos ou ajustados para o comportamento alterado.

## Segurança

Nunca cole tokens, bodies de API, logs completos ou dados de membros em issues
e PRs. Use [SECURITY.md](SECURITY.md) para reportar vulnerabilidades. O deploy
na AWS **somente** é feito pelo mantenedor, após autorização explícita, com
backup e verificação de saúde do serviço.

## Estrutura

Leia [ARCHITECTURE.md](ARCHITECTURE.md) antes de criar um módulo: ele explica
onde registrar comandos, eventos, sistemas e painéis, e quais invariantes devem
ser respeitados.
