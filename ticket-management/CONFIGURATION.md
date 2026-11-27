# Gestão de tickets

## Autor sem permissão para falar no ticket

Os tickets são tópicos privados: adicionar o autor ao tópico não concede
automaticamente **Enviar mensagens em tópicos**, pois essa permissão é herdada
do canal do painel.

Ao abrir um ticket, a MDS verifica as permissões do autor e libera somente
as necessárias (**Ver canal**, **Ler histórico** e **Enviar mensagens em
tópicos**) por sobrescrita individual no canal do painel. Não libera **Enviar
mensagens** no canal principal, não altera `@everyone` nem adiciona a equipe
automaticamente a tópicos privados.

Na inicialização, também revisa os tickets privados abertos de suporte e
migração registrados no bot e garante a participação do autor. Tópicos
arquivados/bloqueados não são reabertos. Castigos ativos do Discord são
respeitados, não removidos nem contornados.

A MDS precisa de **Gerenciar Permissões/Gerenciar Cargos** no canal do painel
quando for necessário ajustar sobrescritas, além das permissões de criar e
gerenciar tópicos privados já exigidas pelo sistema.

Os cargos configurados para acesso/atendimento também recebem as permissões
necessárias no canal do painel: cargos mencionados do sistema, cargos de
atendimento, equipe e gestão da área e Administração Geral. A configuração é
consultada por área, sem liberar cargos não configurados, `@everyone` ou
**Gerenciar Tópicos**. Isso só permite conversar nos tópicos aos quais já
tenham acesso; não adiciona membros da equipe automaticamente a tickets
privados e não concede escrita no canal principal.

Esse ajuste ocorre ao abrir tickets e na revisão dos tickets abertos ao
reiniciar. A falta de permissões para o bot alterar as sobrescritas é reportada
em vez de criar um ticket silenciosamente sem acesso.

## Mov Chat, Passtime e promoções

As quatro áreas ficam no mesmo comando `!gestao` ou `/gestao-tickets`. O `!gestao` publica o **Painel de Gestão** diretamente no canal, sem etapa intermediária; cada pessoa com acesso recebe seu próprio painel e só ela pode navegar nele. O painel é apagado após **30 segundos sem interações**. Como ele fica visível no canal durante esse período, use o comando em um canal restrito à equipe. **Administração Geral → Configurações → área** permite escolher os cargos de gestão e de equipe de Suporte, Migração, Mov Chat e Passtime. O cargo de Administração Geral e a lista de administradores continuam exclusivos do proprietário.

**Mov Chat:** contabiliza mensagens humanas em todo o servidor nos canais cujos eventos o bot pode receber e marcações reais de `@everyone` sinalizadas pelo Discord, no máximo uma por mensagem; `@here`, bots, webhooks e texto simples sem marcação real não contam como `@everyone`. Não incentiva nem dispara marcações automaticamente. Conteúdo de mensagens não é armazenado; somente identificadores e totais. O bot precisa de acesso aos canais e do intent Message Content para distinguir as marcações.

**Passtime:** a Administração Geral escolhe o chat contabilizado nas configurações da área. Conta apenas mensagens humanas enviadas nesse canal enquanto ele estiver selecionado. Alterar o canal passa a exibir somente as contagens registradas para o canal atual; não há busca retroativa de mensagens.

As duas áreas têm filtros **Ativos / Inativos** por semana de Brasília. Sem meta, “ativo” significa ao menos uma mensagem nessa semana — não é uma avaliação automática da qualidade do trabalho. Metas são opcionais e inicialmente desativadas. Em Mov Chat podem ser definidas metas independentes de mensagens e `@everyone`, ambas exigidas se ambas estiverem ativadas; em Passtime a meta é por mensagens. O formulário do Mov Chat aceita dois cargos de cada vez para respeitar o limite de campos do Discord. As contagens começam com os novos envios após a instalação.

