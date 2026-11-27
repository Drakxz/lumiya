# Progressão automática de cargos | mds

## Começar

Não há dependências novas. Use Node.js 22.13+ e as dependências já instaladas (`npm install`, depois `node .`).

1. Coloque o cargo do bot **acima de todos os cargos que serão recompensas** e dê ao bot **Gerenciar Cargos**. Ele também precisa ver os canais de voz; para notificações, precisa ver e enviar mensagens no canal escolhido.
2. Abra **`/upadmin`** (privado) ou **`!upadmin`** (resposta no canal, com controles exclusivos do solicitante). Exige **Gerenciar Servidor** (`ManageGuild`), inclusive em cada interação.
3. Em **Adicionar Cargo**, selecione um cargo com `RoleSelect` e informe `0` horas: esse é o inicial. Adicione os níveis seguintes com suas metas acumuladas. Aceita horas decimais, inclusive vírgula, com até seis casas.
4. Em **Configurações**, escolha se mute conta, se deve remover o cargo anterior, se permite horas anteriores ao resgate, canais de voz excluídos e canal de notificações. Você também pode selecionar até cinco opções iniciais adicionais; elas nunca podem ser cargos avançados.
5. Ative o sistema no painel administrativo.
6. Publique **`!upcargos`** no canal desejado, ou **`!upcargos #canal`**. Só `ManageGuild` pode publicar. Membros podem usar Resgatar Cargo Inicial, Minha Progressão e Ver Cargos. O painel publicado é preservado; mensagens de erro do comando continuam sendo removidas automaticamente após 30 segundos.

Não há cargos, metas ou notificações pré-configurados/fictícios. O sistema inicia **desativado**.

## Verificação de bio `/mds`

O painel pode exigir que o membro mantenha o trecho **`/mds`** na bio do perfil Discord para resgatar e conservar os cargos de UP.

1. No `.env`, preencha `DISCORD_BIO_CHECK_USER_TOKEN` com o token de uma **conta de usuário** (não use o prefixo `Bot `). A conta precisa estar no servidor e conseguir visualizar os perfis consultados. Variável vazia mantém a verificação desativada; reinicie o bot depois de alterá-la.
2. A conta do token precisa conseguir visualizar os perfis consultados. O bot usa o endpoint de perfil com `guild_id` do servidor e guarda apenas o resultado (`present`, `missing` ou `unknown`), nunca o texto da bio.
3. O resgate inicial é bloqueado sem `/mds`. Evoluções automáticas também ficam suspensas enquanto a bio não for confirmada.
4. A revisão periódica consulta os participantes em lotes, no máximo a cada **30 minutos por membro** e com intervalo mínimo de 2 segundos entre consultas. A remoção pode levar algum tempo em servidores grandes; não é instantânea.
5. Ao detectar a remoção do `/mds`, o bot retira **somente cargos de UP concedidos pelo próprio sistema** e envia um aviso privado. Horas, histórico e cargos externos são preservados.
6. Ao recolocar `/mds`, os cargos removidos que ainda estiverem autorizados pela configuração atual podem ser restaurados automaticamente. Cargos que saíram da hierarquia não são restaurados.
7. **Perfil privado ou indisponível:** a mensagem informa “Perfil indisponível ou privado” e o resgate não é confirmado. Falhas de consulta não são tratadas como ausência de `/mds` e **nunca removem cargos**. O sistema tenta novamente depois.
8. Se o aviso privado falhar (DM fechada), a remoção já feita é mantida e o aviso é tentado novamente nas próximas revisões.

O endpoint usado é uma interface **não oficial** de conta de usuário. O Discord pode alterá-lo, limitar ou restringir a conta utilizada; esse risco é do operador. A API oficial de bots não expõe bios. Se a verificação falhar de forma persistente, basta esvaziar a variável para voltar ao comportamento sem exigência de bio.

Os cargos removidos ficam registrados em `up_bio_roles` e o resultado das consultas em `up_bio_checks`. Alterações de cargo passam pela Ficha com origem **Requisito de bio do UP**.

## Contagem e marcos

- Usa **a mesma conexão SQLite e os mesmos intervalos do sistema `!horas`/`/horas`**, incluindo a sessão em andamento. Não existe segundo cronômetro.
- Guarda o total geral no momento do resgate e sua data. Por padrão, somente intervalos posteriores a essa data são elegíveis.
- Metas são acumulativas: o requisito de um nível não se soma ao nível anterior. A barra usa `(tempo elegível - marco conquistado) / (próxima meta - marco conquistado)`.
- AFK é sempre excluído. Canais excluídos e política de mute afetam só o UP, **sem alterar as estatísticas gerais de horas**.
- Alterações de políticas aplicam o filtro atual aos intervalos disponíveis. Desativar o UP pausa os resgates/evoluções, não o contador de voz; ao reativar, as horas elegíveis podem liberar níveis pendentes.
- Verifica durante a call a cada **15 segundos** e nas transições de voz. Há no máximo três participantes em processamento simultâneo; o tempo real depende da fila e dos rate limits do Discord.
- Bot desconectado não conta tempo inventado. A recuperação de voz continua seguindo as mesmas garantias do contador existente.

