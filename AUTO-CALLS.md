# Calls automáticas

Comando: **`!autocall`** (requer **Gerenciar Servidor** e **Gerenciar Canais**).

1. Selecione uma **categoria** no painel.
2. Clique em **Ativar**.

A partir daí, sempre que alguém entra na **última call de voz da categoria**
(maior posição), o bot cria uma nova call de voz, incrementando o **último número
do nome**, se houver: `Call 1` → `Call 2`, `Call 009` → `Call 010`.
O restante do nome e os zeros à esquerda são preservados; sem números, o nome
continua igual. A nova call mantém o mesmo limite de usuários, bitrate e categoria e passa a ser a última da
categoria, então o processo se repete a cada entrada.

Canais criados pelo sistema são apagados automaticamente **10 segundos** depois
de ficarem vazios. Na inicialização, o bot também remove canais gerados que já
estejam vazios.

O bot precisa de **Gerenciar Canais** e de acesso à categoria. O sistema ignora
canais de voz fora da categoria configurada e para de criar quando a categoria
atinge 49 canais. A configuração acompanha restaurações de backup: se a
categoria for recriada, o novo ID é aplicado automaticamente.