**Upar membro:** disponível aos gestores das quatro áreas. A Administração Geral escolhe a **Sequência de promoções** entre os cargos já autorizados para a equipe e ajusta a ordem (primeiro cargo → último cargo). Selecionar cargos não define a ordem de cliques: confira a lista e use os controles para reordenar. O gestor só promove um nível por vez, após confirmação; o membro precisa já estar na sequência. O fluxo adiciona o próximo cargo e remove somente o cargo atual da sequência, sem alterar cargos de outras áreas.

As validações de área, cargo compartilhado, hierarquia, proprietário e autoedição continuam valendo, inclusive na confirmação. Cargos com permissões administrativas podem ser usados **quando previamente incluídos na lista de cargos daquela área**; a hierarquia do bot e do operador ainda precisa permitir a alteração. Se o Discord adicionar o novo cargo mas falhar ao remover o anterior, a promoção é indicada como parcial e auditada para revisão, sem remover outros cargos. Não existe promoção automática por meta. Para atribuir um cargo de Mov Chat que concede Mencionar everyone, o próprio operador também precisa dessa permissão nativa (ou ser proprietário).

## Liderança, equipe e metas semanais

As listagens compartilham uma consulta completa de membros por servidor por até 60 segundos, atualizada pelos eventos de entrada, saída e alteração de membros. Filtros e páginas não disparam consultas completas repetidas. Consultas simultâneas reutilizam a mesma solicitação; limites do Gateway respeitam o `retry_after` do Discord. Uma lista parcial não é apresentada como equipe completa. As verificações de autorização e os alvos de alterações de cargo continuam usando consultas individuais atuais, sem depender desse cache de listagem.

Abra **Gestão de Suporte/Migração → Gerenciar equipe**. Os mesmos cargos de gestão concedem acesso à própria área; Administração Geral e proprietário podem acessar ambas.

- **Todos / Meta atingida / Meta pendente:** lista os membros humanos que possuem os cargos de atendimento configurados para a área, uma vez por membro, com paginação. Membros sem meta aparecem no filtro Todos, sem serem tratados como meta pendente.
- A semana começa **segunda-feira, 00h de Brasília**. Somente tickets fechados nessa semana, com data e responsável registrados, contam para quem estava atribuído ao atendimento. Não há zeramento destrutivo do histórico, nem estimativa de tickets antigos sem data. Membros que saíram da equipe não aparecem na lista atual.
- **Editar metas:** permite definir valores individuais para até cinco cargos da área por formulário. As metas semanais são persistidas por servidor, área e cargo no SQLite. Inicialmente herdam os valores já configurados no sistema; depois de editar aqui, a configuração semanal da área prevalece. `0` desativa a meta daquele cargo. Se o membro tiver mais de uma meta ativa, vale a do cargo mais alto da área.
- Os comandos e contadores acumulados anteriores não são zerados nem convertidos em dados semanais. Para acompanhar a semana, use a nova seção Equipe e metas.
- **Adicionar / Remover membro:** escolha um cargo da equipe e um membro; confirme a alteração. O bot precisa de **Gerenciar cargos**, e tanto o cargo selecionado quanto o membro precisam estar abaixo do bot e, salvo para o proprietário, do líder.
- Não permite autoedição, alterações em bots, proprietário ou administradores gerais. Cargos de gestão/administração e cargos com permissões elevadas do Discord **podem** ser atribuídos/removidos por esse fluxo se estiverem na lista de cargos da equipe daquela área e respeitarem a hierarquia do bot e do operador. Cargos compartilhados por suporte e migração ficam restritos à Administração Geral, inclusive ao editar metas.
- **Atenção:** incluir um cargo com permissões administrativas na lista da equipe delega aos gestores daquela área a capacidade de concedê-lo a outros membros (dentro da hierarquia). Revise essa lista periodicamente e mantenha o cargo do bot acima dos cargos gerenciados.
- Essas alterações não mudam os cargos autorizados no painel administrativo: o líder apenas atribui/remove cargos de equipe previamente aprovados pela Administração Geral. Todas as alterações são auditadas por área; confirmações expiram em dez minutos e não são reutilizáveis.

