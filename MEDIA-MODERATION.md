# Moderação de mídias

Abra `!midiaadmin` com **Gerenciar Servidor**. Configure os canais/categorias
em **Configurar Canais** e ative o sistema. Exclusões de canais prevalecem.

Canais de texto/anúncios com nome exatamente `chat` são monitorados
automaticamente, sem cadastro manual, enquanto o sistema estiver ativado.
A regra também vale para canais novos ou renomeados e usa análise completa,
salvo se o canal estiver cadastrado para análise superficial. Nomes como
`chat-geral`, `bate-chat` ou `💬chat` não entram nessa regra. Ao renomear um
`chat`, ele só continua monitorado se houver outra configuração que o inclua.
Exclusões manuais continuam prevalecendo.

## Tópicos e posts de fórum

Tópicos públicos, privados e de anúncios herdam a proteção do canal pai e
da categoria desse canal. Isso inclui o modo superficial e o monitoramento
automático de um canal chamado `chat`. Posts de fórum/mídia também são
monitorados quando o fórum ou sua categoria está configurado.
O seletor de canais/exclusões permite selecionar fóruns e canais de mídia.
Exclusões do tópico ou do canal pai são respeitadas.

No modo completo, o original é capturado antes da exclusão e, após aprovação,
republicado **no próprio tópico**, sem expor conversas privadas no canal pai.
Se for um tópico do canal de origem do Instagram, a análise é completa e as
aprovações seguem para o destino conectado, assim como os envios no canal.
Tópicos de outros canais, inclusive tickets, não são encaminhados ao Instagram
apenas por existirem: precisam pertencer à origem configurada.

O bot tenta acompanhar tópicos ativos monitorados ao iniciar e quando são
criados/atualizados. Não reabre tópicos arquivados nem importa mensagens antigas.
Ele precisa de **Ver Canal**, **Ler Histórico**, **Enviar Mensagens em Tópicos**,
**Anexar Arquivos** e **Gerenciar Mensagens**. Em tópicos privados, precisa
ser participante ou ter o acesso exigido pelo Discord, como **Gerenciar Tópicos**.
Sem acesso, o bot não consegue receber nem analisar os envios.

## Análise superficial (opcional)

No painel principal, abra **Canais de análise superficial** e clique em
**Adicionar canal por ID**. Cole o ID de um canal de texto deste servidor.
A lista é salva por servidor, sem mudar o modo dos demais canais.

Somente os canais cadastrados nessa seção usam a análise superficial. Não é
necessário cadastrá-los também em **Configurar Canais**. Se um canal estiver
nas duas listas, o modo superficial prevalece; as exclusões continuam
prevalecendo sobre ambos. Remova um ID pelo seletor dessa seção para desfazer.
Após remover, o canal só continuará monitorado se também estiver configurado
para análise completa (diretamente ou pela categoria).

Cadastrar um canal não liga um sistema desativado. O antigo modo global
superficial foi descontinuado e não altera o comportamento de nenhum canal.

- A mensagem fica no canal durante a análise e não é reenviada.
- Imagens estáticas são reduzidas a até 768 pixels. Vídeos/GIFs usam até três
  amostras visuais (início, meio e perto do final), sem transcrição de áudio.
- Uma violação de categoria ativada, classificada pelo OpenAI Moderation,
  causa exclusão da mensagem e **castigo de 1 hora** no autor do envio.
  Uma mensagem com vários anexos recebe uma única ação.
- Não reduz um castigo maior já existente. Proprietário, administradores ou
  membros acima do bot podem não ser moderáveis pelo Discord.
- Falhas de API, limites, formatos inválidos e análises inconclusivas **não**
  causam castigo nem exclusão automática. A mensagem fica no canal e a
  ocorrência é registrada para a equipe.
- Sinais de segurança infantil seguem o procedimento especializado existente:
  retirada preventiva, sem envio à API quando detectados antes da análise,
  sem republicação e sem castigo baseado apenas em suspeita.
- Não guarda cópias permanentes das mídias nem encaminha arquivos para outro
  servidor nesse modo. O histórico mantém metadados, resultado e o que foi
  efetivamente aplicado (incluindo falhas de exclusão/castigo).
- Os limites de download, fila, tamanho, duração e orçamento continuam valendo.
  A análise superficial não usa o cache de aprovação do modo completo.

O bot precisa de **Gerenciar Mensagens** e **Moderar Membros**, além de acesso
ao canal. A ativação verifica essas permissões; a execução também verifica as
permissões no canal e a elegibilidade atual do membro.

**Limitações:** uma análise superficial pode deixar passar conteúdo entre os
quadros ou detalhes pequenos. A mídia permanece visível até eventual remoção.
A IA pode errar; revise os registros e os castigos quando necessário.
O serviço de análise continua sendo OpenAI Moderation, separado do chatbot Gemini.
