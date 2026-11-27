# Proteção de execução | mds

Use **`node .`** ou **`npm start`**. Ambos iniciam `start.js`, que mantém **um único processo do bot por vez**, executando `index.js`. Não há outro Client Discord nem outro login simultâneo.

## Proteções

- Erros conhecidos da API e de rede recebem diagnóstico sem derrubar desnecessariamente o bot.
- Erros do Client, rejeições assíncronas capturadas pelo discord.js, avisos e erros do Gateway têm handlers próprios.
- Exceções não tratadas e rejeições desconhecidas encerram o processo com erro, em vez de esconder um possível estado inconsistente.
- O supervisor reinicia após quedas com espera progressiva. Após **5 quedas em 10 minutos**, interrompe o ciclo para que o problema seja corrigido.
- Erros conhecidos de token/intents usam saída `78`, sem tentativas automáticas inúteis.
- Ctrl+C/SIGTERM não reiniciam o bot. O supervisor solicita o encerramento por IPC para permitir o salvamento do SQLite também no Windows; após 5 segundos, força o encerramento se necessário.
- Os hooks de saída do contador continuam salvando/fechando o banco. Transações SQLite não confirmadas não são tratadas como dados salvos.

Diagnósticos ficam em **`logs/anticrash.log`**, com backup rotativo de até cerca de 5 MB por arquivo e ocultação de tokens/webhooks. Logs repetidos idênticos são limitados. Logs antigos feitos diretamente por outros módulos continuam sob responsabilidade desses módulos; evite compartilhar saídas sem revisá-las.

**`node index.js`** também instala os handlers, mas não inclui o supervisor de reinício. Prefira `node .` ou `npm start`.

Nenhum anticrash impede todos os problemas: falta de memória, encerramento forçado pelo sistema, erros de sintaxe, dependências ausentes, corrupção de disco ou permissões inválidas precisam de diagnóstico/correção. O supervisor pode recuperar quedas do processo, mas não reinicia a própria máquina nem corrige bugs automaticamente. Não execute simultaneamente outro gerenciador de reinícios sobre `index.js` e este inicializador.
