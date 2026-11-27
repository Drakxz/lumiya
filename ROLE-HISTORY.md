# Ficha do usuário — cargos e banimentos

## Canal de histórico de adições

As novas adições confirmadas na auditoria são publicadas no canal
`1571711957927469096`, com executor (pessoa ou bot), membro, cargos, data e ID
da auditoria. Nas operações internas identificadas pelo marcador da MDS,
também aparece quem solicitou a alteração.

Registra adições da própria MDS e de terceiros, mesmo se a proteção remover o
cargo depois. Não envia pings e os registros são preservados da limpeza
automática. A entrega é deduplicada no SQLite compartilhado do bot.
Não importa eventos antigos. O canal precisa estar no mesmo servidor da
alteração; não exporta dados para outro servidor.

O bot precisa de **Ver registro de auditoria**, **Ver canal** e
**Enviar mensagens**. Falhas no envio do histórico não interrompem a proteção.
Opcionalmente, `ROLE_ADDITION_LOG_CHANNEL_ID` substitui o canal padrão.

## Proteção contra adições externas

Adições recentes confirmadas no registro de auditoria são revertidas quando
o executor não é a própria MDS, exceto nas autorizações abaixo.
Pessoas com o cargo mais alto **acima do cargo mais alto da MDS** podem
adicionar diretamente pelo Discord, sem reversão. O dono também é autorizado.
A comparação usa a posição real, não apenas a permissão Administrador:
mesmo nível e abaixo continuam sujeitos à proteção.
O executor é consultado novamente para não usar uma hierarquia em cache.
Se a consulta falhar, não há reversão nessa tentativa.
Essa liberação não se estende a outros bots pela posição.
As adições feitas pela MDS (painéis e automações internas, como UP) permanecem.
O cargo `1560458283117191188` também pode ser adicionado por pessoas ou outros
bots: não é removido pela proteção, mas continua registrado no canal de histórico.
O bot `1568767491713409125` é um executor autorizado: os cargos adicionados por
ele são preservados e continuam registrados no histórico. Esse ID não é uma
exceção de cargo.
Essa exceção não libera outros cargos adicionados na mesma operação.
A remoção também é registrada no histórico, com o executor externo identificado.

Requer **Ver registro de auditoria** e **Gerenciar Cargos**. Cargos gerenciados
pelo Discord e cargos iguais ou superiores ao cargo mais alto da MDS não são
removidos. Sem autoria confirmada, a proteção não remove por suposição.
Não faz limpeza retroativa de cargos antigos nem reverte remoções externas.

## Uso

- `!ficha @usuário` ou `!ficha ID`: consulta no canal. As abas Cargos e Banimentos trocam o conteúdo na mesma mensagem; os registros ficam visíveis a quem tem acesso ao canal.
- `/ficha usuario:@usuário`: consulta privada. O comando é registrado ao iniciar, sem remover outros comandos slash; comandos globais podem levar um tempo para aparecer.
- **Ficha do usuário** no `!cargos`: consulta privada do alvo atual. **Voltar ao gerenciamento** fecha a ficha privada e renova o prazo do painel original, preservando filtros e página. Se ele já expirou pelos 30 segundos de inatividade, é necessário abrir `!cargos` novamente.
- Apenas o solicitante autorizado pode navegar, pesquisar ou abrir detalhes de uma ficha.
- Abas **Cargos** e **Banimentos**, com pesquisa, filtros e páginas independentes.
- Cargos: quatro registros por página, ou três quando há botão de retorno ao gerenciamento. Pesquisa por nome histórico ou ID.
- Banimentos: quatro registros por página, com filtros de banimentos/desbanimentos e busca por motivo, ID do responsável ou ID do registro.

### Aba Banimentos

Lê os registros já existentes em `bot_ban_audit`, no SQLite compartilhado, sem
duplicar dados no JSON de cargos. Mostra alvo, responsável, motivo, data e hora
em Brasília, resultado, limpeza de mensagens solicitada e ID do registro.
Inclui operações com falha e pendentes, identificadas separadamente e sem
contá-las como banimentos confirmados.

Segue as mesmas permissões da ficha (inclusive autorização pela whitelist),
sem exigir **Banir Membros**, com checagem atualizada em cada interação.
As abas atualizam a mesma mensagem; no slash a consulta permanece privada,
e no prefixo permanece no canal. Os registros são limitados ao usuário e
servidor selecionados. Não importa punições manuais antigas do Discord;
mostra o que foi registrado pelo sistema de banimento do bot.

## Configuração obrigatória no Discord

1. Developer Portal → aplicação → Bot → Privileged Gateway Intents → **Server Members Intent** ativada.
2. Permissão **Ver registro de auditoria** para o bot, para tentar identificar alterações externas.
3. Permissões **Gerenciar Cargos**, ver canais e enviar mensagens para os sistemas existentes. Os cargos alteráveis precisam continuar abaixo do cargo do bot.

Sem auditoria acessível ou com autoria ambígua, o registro fica **Não identificado**. A data é a de observação quando não há um registro de auditoria confirmado. Nos detalhes, isso é explicitado.

## Configuração opcional no `.env`

```dotenv
# Permissão da equipe que pode consultar fichas. Administradores também podem.
HISTORY_PERMISSION=ManageRoles
# Opcional: caminho absoluto alternativo para a persistência.
# ROLE_HISTORY_FILE=C:\caminho\role-history.json
```

## Persistência e limites

`role-history.json` é criado automaticamente, com gravação atômica e índices em memória por servidor/membro e ID. Não requer novas dependências. Faça backup desse arquivo; ele contém dados administrativos. Não apague junto com tickets ou membros que saíram.

O histórico começa na instalação e só registra eventos observados ou operações confirmadas do painel. Não há reconstrução fictícia do período em que o bot estava offline. O nome histórico permanece após exclusão de um cargo.

Alterações externas são correlacionadas por tipo de auditoria, alvo, cargo, adição/remoção e janela de tempo; múltiplos candidatos ficam sem autoria. O painel grava a intenção antes da API, o solicitante real após sucesso e o bot como executor técnico. Intenções interrompidas só são recuperadas com o token exato no motivo da auditoria; se a evidência não estiver mais disponível, não viram alterações confirmadas.

Para volumes muito grandes, migre o armazenamento JSON para SQLite: a solução atual mantém o histórico em memória e regrava o arquivo nas alterações. Não execute múltiplas instâncias simultâneas sobre o mesmo arquivo.
