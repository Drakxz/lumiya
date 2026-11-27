# Backups do servidor mds

## Instalação

Não foram adicionadas dependências. Requer o mesmo Node.js `>=22.13` do bot. Reinicie com `npm start` (ou `node .`). O armazenamento padrão fica em `backups/files/`; os metadados e configurações são tabelas `server_backups*` no SQLite compartilhado de horas. Esse diretório é privado do processo e deve estar em volume persistente, com permissões de sistema operacional restritas.

Configure no `.env`:

```dotenv
# Recomendado: chave aleatória de 32 bytes, em hexadecimal (64 caracteres) ou base64.
BACKUP_ENCRYPTION_KEY=COLOQUE_UMA_CHAVE_ALEATORIA_DE_32_BYTES_AQUI
BACKUP_DIRECTORY=./backups/files
# IDs adicionais autorizados (proprietário e administradores do servidor já podem usar).
BACKUP_ADMIN_IDS=
```

Gere uma chave fora do bot com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. **Guarde-a fora do servidor e faça cópia segura**: backups cifrados não podem ser recuperados sem a mesma chave. Sem a variável, os arquivos são comprimidos, mas não cifrados. Não compartilhe arquivos/chave em canal público.

O bot precisa de **Gerenciar Servidor**, **Gerenciar Cargos**, **Gerenciar Canais**, acesso aos canais a coletar, **Gerenciar Emojis e Stickers** e permissões para criar os recursos desejados. Intents privilegiadas ou limites do Discord podem reduzir os dados disponíveis. Apenas o proprietário, membros com `Administrator` ou IDs em `BACKUP_ADMIN_IDS` podem usar o sistema. Interfaces são enviadas por DM; a autorização é revalidada em cada interação.

## Comandos

- `!backuppainel`: envia o painel administrativo por DM.
- `!backup`: inicia o fluxo privado de criação.
- `!backups`: lista, pagina, detalha, baixa e prepara restauração.
- `!restaurar ID`: no servidor de destino, mostra uma prévia e permite importar
  um backup da MDS pelo ID, inclusive de outro servidor. A confirmação cria uma
  cópia de segurança do destino antes de restaurar.

Os arquivos têm extensão `.mdsbak`: JSON versionado, comprimido com gzip, checksums SHA-256 e, se configurado, AES-256-GCM autenticado. **Não é um ZIP convencional**. Download é enviado somente na conversa privada do administrador. O limite atual por backup é 40 MB antes da compressão.

## O que é capturado e restaurado

O coletor registra cargos comuns (exclui cargos gerenciados), hierarquia/permissões e ícones disponíveis; canais/categorias e sobrescritas de permissão; emoji/stickers e arquivos acessíveis; configurações básicas expostas pelo objeto Guild; inventário, versão e limitações. Recursos grandes/inacessíveis produzem falhas no manifesto. A captura pode ser parcial.

A restauração verifica checksum, formato e a origem registrada do arquivo.
Aceita backups de outro servidor salvos nesta instalação da MDS pelo ID:
é necessário administrar o destino e ser o criador do backup ou ter autorização
administrativa na origem. A autorização é revalidada na confirmação. O ID não
dá acesso público a backups privados, nem importa IDs de serviços externos.
Mostra origem e destino na prévia e opera somente depois de confirmação.
Cria backup de segurança e **cria/mapa itens ausentes**, sem apagar recursos existentes.
IDs recriados são novos. Cargos/canais encontrados por nome e estrutura são
mapeados, sem atualização automática de suas propriedades. A hierarquia é
tentada abaixo do cargo do bot e pode falhar por limites/permissões.
Falhas são apresentadas ao final.

Na importação entre servidores, não copia sobrescritas individuais de membros,
administradores pessoais, autorizações pessoais de whitelist, conversas ou
históricos. A revisão de mídia em outro servidor deve ser configurada novamente
no destino, com as autorizações exigidas dos dois servidores.

### O bot já configurado nos canais novos

Depois de recriar a estrutura, a restauração aplica as configurações do bot
com os novos IDs, tanto no SQLite quanto no `data.json` e na memória do processo:

- tickets: cargos de atendimento/acesso, configurações de gestão e metas;
- moderação de mídias: canais/categorias/exclusões, canais de análise
  superficial, logs, cargos e configurações de revisão;
