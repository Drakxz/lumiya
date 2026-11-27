# Banimentos

Publique o painel permanente com `!banpainel` em um canal privado da moderação.
Exige **Gerenciar Servidor** e **Banir Membros**. Os botões abrem formulários e
confirmações pessoais; só quem tem **Banir Membros** pode operar.

- `!ban @membro motivo` ou `/ban usuario:ID motivo:...`
- Responda à mensagem da pessoa com `!ban motivo` para selecionar o autor dela.
- `!desbanir ID motivo`, `!unban ID motivo` ou `/desbanir`
- `!unban all motivo`, `!desbanir todos motivo`, `!unbanall motivo` ou `/unbanall motivo:...`
  desbane todos, exigindo **Administrador**, **Banir Membros** e **Gerenciar Servidor**.
- `!ban` sem argumentos e sem responder a uma mensagem abre os controles.
- `!limitebans` configura o limite semanal de banimentos por cargo
  (**Gerenciar Servidor**).

O painel usa ícones personalizados selecionados visualmente entre os 49 emojis
do servidor FEZES. Em outros servidores, omite ícones externos indisponíveis.
Usa Components V2, fundo neutro e respostas privadas nas interações.

## Identidade visual

Painel em card minimalista, com título em destaque, uma descrição curta e quatro
botões alinhados embaixo, sem lista de ações. Ícone do servidor, avatar do usuário
quando disponível e motivos destacados em bloco de citação. Confirmação, resultado,
cancelamento, erros, histórico e logs seguem a mesma estrutura de títulos e divisórias.
Sucesso usa um verde discreto; erros usam vinho suave e o X animado padrão do bot.
Cancelamentos e registros ainda pendentes não são apresentados como erros.
Os formulários incluem descrições e exemplos nos campos.

Cada operação exige confirmação do próprio moderador em até cinco minutos.
Permissões e hierarquia são consultadas novamente antes da execução. Não é
permitido banir o dono, o próprio moderador, o bot ou membros de cargo igual/superior.
O bot também precisa de **Banir Membros** e cargo acima do alvo.

Por padrão, mensagens não são apagadas. No formulário é possível escolher
de 0 a 168 horas de mensagens a excluir junto ao banimento.

## Limite semanal por cargo

Um administrador com **Gerenciar Servidor** executa `!limitebans`
(aliases `!limitebanimentos` e `!banslimite`) ou usa o botão **Limites** no
painel de banimentos. Escolha um cargo no menu e informe quantos banimentos ele
pode aplicar por semana; use `0` para remover o limite daquele cargo.

- Vale o cargo configurado **mais alto** que o moderador tiver.
- Cargos sem configuração não restringem. Sem nenhum cargo configurado, não há
  limite semanal.
- A semana vai de segunda-feira 00:00 a domingo 23:59 no horário de Brasília.
- Contam apenas banimentos concluídos pelo bot na semana. Falhas, desbanimentos,
  banimentos antigos e ações de outros moderadores não contam.
- O limite é conferido ao abrir a confirmação e novamente antes de executar.
  Duas confirmações simultâneas do mesmo moderador são serializadas, então o
  limite não é ultrapassado por clique duplo ou abas concorrentes.
- A confirmação e o recibo após o banimento mostram
  **“Já usou X de Y · ainda pode dar Z”**, com a data de renovação.
- Ao atingir o limite, a ação é recusada antes de enviar DM, registrar banimento
  ou alterar o histórico.
- O mesmo placar aparece no log privado `logs-banimentos`, para a equipe
  acompanhar o uso semanal.

## Mensagens temporárias

O card de confirmação expira em cinco minutos. Depois de confirmar, cancelar ou
receber um erro, o card no canal é apagado **30 segundos** após a resposta.
O log privado em `logs-banimentos` e o aviso privado por DM não são apagados:
são o registro durável da operação. O histórico continua disponível pelo botão
**Histórico** e pela ficha do usuário.

## Notificação privada

