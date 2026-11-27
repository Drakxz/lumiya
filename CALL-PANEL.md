# Painel local de contas em call

Inicie o bot normalmente. No terminal aparecerá:

`[Painel de calls] Acesso local (não compartilhe este link): http://127.0.0.1:3210/#key=...`

Abra **o link completo** no navegador do mesmo computador. A chave é renovada a cada execução. O link permite gerenciar as contas: não compartilhe nem publique capturas do terminal com ele.

## Uso

- Cadastre nome de identificação, token e ID da call.
- Novas contas ficam desconectadas até clicar em **Conectar**.
- **Editar** permite alterar o nome, a call e substituir o token. Token vazio durante a edição mantém o atual.
- **Desconectar** interrompe a sessão e mantém a conta salva.
- **Excluir** desconecta e remove o token do cofre. A conta usada na bio continua configurada para a verificação de bio no `.env`; excluir do painel desliga apenas sua presença em call.
- Até 20 contas. A lista e o estado são atualizados a cada cinco segundos enquanto a aba estiver visível.
- Contas com conexão ativada voltam a conectar ao reiniciar o bot, respeitando suas preferências de áudio.
- Presets de áudio: **Desmutado**, **Só microfone mutado** e **Microfone + deafen**. Há botões rápidos para mutar/desmutar o microfone e ligar/desligar o deafen.
- Alterações de áudio são aplicadas na sessão ativa sem desligar o Gateway. Em contas desconectadas, são salvas para a próxima conexão. Deafen sempre implica microfone mutado; desmutar o microfone também desliga o deafen.
- São controles de **self mute/deaf**, não removem mutes da equipe. Desmutar não captura o microfone do computador nem inicia reprodução ou gravação.
- **Reconectar agora** recria a sessão daquela conta. Desative a **reconexão automática** na edição se não quiser novas tentativas após quedas.
- Adicione anotações, marque favoritas, busque por nome/call/anotação e filtre por estado. Os favoritos e as anotações ficam no cofre.
- Resumo de contas, conexões, preferências de mute e falhas; tempo conectado; copiar ID da call; conectar/desconectar todas com confirmação.
- Foto de perfil obtida ao autenticar a conta, atualizada por eventos do Discord e salva no cofre. Continua visível desconectada; substituir o token limpa o perfil antigo. Antes da primeira conexão ou se a imagem falhar, aparecem as iniciais. As imagens são carregadas diretamente do CDN do Discord.

## Além das calls

- **Visão geral:** sessões ativas, calls estabelecidas, falhas, distribuição de estados, favoritas, diagnóstico e ações recentes. Os números representam o estado atual, sem gráficos de histórico inventados.
- **Status e atividades:** configure online, ausente, não perturbe ou invisível; atividades Jogando, Transmitindo, Ouvindo, Assistindo e Competindo. Deixe o nome vazio para remover a atividade. Streaming exige URL HTTPS da Twitch ou YouTube. Preferências são salvas para a próxima conexão e aplicadas via Gateway na sessão ativa, sem reiniciar a voz. O cliente oficial ou as restrições do Discord podem sobrescrever ou impedir a exibição.
- **Somente presença:** ao cadastrar/editar, desligue “Entrar em uma call”. A conta mantém sessão e presença sem buscar nem entrar em canal de voz. O ID da call passa a ser opcional.
- **Histórico:** até 150 ações feitas no painel, incluindo cadastro, conexão, áudio e presença. Não contém tokens nem respostas de autenticação. É um registro de solicitações, não uma confirmação de que o Discord aceitou todas as alterações. Salvo criptografado em `database/call-accounts.enc.events`.
- **Configurações:** densidade dos cartões e intervalo de atualização (5, 10 ou 30 segundos), salvos somente no navegador. Diagnóstico de conexão do bot, Node.js e tempo do painel.
- **Exportar configurações:** JSON com nomes, calls e preferências; não inclui tokens, perfis, chave de acesso ou IDs das contas. Não substitui backup do cofre nem importa credenciais automaticamente.
- **Ctrl+K / Cmd+K:** central de comandos com busca, navegação por setas, Enter para executar e Escape para fechar. Permite navegar, editar contas, abrir presença, atualizar e exportar.

### Sincronização de status

O painel envia a presença à sessão do Gateway e sincroniza o status geral online/ausente/não perturbe/invisível em `/users/@me/settings`. **Status personalizado** envia o texto no campo correto (`state`, atividade tipo 4) e salva `custom_status`; nome vazio nessa opção remove o texto personalizado. Não altera outras preferências da conta.

O cartão informa **aguardando conexão**, **sincronizando**, **enviado** ou uma falha sanitizada. “Enviado” significa que a requisição foi aceita, não comprova a aparência em todos os clientes. APIs de contas pessoais podem mudar ou ser recusadas pelo Discord; nesse caso, a preferência continua salva e o painel informa o erro, sem prometer sucesso. Não tenta sobrescrever repetidamente os outros clientes.

### Referências de interface

Navegação e hierarquia visual inspiradas em [Linear](https://linear.app/now/how-we-redesigned-the-linear-ui) e [Vercel](https://vercel.com/changelog/dashboard-navigation-redesign-rollout); busca e atalhos baseados no padrão de [menu de comandos](https://vercel.com/docs/dashboard-features/command-menu). A interface é própria, sem assets copiados ou bibliotecas externas de UI.

Os tokens existentes em `DISCORD_BIO_CHECK_USER_TOKEN` e `DISCORD_EXTRA_CALL_TOKEN` são importados automaticamente uma vez. Depois disso, as alterações de call/token dessas contas são feitas no painel. Se forem excluídas, não serão importadas novamente. O bot principal continua na sua call fixa, fora dessa lista.

## Segurança e armazenamento

O servidor escuta **somente em 127.0.0.1**, sem acesso por outros computadores. Não publique a porta via proxy, túnel ou redirecionamento. A API exige chave de acesso, valida origem/Host e não retorna tokens. A chave fica na sessão da aba; tokens não são armazenados no navegador.

`database/call-accounts.enc` guarda as credenciais criptografadas usando **DPAPI do Windows, CurrentUser**. É necessário executar o bot sob o mesmo usuário e Windows para abrir o cofre. A proteção não impede programas maliciosos executados como esse usuário de acessar os dados. As credenciais que já estavam no `.env` continuam nele; não são apagadas automaticamente.

O painel não transmite áudio. Contas precisam estar no servidor e ter acesso ao canal; como a validação inicial do canal usa o bot principal, ele também precisa enxergá-lo. Automação de contas pessoais pode violar as regras do Discord e resultar em suspensão.

## Configuração opcional no `.env`

```env
CALL_PANEL_PORT=3210
CALL_PANEL_ENABLED=true
```

`CALL_PANEL_ENABLED=false` desliga a interface HTTP, mantendo a conexão das contas salvas. Reinicie após alterar a porta. Se ela estiver ocupada ou o cofre não puder ser aberto, o terminal informa a falha; o restante do bot continua funcionando. Não substitua ou apague um cofre inacessível sem guardar uma cópia.