### Limitação honesta das horas antigas

Os totais antigos de `!horas` não guardavam canal e intervalos de mute detalhados. A atualização adiciona `voice_segments`, sem alterar/apagar esses totais, e passa a registrar os detalhes necessários.

**Horas anteriores ao resgate**, se habilitadas, só usam os intervalos detalhados disponíveis desde esta atualização. Não é possível reconstruir com segurança se horas antigas eram de AFK/canais excluídos. O bot não transforma totais antigos sem origem em horas elegíveis fictícias. O resumo “hoje” da progressão também usa os intervalos disponíveis; o resumo semanal geral vem do contador existente.

## Configuração, segurança e recálculo

- Editar Cargo permite selecionar um cargo configurado, trocar o cargo associado e salvar uma nova meta. A ordem segue as metas; não há IDs de recompensas fixos no código.
- Metas/cargos duplicados, horas negativas e cargos de integração/acima do bot são rejeitados. Na configuração, o cargo também precisa estar abaixo do responsável (exceto dono do servidor).
- Cargos com **Administrador** podem ser configurados pelo dono do servidor ou por quem já tem **Administrador**, respeitando a hierarquia do responsável e do bot. **Atenção:** membros que resgatarem o cargo inicial ou atingirem a meta recebem todas as permissões desse cargo. Não há aprovação manual adicional na entrega.
- Cargos com outras permissões de gestão/moderação também podem ser configurados pelo dono ou por um Administrador. Quem tem apenas Gerenciar Servidor continua sem poder configurar esses cargos.
- Alterar metas não rebaixa nem concede novamente um nível já conquistado. Remover um nível da configuração não retira cargos já conquistados nem apaga seu histórico.
- **Recalcular participantes** exige confirmação explícita. Pode rebaixar e remover os cargos de progressão atuais para aplicar as novas metas; não zera horas, a data do resgate nem o histórico de conquistas. O processamento pode ocorrer em etapas conforme os limites da API.
- Membros que saem ficam suspensos, sem apagar sua jornada. Ao retornar, a jornada continua, sem novo resgate. Cargos removidos manualmente pela equipe não são restaurados indiscriminadamente; novas evoluções continuam seguindo o registro e as metas.
- Todos os botões/menus/modais privados e administrativos são vinculados ao solicitante e servidor. Sessões de navegação persistem por até 24 horas; depois, abra o painel novamente. O painel público continua funcionando após reinícios.

## Persistência, falhas e auditoria

Usa o mesmo arquivo **`database/call-stats.sqlite`** (ou `CALL_STATS_FILE`) do contador existente. Adiciona tabelas `up_config`, `up_levels`, `up_members`, `up_operations`, `up_unlocks` e `up_sessions`, além dos intervalos compartilhados `voice_segments` e, quando a verificação de bio está ativa, `up_bio_checks`/`up_bio_roles`. Não apague nem recrie o banco para ativar o UP.

- Resgate e intenção inicial são gravados juntos antes da API; uma evolução pendente é retomada após falha/reinício.
- Adiciona o novo cargo antes de remover o anterior. Se a remoção falhar, ambos podem permanecer temporariamente até a próxima tentativa; o novo cargo não é concedido/logado repetidamente.
- Com remoção automática desativada, conquistas anteriores podem permanecer no membro.
- Alterações reais de cargos passam pela Ficha existente: responsável **bot**, origem **Progressão automática mds**, motivo e horas elegíveis. Nunca atribui uma evolução automática a um administrador. A ficha conserva a proteção contra duplicatas de API/Gateway.
- Notificações são de **tentativa única** para evitar duplicatas após falhas ambíguas. Um timeout, queda exatamente durante o envio ou falta de permissão pode impedir o aviso, mas não desfaz a evolução. O nonce também protege repetições recentes no Discord.
- Se cargos forem apagados ou movidos acima do bot, a etapa pendente aguarda correção; consulte os avisos `[UP]` no terminal.

Faça backup do SQLite respeitando o WAL, como documentado em `VOICE-HOURS.md`. Não rode múltiplas instâncias simultâneas sobre o mesmo banco.

## Testes

Execute `npm test`. Inclui testes com SQLite real para resgate, marcos cumulativos, AFK/mute/exclusões, progressão durante calls, recuperação de falhas, concorrência, recálculo, autoria, configuração via selects/modais, verificação de bio (marcador, perfil privado, cache, remoção/restauração e aviso privado) e proteção de painéis e limites de Components V2. Não substitui validação de permissões no servidor real.
