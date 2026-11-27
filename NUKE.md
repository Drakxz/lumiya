# Nuke de canal

Comandos: **`!nuke`** e **`/nuke`** (opcionalmente com `#canal`). Somente
membros com **Administrator**.

O canal é apagado e recriado **imediatamente**, sem confirmação.

São preservados: nome, tipo (texto/anúncio), tópico, categoria, posição, NSFW,
limite de mensagens e substituições de permissões. As configurações do bot que
apontavam para o canal antigo são remapeadas automaticamente para o novo ID,
incluindo a **moderação de mídia**: canais monitorados, canal de logs e IDs de
análise superficial continuam apontando para o canal recriado. Não é preciso
reconfigurar nada depois do nuke.

A proteção de imagens também faz um vínculo direto no armazenamento ativo,
sem depender apenas da restauração geral de configurações. Se o monitoramento
era herdado da categoria, o novo ID é registrado explicitamente. O modo
superficial, exclusões e o estado ativado/desativado são preservados.
O aviso de moderação é republicado no novo canal quando a proteção está ativa.
Casos e arquivos históricos continuam associados ao canal original.

Um painel público em Components V2 é enviado no canal recriado, tanto com
`!nuke` quanto com `/nuke`, mesmo quando executados de outro canal.
O aviso tem visual compacto, com canal, responsável, horário e alerta sobre
a perda do histórico, sem notificar o responsável por menção.
Detalhes das configurações só aparecem quando há falhas para revisar.
O destaque é verde no sucesso e amarelo quando há configurações para revisar.
Falhas parciais ao reaplicar configurações são informadas, sem apresentar um
canal já recriado como se não existisse. Falhas no envio do aviso são registradas no log.

**Perdido para sempre:** mensagens, pins, webhooks, integrações e qualquer
referência externa ao antigo ID que não esteja nas configurações do bot.

O bot precisa de **Gerenciar Canais**. Canais de voz, threads e categorias são
recusados. Se a recriação completa falhar, o bot tenta criar o canal com o
mínimo (nome, tipo e categoria) e registra o erro no log.
Mesmo nessa tentativa mínima, preserva NSFW e as substituições de permissões.