- proteção de apelidos, cargos de Games, UP e whitelist de cargos;
- Central de Comandos, chat e configurações de backup;
- referências padrão de cargos e do canal de histórico de adições, via
  aliases persistentes por servidor, sem editar chaves ou segredos do `.env`.

Os painéis conhecidos de suporte, migração e Central de Comandos são
republicados nos canais que acabaram de ser criados. Canais existentes não
recebem publicações duplicadas. Novos painéis de tickets são registrados ao
usar `!painel` e `!migracao`; pais de tickets registrados também identificam
onde havia painéis antigos. Não é possível adivinhar um painel antigo que
nunca teve seu canal registrado. Outros painéis não registrados não são
republicados automaticamente, embora suas configurações sejam remapeadas.

A prévia informa que as configurações serão atualizadas; o relatório final
mostra as seções aplicadas e falhas. Uma seção com dependência que não pôde
ser restaurada é preservada e sinalizada, sem remover proteções ou liberar
permissões por suposição. Dados de outros servidores e referências a revisão
externa não são trocados por IDs locais.

Backups novos incluem um snapshot separado dessas configurações, mesmo sem
criptografia (o pacote continua privado, mas a criptografia é recomendada).
Em backups antigos sem esse snapshot, remapeia as configurações atuais e
aproveita apenas as seções de configuração disponíveis na exportação interna.
Não recupera configurações que nunca foram salvas.

Históricos, conversas, contadores, auditoria, membros, permissões de outros
servidores e operações pendentes não são regravados como se fossem novos.
Tickets privados antigos não são recriados; os painéis novos abrem tickets novos.

## Backup automático e retenção

No painel: ative/desative o agendamento, altere frequência entre 6, 12, 24 horas e semanal, e ajuste retenção entre 5, 10, 20 e 50 arquivos. A próxima execução fica persistida no SQLite; o temporizador evita execução simultânea no mesmo servidor. O canal de logs e avisos de resultado pode ser selecionado. A retenção apaga arquivos/metadados mais antigos depois de um backup novo.

## Mensagens

Desativado por padrão. Em **Configurações → Configurar Conteúdo**, habilite explicitamente, selecione até 10 canais e ajuste período (7/30/90/365 dias), limite (100/500/1000/5000 por canal) e anexos. Tópicos não são varridos. Nomes que aparentem tickets, denúncias, equipe, moderação ou logs são omitidos, a menos que o administrador selecione o canal explicitamente. Anexos aceitos vêm apenas do CDN do Discord e têm limite de 8 MB cada. O pacote arquiva cópias; **não republica nem restaura mensagens**. IDs, autoria nativa, timestamp original, respostas e anexos como objetos Discord não podem ser recriados.

## Limitações importantes

Discord não permite recuperar IDs originais, auditoria original, membros ausentes, URLs/convites, tokens/segredos, webhooks, integrações, AutoMod, eventos agendados e várias configurações de comunidade. Este primeiro restaurador também não reaplica configurações globais, associação de cargos a membros, threads, configurações de fórum avançadas, gradientes, stickers indisponíveis ou mensagens. Anexos e ícones são apenas arquivos capturados quando a API/CDN permite.

O SQLite do bot é compartilhado entre servidores; não é copiado como arquivo inteiro. **Com `BACKUP_ENCRYPTION_KEY` configurada**, o pacote contém uma seção interna separada com linhas filtradas pelo ID do servidor para tabelas de horas, UP, Central e metadados de backup, além dos registros de Ficha de Cargos e dados administrativos/tickets que tenham vínculo explícito com esse servidor. Arquivos antigos sem `guildId` não são atribuídos por inferência. Sem chave, essa seção é omitida. Históricos e dados operacionais dessa seção são somente exportação; somente as tabelas explicitamente permitidas de configuração podem ser reaplicadas.

A coleta das tabelas SQLite usa uma transação de leitura consistente na conexão compartilhada. Isso é um snapshot lógico por servidor, não uma cópia/restauração integral do banco; tabelas sem chave `guildId`, caches/sessões globais e configurações de outros servidores são omitidos deliberadamente.

O relatório do manifesto e a saída de auditoria registram criador, ID, checksum, tamanho, resultado e falhas. Mantenha backups fora do host, teste uma cópia em um servidor descartável e mantenha a chave criptográfica em local independente.
