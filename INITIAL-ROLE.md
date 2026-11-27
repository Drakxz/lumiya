# Cargo inicial automático

Use **`!cargoinicial`** ou **`!autorole`** com **Gerenciar Servidor** e
**Gerenciar Cargos**.

1. Selecione um cargo no painel.
2. Clique **Ativar**.
3. Escolha se também deve ser aplicado a bots (padrão: sim).

A configuração é por servidor, fica no SQLite e acompanha os novos IDs de
cargos ao restaurar/importar backups. Selecionar outro cargo desativa o sistema
até nova confirmação em **Ativar**. **Remover configuração** desativa e limpa
o cargo selecionado, sem remover cargos de membros existentes.

Somente novas entradas recebem o cargo; não aplica em massa a membros antigos.
Se o servidor tiver triagem de membros, a atribuição espera a aceitação das
regras, sem contornar a triagem.

A MDS precisa de **Gerenciar Cargos**, com seu cargo acima do cargo inicial,
e do intent **Server Members / Guild Members** ativado no Developer Portal.
O cargo deve ser comum, do mesmo servidor, abaixo do configurador (exceto o
proprietário) e sem permissões administrativas/moderadoras. Essas condições
são verificadas novamente na entrada de cada membro.

A atribuição é feita pela própria MDS, portanto não é removida pela proteção
contra cargos externos. O histórico de cargos registra a operação, inclusive
no canal de adições configurado. Falhas ficam no log do processo e na tabela
`initial_role_events`, sem derrubar o bot.
