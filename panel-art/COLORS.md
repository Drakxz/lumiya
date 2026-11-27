# Cor dos painéis

Use `!corpainel` no servidor. O comando e os controles exigem a permissão
**Administrador**, verificada novamente em cada interação. O painel é vinculado
ao autor e ao servidor e expira após 10 minutos.

- **Alterar cor:** abre um formulário com um código hexadecimal de seis dígitos.
- **Restaurar padrão:** volta para `#C4A7E7`.
- A barra lateral do próprio painel é a prévia da cor salva.

A configuração fica na tabela SQLite `panel_colors`, no banco ativo do bot,
separada por servidor. Reinícios não apagam a preferência.

Os painéis de suporte, migração, boas-vindas, Instagram, jogos e unmute usam
`applyPanelAppearance`; UP e Central de Comandos usam `panelColor`.
Novos painéis gerais devem usar uma dessas funções. Cores de erros, punições,
logs e publicações dos membros não são substituídas.

A alteração é aplicada ao próximo envio ou atualização do painel. Mensagens
antigas não são editadas em massa.

## Superfície

Modo: operação, dentro do Discord. Mantém os componentes nativos e o estilo
dos painéis existentes. Uma única prévia, valor atual e padrão explícitos,
duas ações nomeadas, entrada validada e resposta de recuperação quando a
sessão ou permissão não é mais válida. Sem mudanças no portal web.
