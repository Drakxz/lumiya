# Instagram

## Logs do servidor de verificação

No servidor **`1573006949895635145`**, a organização automática cria somente
um canal privado **`logs-instagram`**, sem a categoria e os logs gerais do
servidor principal. Ele registra apenas mídias aprovadas e efetivamente
publicadas como posts do Instagram, com link para a publicação.
Bloqueios, pendências e erros não são enviados para esse canal.

Vínculos antigos de logs gerais são desativados, sem excluir canais ou
históricos já existentes. Os registros internos de auditoria são preservados.
Os demais servidores mantêm a organização de logs existente.

## Painel público de verificação

Use **`!instapainel`** no canal do servidor principal onde deseja exibir o convite.
Exige **Gerenciar Servidor**. O painel tem visual clean, orienta a entrar no
servidor de verificação, abrir ticket e aguardar a equipe. Se aprovado, o
membro recebe acesso ao canal para enviar a foto, que ainda passa pela análise
de mídia antes da publicação. O botão **Entrar no servidor de verificação** usa o convite
https://discord.gg/KMdAGUrZh7.

O painel apenas explica e redireciona: a abertura de tickets, a verificação
pela equipe e a liberação do canal dependem das configurações do servidor de
verificação. Este comando não concede cargos nem altera permissões.

O painel é preservado da limpeza automática e atualizado ao reiniciar.
Repetir o comando no mesmo canal atualiza o painel existente, sem duplicar.
O convite não configura o encaminhamento: conecte origem e destino com
`!instagram`, conforme abaixo.

## Configuração dos envios

### Aviso no canal de mídias

O aviso é enviado **automaticamente no canal de origem**, ao conectar o
servidor pelo painel `!instagram`. Não há comando separado para publicá-lo.
Origens já configuradas recebem o aviso ao reiniciar o bot.
O aviso usa destaque preto e miniatura GRIFE10, sem banner,
com orientações de envio, legenda, análise e privacidade.
É preservado da limpeza automática e atualizado ao reiniciar, sem duplicar.
Se a mensagem tiver sido apagada, o bot a recria no próximo início ou ao
reconfigurar a origem. O aviso não libera acesso ao canal: ajuste as
permissões pelo Discord.

### Ticket no servidor de verificação

Use **`!instaticket`** em um canal de texto do servidor de verificação.
Exige **Gerenciar Servidor** e publica um painel com o botão
**Iniciar verificação**. Repetir o comando atualiza o mesmo painel no canal;
o painel é preservado da limpeza automática e atualizado ao reiniciar.

O botão abre um **tópico privado**, registrado na área **Suporte**, com o tipo
**Verificação do Instagram**. Usa os cargos e controles de suporte já configurados
em `!ticketconfig` e na gestão: assumir, participantes e encerramento.
O ticket do Instagram tem painel próprio e pode coexistir com um ticket de
suporte comum. Cada membro pode ter apenas um ticket aberto de verificação.
A equipe precisa de acesso a tópicos privados; o bot precisa das permissões de
criar/gerenciar tópicos e das permissões de acesso descritas na documentação de tickets.

A verificação continua sendo decidida pela equipe, mas a entrega do cargo é automática:

1. Use **`!instaverificacao`** no servidor de verificação, com **Gerenciar
   Servidor e Gerenciar Cargos**, e selecione o cargo de membro aprovado.
2. Configure as permissões do canal de envio para permitir acesso a esse cargo.
3. Dentro do ticket, a equipe clica em **Verificar membro** e confirma
   **Confirmar e entregar cargo** na resposta privada.
4. O bot atribui o cargo ao autor, registra responsável/horário e muda o ticket
   para **Verificado**. O ticket não é fechado automaticamente.

Podem aprovar gestores de suporte/Administração Geral e a equipe autorizada
a assumir suporte. As permissões são consultadas novamente na confirmação.
O próprio autor não pode se verificar, mesmo sendo da equipe.
O botão fica vinculado ao ticket e à mensagem original; tickets comuns não
podem usar esse fluxo. A confirmação expira em cinco minutos e não sobrevive
ao reinício. Cliques simultâneos não duplicam a atribuição.

O cargo deve pertencer ao servidor, ser comum, sem permissões administrativas
ou de moderação, e ficar abaixo do bot e de quem o configura.
O bot precisa de **Gerenciar Cargos** e estar acima do membro atendido.
Mudanças de cargo/configuração, tickets fechados ou em encerramento e
falhas na API não são apresentados como verificação concluída.
O registro da aprovação e o cargo configurado persistem no SQLite; a concessão
também usa o histórico de cargos existente.
Limpar o seletor desativa novas aprovações, sem remover cargos já entregues.
O bot não altera permissões do canal: o acesso depende do cargo configurado
nas permissões do Discord. A aprovação do membro não substitui a análise de mídia.

