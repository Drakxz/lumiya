# Instalação ativa na AWS

Migração realizada em 26/11/2026 para a instância Lightsail existente.

- SSH: `ssh ubuntu@3.12.169.220` (chave no perfil SSH local).
- Projeto ativo: `/home/ubuntu/mds-bot`.
- Serviço: `mds-bot.service`, com início no boot e reinício em falhas.
- Site: https://3.12.169.220.nip.io
- Saúde: https://3.12.169.220.nip.io/api/health
- Node utilizado: `/home/ubuntu/.nvm/versions/node/v26.13.1/bin/node`.
- Dependências do sistema: `fonts-dejavu-core` e `fontconfig` para renderizar
  corretamente os textos dos cartões; binários FFmpeg instalados via npm.
- A instalação anterior em `/home/ubuntu/insta` foi preservada.

## Operação

Por orientação do usuário, toda alteração solicitada deve ser publicada nesta
instalação AWS, com backup dos arquivos alterados, testes relevantes e verificação
do serviço após a publicação. Alterações somente locais não concluem a entrega.
Nunca envie `.env`, bancos ou estado local por cima dos dados ativos.

Execute na sessão SSH:

```sh
sudo systemctl status mds-bot
sudo systemctl restart mds-bot
sudo systemctl stop mds-bot
sudo journalctl -u mds-bot -f
```

Os logs podem conter o link privado do painel de calls. Não compartilhe os logs
sem remover segredos. O painel escuta somente em `127.0.0.1:3210`. Para acessá-lo
do PC, crie um túnel **local**:

```sh
ssh -N -L 3210:127.0.0.1:3210 3.12.169.220
```

Abra o link `http://127.0.0.1:3210/#key=...` registrado pelo bot na AWS.
Não abra a porta 3210 publicamente.

## Dados e recuperação

O `.env`, SQLite, uploads privados, JSON de estado, logs e backups existentes
foram transferidos. As dependências foram reinstaladas para Linux e o frontend
foi compilado no servidor; `node_modules` do Windows não foi reutilizado.

O cofre de calls continua usando DPAPI no Windows. Na AWS usa AES-256-GCM,
com chave em `/home/ubuntu/mds-bot/database/call-vault.key` (permissão 600).
Preserve essa chave nos backups, em armazenamento privado: sem ela, o cofre
Linux não pode ser recuperado. Não publique o banco, a chave ou o `.env`.
Uma cópia do estado anterior e da configuração Nginx está em
`/home/ubuntu/mds-migration-backup`, restrita ao usuário.

O Nginx mantém o HTTPS existente e agora serve os arquivos estáticos do projeto
ativo. A API usa a porta 3000 no loopback, sem túnel reverso para o Windows.

## Instalação local

A tarefa `MDS Bot + Site Keep Online` foi desativada, não excluída.
O bot local foi encerrado normalmente para salvar o SQLite. Os arquivos locais
foram preservados. **Não inicie outra instância local enquanto a AWS estiver
ativa**: isso pode duplicar respostas e criar estados divergentes.

Para voltar à instalação local, primeiro pare o serviço na AWS e planeje copiar
os dados atualizados de volta. O cofre AES Linux não é automaticamente convertido
para DPAPI. Não reative simplesmente a tarefa usando um banco antigo.
