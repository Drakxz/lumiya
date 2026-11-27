# Horas em call | mds

## Instalação e uso

1. Use **Node.js 22.13 ou superior** (recomendado: versão LTS atual).
2. Execute `npm install` e inicie com `npm start` ou `node .`.
3. O bot precisa conseguir ver os canais de voz monitorados e enviar mensagens/anexos nos canais de consulta. Não precisa entrar nas calls.
4. `GuildVoiceStates` já está configurada no código. Ela não exige ativação privilegiada no portal; mantenha `GuildMembers` e Message Content ativadas para os sistemas existentes.

Comandos públicos, somente em servidores:

- `!tempo` ou `/tempo`: suas estatísticas.
- `!tempo @usuário` ou `/tempo usuario:@usuário`: estatísticas do usuário selecionado.
- `!tempo ID`: também aceita um ID válido. Substitui o antigo `!horas` sem alterar o banco nem os tempos acumulados.

O comando slash é registrado no início sem substituir `/ficha` ou outros comandos. A atualização global pode levar algum tempo para aparecer.

## Dados reais

- SQLite nativo do Node, sem dependência adicional de banco.
- Arquivo criado automaticamente: `database/call-stats.sqlite`.
- Opcional no `.env`: `CALL_STATS_FILE=C:\caminho\call-stats.sqlite`.
- Chaves independentes por servidor e usuário. Todos os estados de voz visíveis ao bot são acompanhados, incluindo canais de palco e membros/bots que estejam conectados. Não há exclusão automática por AFK, quantidade de participantes ou silêncio.
- Mute = self mute **ou** server mute; os dois juntos não duplicam o tempo.
- Totais incluem as sessões em andamento até o instante da consulta, sem esperar a saída.
- Semanas: **segunda-feira 00:00 a domingo 23:59:59, Brasília (UTC−03:00)**. Sessões atravessando a virada são repartidas entre os períodos. Semanas sem registros mostram zero; os totais gerais nunca são zerados.
- Dados semanais permanecem em buckets datados. A mudança da semana é automática, sem um reset destrutivo ou dependência de um cron executar no horário exato.

## Reinícios e reconexões

Cada evento grava a transição e o tempo acumulado em uma transação. Além disso, as sessões são salvas a cada 15 segundos. Encerramentos normais por Ctrl+C/SIGTERM salvam o último trecho.

Após uma queda abrupta, preserva-se tudo o que já foi confirmado no banco; podem faltar até 15 segundos entre o último checkpoint e a queda. Ao retornar, o bot reconcilia as calls pelo estado recebido do Discord e inicia um novo trecho, sem duplicar tempo.

**O período offline não é contabilizado:** não há como saber com segurança se alguém saiu, mudou de canal ou ficou mutado enquanto o bot estava desconectado. Também não existe recuperação fictícia de horas anteriores à instalação.

## Imagens

PNG novo de **3200 × 1800** em cada consulta (cartão retangular 16:9 ampliado, com fonte, avatar e blocos maiores), renderizado por `@napi-rs/canvas`, com ícones vetoriais de alto contraste, fundo abstrato noturno original, avatar, nome atual no servidor, total geral, períodos semanais e valores vindos do SQLite. O avatar é buscado no CDN do Discord; avatares animados (`.gif`) também são aceitos, seguindo o redirect para o media proxy e desenhando o primeiro frame no PNG — se indisponível, usa a inicial real do nome como fallback. O cartão preenche o PNG para ficar centralizado no embed; o tamanho final da prévia no chat é controlado pelo Discord e depende da tela.

O envio usa um embed Discord com o PNG anexado como imagem, sem Components V2 nem cache de imagens antigas. O bot precisa da permissão Inserir Links (Embed Links), além de Enviar Mensagens e Anexar Arquivos. A imagem é somente a apresentação das estatísticas, não uma simulação de controles interativos.

## Manutenção e testes

- `npm test`: testes de contagem, virada semanal, persistência, reconexão, comandos e geração do PNG.
- Faça backup do SQLite com o bot parado, ou usando uma ferramenta de backup SQLite que respeite o WAL. Não copie só o `.sqlite` enquanto ele estiver aberto ignorando os arquivos `-wal`/`-shm`.
- Rode apenas uma instância do bot por arquivo de banco.
- Não apague o banco para reiniciar o bot. Não há limpeza automática do histórico.
