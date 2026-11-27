# CL — limpeza pessoal de mensagens

## Ativar

O CL funciona em qualquer canal de servidor que possua histórico de mensagens e em que o bot tenha as permissões necessárias, incluindo threads. Não é necessário configurar IDs. A variável antiga `CL_CHANNEL_IDS` não é mais utilizada. Reinicie o bot com `node .` para aplicar.

O bot precisa de **Gerenciar Mensagens**, **Ler Histórico de Mensagens**, **Ver Canal** e **Adicionar Reações** nesses canais. A intent Message Content já existe no código e deve continuar ativada no Developer Portal. Não há novas dependências.

## Uso

Digite apenas `cl`. Maiúsculas/minúsculas e espaços ao redor são ignorados. `clear`, `cl teste` e frases não ativam a função. Comandos de bots e DMs são ignorados.

**Qualquer membro:** apaga suas próprias mensagens.

**Administradores:** podem responder à mensagem de outra pessoa e escrever `cl`, ou mencionar a pessoa (`cl @nome`). Nesses casos a limpeza é feita nas mensagens do autor alvo, e a mensagem respondida também é apagada junto com o comando. A resposta tem prioridade sobre a menção. Usuários comuns que responderem ou mencionarem alguém continuam limpando apenas as próprias mensagens.

O bot tenta reagir com 💩 e busca as mensagens anteriores ao comando, apagando exclusivamente mensagens do autor selecionado naquele canal. Usa a busca oficial do Discord filtrada por autor e canal, em vez de percorrer as mensagens de todos os outros participantes. A exclusão do comando é iniciada imediatamente e tentada novamente ao terminar se necessário, mesmo se a busca falhar. Comandos `cl` repetidos para o mesmo alvo/canal são incorporados ao mesmo trabalho, inclusive entre administradores diferentes, sem outra varredura. Mensagens novas enviadas depois do comando original não são incluídas, exceto esses comandos repetidos.

A busca usa páginas de até 25 resultados e paginação por `max_id`, não offset:
as exclusões não fazem pular resultados. Páginas curtas e `total_results` não
encerram a consulta. A página mais recente do histórico é verificada para cobrir
atrasos de indexação. Se o índice estiver indisponível ou incompleto, o bot
volta à varredura completa em páginas de 100, sem perder a limpeza antiga.
A busca usa apenas o token do bot pelo rate limiter do discord.js.

Não há confirmação, painel ou embed. Falhas são registradas somente no terminal. A reação 💩 e a exclusão do comando não bloqueiam o início da limpeza. A busca avança enquanto o lote anterior é apagado; até três páginas podem contribuir para um bulk de até 100 mensagens do alvo. Exclusões individuais usam até oito workers contínuos: um pedido lento não segura os demais.

As primeiras mensagens do alvo já presentes no cache do canal (até 100) são
apagadas sem esperar a consulta do histórico. IDs são validados por canal,
autor e momento do comando e não são reenviados na varredura. Sem cache, a
primeira página com pelo menos duas mensagens do alvo já inicia um lote, sem
aguardar outras páginas. O restante continua sendo agrupado para reduzir pedidos.

Cada execução registra apenas IDs, quantidade, páginas consultadas e tempos do
primeiro lote/total, sem conteúdo das mensagens. Na AWS:

```sh
sudo journalctl -u mds-bot --since=-10min --no-pager --grep=CL
```

## Segurança e limites

- Atua somente no canal onde o usuário enviou `cl`, sem alteração de canais, categorias, cargos ou outros recursos.
- Mensagens recentes usam bulk com IDs filtrados por autor e canal; mensagens antigas ou no limite de 14 dias são apagadas individualmente.
- Mensagens já excluídas são ignoradas. Perda de acesso/permissões ou exclusão do canal interrompe o trabalho sem derrubar o bot.
- Sem esperas artificiais: reação, exclusão do comando e busca começam sem aguardar umas às outras. Há apenas um lote de exclusão ativo (até 100 mensagens), um lote sendo preparado e uma página de busca, sem carregar o histórico inteiro. O discord.js controla as filas e os rate limits da API.
- Perda de permissões interrompe novos lotes; requisições já em voo são aguardadas antes de liberar a trava.
- A duração depende do volume, idade das mensagens e limites do Discord; milhares de mensagens não são apagadas instantaneamente.
- A exclusão é permanente. Todos os usuários podem apagar as próprias mensagens nos canais em que o bot possui as permissões necessárias. O CL não cria backups.