### Conectar origem e destino

Use `!instagram` com **Gerenciar Servidor** no servidor de destino:

1. Escolha o canal de publicação no seletor.
2. Clique em **Conectar outro servidor** e informe o ID do canal de envio.
3. O bot deve estar nos dois servidores; quem configura precisa de **Gerenciar Servidor em ambos**.

O painel mostra origem, destino e o fluxo **envio → verificação → publicação**.
Cada canal de origem pode estar ligado a apenas um destino. O canal de origem
não pode ser outro destino do Instagram. **Usar envio local** restaura o modo anterior.
Limpe a seleção do destino para desativar a conexão.
A configuração, publicações, curtidas e comentários ficam no SQLite existente.

O bot precisa de Ver Canal, Enviar Mensagens, Anexar Arquivos e Gerenciar Mensagens. Configure a chave `OPENAI_API_KEY` e as regras/limites no painel de proteção de mídias.
Na origem, também precisa de Ler Histórico de Mensagens. A configuração valida
o acesso do bot e publica um aviso sobre a análise externa antes de ativar a origem.

**Entre servidores:** as mídias são capturadas e removidas no canal de origem.
A análise completa usa as regras, limites, orçamento e fila de revisão do
**servidor de origem**, mesmo se a moderação geral estiver desativada ou o canal
estiver em modo superficial. Somente aprovações são enviadas como posts de
Instagram ao destino; não há republicação da mídia aprovada na origem.
Bloqueios, ambiguidades e erros não são encaminhados automaticamente.
A aprovação humana na fila existente também respeita o destino original.
O autor é preservado e não precisa estar no servidor de destino para publicar.
Fotos e vídeos enviados em tópicos do canal de origem também passam pela
análise completa e usam a mesma conexão de destino. A ocorrência guarda o ID
do tópico; somente aprovações são encaminhadas. O bot precisa ter acesso ao
tópico e permissão para enviar mensagens nele. Tickets abertos em outros
canais não são encaminhados automaticamente.

O destino de cada caso fica registrado antes da análise e persiste após reinícios.
Se a conexão for removida ou alterada enquanto houver envios pendentes, esses
envios ficam retidos, sem redirecionamento silencioso para outro canal.
O nuke remapeia os canais configurados; casos pendentes com a conexão antiga
permanecem retidos e podem exigir novo envio.

**Permissões do destino:** restrinja o envio de mensagens/anexos à equipe e ao
bot para impedir envios diretos de membros. O painel não altera permissões
automaticamente; o bot não consegue interceptar mensagens antes de aparecerem
no Discord.

**Modo local (sem origem externa):** no canal escolhido, imagens e vídeos são capturados antes da exclusão da mensagem original. O sistema de proteção existente analisa os arquivos e legendas; somente aprovações são republicadas. Falhas, limites e ambiguidades ficam na fila de revisão existente. O Instagram exige análise completa, mesmo se o canal estiver configurado como superficial ou a moderação geral estiver desativada. Imagens/vídeos podem ficar visíveis brevemente antes da exclusão; o bot não consegue interceptar o envio no Discord.

Os posts usam Components V2 com autor, mídia, legenda e botões:

- ❤️: adicionar/remover sua curtida.
- 💬: enviar um comentário por formulário.
- Terceiro botão: abre um painel V2 privado com o @ e link do Instagram, ou avisa que o autor não informou. Para o autor, oferece adicionar/editar/remover o @ e excluir a publicação.
- Opções: painel privado V2 com abas de curtidas e comentários, contadores, atualização e paginação (15 curtidas ou 4 comentários por página).
- 🗑️: aparece somente no menu privado do autor. A equipe pode usar a exclusão nativa do Discord, conforme suas permissões.

Comentários são textos de usuários, não recebem análise de imagem e não são exibidos publicamente no post. O contador é público. A mídia só é processada enquanto o bot está ligado; não há importação de envios antigos neste sistema.

Não há pergunta automática por DM nem espera pelo @: a publicação segue após aprovação da proteção. No terceiro botão, o autor pode adicionar seu @ por formulário, editá-lo ou removê-lo; é opcional. As opções só aparecem na consulta privada do autor e as permissões também são verificadas no servidor. O @ fica vinculado ao envio, incluindo todos os seus anexos, e persiste após reiniciar. Posts antigos também permitem adicionar o @ pelo terceiro botão. O bot não verifica a titularidade do perfil.
