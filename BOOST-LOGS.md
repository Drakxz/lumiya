# Logs de impulsionamentos

Ao iniciar, o bot cria/configura **amex → logs-impulsionamentos**, privado para
o bot, dono e administradores. Precisa de **Gerenciar Canais** para criar o
canal e de **Ver Canal** / **Enviar Mensagens** para publicar os registros.

O card mostra quem impulsionou, ID, avatar quando disponível, data/hora em
Brasília, nível e total de impulsionamentos informado pelo servidor.
As mensagens são preservadas da limpeza automática e não geram pings.

- Avisos de impulsionamento do Discord registram cada mensagem distinta,
  inclusive novos impulsionamentos de alguém que já era booster.
- A mudança de `premiumSince` registra o início do apoio mesmo sem aviso
  de sistema. Os dois sinais do primeiro evento são correlacionados.
- O Discord não informa impulsionamentos extras da mesma pessoa pela mudança
  de `premiumSince`: para identificá-los, mantenha os avisos de boost habilitados.
- Não atribui aumentos do contador global a pessoas por suposição nem inventa
  histórico de eventos anteriores à instalação.

Eventos e entregas ficam no SQLite. Mensagens já entregues não são repetidas
ao reiniciar. Se o canal estiver indisponível, os registros pendentes podem
ser reenviados na próxima inicialização.
