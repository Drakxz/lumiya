# Painel de auto-unmute | mds / over

## Publicar

Reinicie o bot e execute **`!unmutepainel`** em um canal de texto. O comando exige **Gerenciar Servidor**. O painel é publicado no canal atual; o canal `#support` é localizado pelo nome e mencionado no texto quando existir. O banner PNG é gerado localmente em tempo de execução, no estilo azul escuro, e enviado como anexo Components V2.

## Permissões e funcionamento

O botão **Seja Desmutado** está disponível a todos, inclusive à equipe. Retira **server mute** (`serverMute`) e **server deafen** (`serverDeaf`) ativos do próprio membro que clicou. O membro precisa estar conectado a um canal de voz. Para cada estado, o bot precisa da permissão correspondente (**Silenciar membros** / `MuteMembers` e **Ensurdecer membros** / `DeafenMembers`) e de cargo acima do membro na hierarquia (a menos que tenha `Administrator`). Todas as respostas do botão são privadas.

O botão não remove timeout nem altera auto-mute/auto-deafen locais (`selfMute`/`selfDeaf`); só o próprio usuário pode mudar esses estados locais. Se não houver mute/deafen de servidor, o painel explica o que fazer. A hierarquia e as permissões nativas do Discord ainda se aplicam; coloque o cargo do bot acima dos cargos que devem poder usar o painel.

O painel não permite escolher alvo, e o membro é buscado novamente no servidor antes da ação. A hierarquia e a permissão do bot são verificadas a cada clique; falhas são tratadas sem derrubar o bot.

Cor predominante medida nos emojis: **`#006CFC`**.