O painel administrativo usa Components V2 com destaque único `#5865F2`, sem integração de emojis externos. Nas telas privadas, a navegação atualiza a mesma mensagem quando possível; **Voltar** restaura a tela anterior, incluindo busca, filtro e página. Esse estado visual fica apenas em memória, limitado a 30 minutos, e as permissões são verificadas novamente a cada navegação. Depois de reiniciar ou expirar, o retorno começa pela tela inicial autorizada. Dados, histórico e permissões permanecem persistentes como antes.

Configure no `.env` (IDs de cargos, opcionais se configurados pelo painel):

```env
GESTAO_SUPORTE_ROLE_ID=
GESTAO_MIGRACAO_ROLE_ID=
GESTAO_TICKETS_ADMIN_ROLE_ID=
```

Reinicie o bot. O proprietário pode abrir `/gestao-tickets` ou usar `!gestao` e acessar **Configurações** no Painel de Gestão. As configurações por servidor no SQLite prevalecem sobre o `.env`.

Nas configurações, o proprietário pode selecionar até 25 membros como **Administradores Gerais de Tickets**, sem atribuir cargos do Discord. A seleção salva substitui a lista anterior; desmarcar remove a autorização individual. Somente o dono pode alterar essa lista ou o cargo Administração Geral. Administradores nomeados não podem nomear outros administradores. Quem mantém o cargo Administração Geral continua autorizado independentemente da lista de membros.

- Gestores de suporte/migração veem somente a sua área. Administração Geral e proprietário veem ambas.
- O `!gestao` publica o **Painel de Gestão** diretamente no canal e o remove após 30 segundos sem interações; use um canal restrito à equipe. Pesquisas, configurações e operações continuam privadas.
- Equipes comuns são os cargos definidos para **assumir** cada sistema em `!ticketconfig`. Cargos apenas mencionados não concedem autorização de gestão.
- Novos tópicos adicionam somente o autor do ticket. Os cargos configurados em `!ticketconfig` para menção são apenas mencionados na mensagem inicial; proprietário, administração, gestores e equipe **não são adicionados automaticamente**. A equipe precisa de Ver Canal e Gerenciar Tópicos no canal pai para acompanhar tópicos privados. O bot precisa de criar/gerenciar tópicos privados, enviar mensagens e consultar membros (Server Members Intent).
- A configuração de categoria é referência operacional. A área de registros antigos vem exclusivamente de `sistema` persistido; não se infere área pelo nome. Registros desconhecidos ficam sinalizados na visão geral e não podem ser operados pelos gestores.
- O botão **Revisar acesso aos tópicos existentes** não adiciona ninguém: ele apenas remove participantes que foram registrados como concedidos automaticamente por versões anteriores. Participantes adicionados manualmente, autor e responsável atual são preservados. Administradores e membros com Gerenciar Tópicos podem ter acesso nativo independentemente do painel; revise esses privilégios no Discord.
- O botão Abrir Canal não concede acesso automaticamente. Em tópicos antigos, o administrador deve conferir participantes antes de conceder acesso.
- Somente dados disponíveis são importados. Tickets já apagados antes da instalação não ganham histórico retroativo. Estatísticas de encerrados passam a usar registros persistentes da gestão.
- Canais de logs devem ser privados e separados por área. Logs contêm identificadores e ações; mantenha o acesso apropriado.
- Ticket marcado como `confidential` no registro só admite inclusão de participantes da equipe/gestão autorizada da área. Autor, proprietário do servidor e bot não podem ser removidos pelo painel.
- Novas ações do painel e botões antigos são validadas com membro recarregado do Discord, área persistida e vínculo servidor/ticket. Permissões de fechamento, transferência e participantes são alternáveis para equipes/gestores; administração geral mantém acesso.

Alterações de cargos não adicionam nem removem participantes de tickets existentes. Limitações: não é possível identificar como foi concedida uma participação antiga sem registro. O responsável atual permanece no canal até o atendimento ser transferido, evitando retirar um atendente em andamento sem revisão. A autorização de operar o painel, porém, é revogada na próxima interação. Revise também participantes legados e permissões do canal pai. Os testes locais não substituem um teste nos servidores reais.