Após a confirmação do moderador, o bot envia o card privado **antes de banir**,
enquanto ainda compartilha o servidor com o membro. Inclui ícone e nome do
servidor, motivo destacado, data/hora em Brasília e referência da operação.
O aviso inicial informa que a solicitação está em andamento; após a resposta
do Discord, a mesma DM é atualizada para banimento concluído ou solicitação
não concluída. Não expõe histórico da equipe nem botões administrativos.

Há uma única tentativa de envio por operação: DMs fechadas/indisponíveis não
impedem o banimento, e o resultado aparece para a moderação e no log.
Se a atualização da DM falhar, o aviso inicial não afirma que o banimento
foi executado. Cancelamentos não enviam avisos.
Permissões e hierarquia são verificadas novamente depois do envio da DM.

Após um **desbanimento concluído**, individual ou em massa, o bot tenta enviar
um card verde por DM com servidor, motivo, responsável, data e registro.
O aviso explica que a pessoa pode retornar com um convite válido; não cria convites
nem adiciona a conta automaticamente. DMs fechadas ou ausência de servidor em
comum podem impedir o envio, sem desfazer o desbanimento.

## Desbanir todos

Use `!unban all motivo` (também `!unban todos`, `!desbanir all`,
`!desbanir todos`, `!unbanall`, `!desbanirtodos`) ou `/unbanall motivo:...`.
O motivo é obrigatório, com até 400 caracteres.
É necessário ter a permissão **Administrador**, inclusive nos aliases de prefixo.
Ela é verificada novamente na confirmação e antes de cada conta do lote.

- A confirmação mostra a quantidade total e exige o clique do próprio solicitante
  em até cinco minutos. Cancelar não remove banimentos nem envia DMs.
- A lista completa é consultada com paginação. Somente as contas selecionadas
  na confirmação entram no lote; novos banimentos ficam de fora.
- O bot processa uma conta por vez, respeitando os limites da API do Discord.
  Permissões são verificadas novamente antes de cada desbanimento.
- Apenas um lote por servidor pode rodar por vez; outras confirmações de
  banimento/desbanimento aguardam uma nova solicitação após o término.
- Cada sucesso fica salvo individualmente no histórico. Uma conta já desbanida
  é contabilizada separadamente e não recebe DM. Falhas de permissão interrompem
  o lote; falhas individuais não impedem os próximos usuários.
- O card mostra progresso e resumo: desbanidos, falhas, já desbanidos,
  não processados e DMs entregues/não entregues. O log privado recebe um resumo
  do lote, sem inundar o canal com um card por pessoa.
- Se o bot reiniciar, o lote não é retomado automaticamente. Em operações slash
  muito longas, o token do Discord pode expirar após 15 minutos e impedir novas
  edições do card; o histórico e o resumo no log continuam sendo registrados.

Ao responder a uma mensagem, o bot verifica se ela pertence ao mesmo canal e
servidor. Se tiver sido apagada ou estiver inacessível, pede uma menção ou ID,
sem adivinhar o alvo. Uma menção ou ID explícito prevalece sobre a resposta.
A confirmação e todas as verificações de permissão e hierarquia continuam obrigatórias.

As operações e seus resultados ficam no SQLite compartilhado. O botão
**Histórico** mostra as últimas oito operações do servidor. Registros pendentes
após uma interrupção não são executados automaticamente: confira o Discord.

Em `!ficha ID` e `/ficha`, a aba **Banimentos** consulta esse mesmo histórico,
filtrado pelo usuário e servidor, com data, hora, motivo, responsável, resultado
e detalhes. Possui filtros e paginação independentes da aba **Cargos**.
Segue as permissões da ficha, sem exigir **Banir Membros** para consultar.
As abas atualizam o mesmo painel: privado no slash, visível no canal no prefixo.
A permissão de **Banir Membros** continua obrigatória para executar punições.

Ao iniciar, o sistema de logs cria `logs-banimentos` dentro da categoria privada
**amex** e o conecta automaticamente. O bot precisa de **Gerenciar Canais**.
Falhas de envio dos logs não desfazem ações já concluídas.
