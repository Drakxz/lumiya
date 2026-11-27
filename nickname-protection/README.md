# Proteção de nomes

Use **`!protecaouser`**. O comando publica somente um botão de abertura; regras, consultas e configurações ficam no painel privado. Todas as interações recarregam o membro e exigem a permissão nativa **Gerenciar Servidor**. Administradores gerais da gestão de tickets não recebem este acesso automaticamente.

## Configuração

1. Clique em **Editar trechos** e informe um trecho por linha, até 50 trechos de 2 a 60 caracteres. A correspondência literal ignora maiúsculas e acentos. Quando disponível, a IA também procura variações disfarçadas dos termos. Não aceita expressões regulares. Evite trechos genéricos, pois afetam todos os nomes que os contêm.
2. Se desejar, selecione um **canal privado de logs**. Mesmo sem canal, os registros ficam no SQLite.
3. Opcionalmente, selecione um canal de avisos para quando a DM estiver fechada. O membro precisa poder ver esse canal; apenas ele é mencionado. O apelido proibido não é publicado no aviso.
4. Ative a proteção. O bot precisa de **Expulsar membros**, intent **Server Members** e hierarquia suficiente para expulsar cada alvo.

É analisado **somente o apelido do servidor (`nickname`)**.
Nome de usuário (`username`) e nome global (`globalName`) são ignorados.
Membros sem apelido são pulados; não há fallback para `displayName`.
Esses nomes da conta não são enviados à IA nem provocam avisos ou expulsões.
Bots são ignorados. Administradores, moderadores e qualquer outro cargo,
inclusive o proprietário do servidor, recebem o aviso normalmente. A expulsão
automática continua sujeita à hierarquia do Discord: o proprietário não é
expulso, mas é avisado e registrado como os demais.

## IA para variações

A configuração atual usa somente **GPT-OSS 20B pelo Amazon Bedrock Mantle**
para nomes, sem Safeguard e sem fallback de modelo. Em HTTP 429, o cliente pausa
e tenta novamente o mesmo modelo.
Foi escolhida autenticação por **chave de API Bedrock**, em **us-east-2 (Ohio)**.
No `.env`:

```env
NICKNAME_AI_PROVIDER=bedrock
NICKNAME_AI_MODEL=openai.gpt-oss-20b
AWS_REGION=us-east-2
AWS_BEARER_TOKEN_BEDROCK=sua_chave_bedrock
# Opcional: token exclusivo para a proteção de nomes
NICKNAME_AI_API_KEY=
```

Quando `NICKNAME_AI_API_KEY` está vazio, a proteção de nomes usa
`AWS_BEARER_TOKEN_BEDROCK`. Preencha o campo para usar um token separado,
sem alterar o token compartilhado com o resto do bot.
O provedor e o modelo continuam definidos por `NICKNAME_AI_PROVIDER` e
`NICKNAME_AI_MODEL`; o campo novo troca apenas a credencial.

Crie a chave na seção **API keys** do console Amazon Bedrock em us-east-2 e
salve-a diretamente no `.env`, sem compartilhar em mensagens.
A chave precisa de acesso aos dois modelos na região.
Esta integração não usa access key/secret key IAM, pois foi escolhida a API key.
Sem chave ou região válida, apenas as regras literais funcionam.
Não há fallback para Groq, Gemini ou para a API da OpenAI.
**O Bedrock pode gerar cobrança**: configure orçamento e confira preços/cotas
da sua conta AWS. Não há promessa de gratuidade.
O envio inclui somente um campo de nome por vez e os termos, nunca IDs ou histórico.

A integração reaproveita o SDK OpenAI com o endpoint
`https://bedrock-mantle.us-east-2.api.aws/v1`, **não** a API da OpenAI.
O endpoint `bedrock-runtime` recusou a chave com `Operation not allowed` (400)
nesta conta; o `bedrock-mantle` respondeu normalmente. A chave usada é exclusivamente `AWS_BEARER_TOKEN_BEDROCK`; não reutiliza
`OPENAI_API_KEY` nem `GROQ_API_KEY`. Chat e verificação de fotos não são alterados.

A validação do JSON, do termo e da confiança é feita localmente.
O `response_format` com JSON Schema foi **removido no Mantle**: testes reais
mostraram respostas travadas e JSON duplicado/ilegível com ele. A instrução pede
somente o objeto JSON; o analisador local aceita cercas de código e trechos
duplicados, extraindo o objeto com `confidence`. Campos de venda ausentes falham
fechados, sem punição. O timeout é de 120 segundos.

Se o Safeguard for configurado e retornar **HTTP 429**, a análise tenta uma
única vez o **`openai.gpt-oss-20b`** no mesmo endpoint Bedrock, com a mesma
chave, instruções e validações. Os IDs do Bedrock Mantle são diferentes dos
usados na Groq.
Enquanto o principal aguarda pelo menos um minuto (ou `Retry-After`, se maior),
novas análises usam o modelo de reserva. Depois, o cliente tenta o principal
novamente. Ambas as chamadas contam para a cota local.
Se a reserva também falhar, há pausa sem punição presumida e sem loop de retries.
Outros erros e resultados inconclusivos não disparam essa troca.
Não há mudança de provedor.
Configuração atual: `NICKNAME_AI_MODEL=openai.gpt-oss-20b`.
Para voltar ao Safeguard com fallback, configure
`NICKNAME_AI_MODEL=openai.gpt-oss-safeguard-20b`.

Provedores anteriores continuam disponíveis explicitamente por
`NICKNAME_AI_PROVIDER=gemini|openai|groq`, com `GEMINI_API_KEY` /
`OPENAI_API_KEY` / `GROQ_API_KEY`.
Se `NICKNAME_AI_MODEL` estiver vazio, usam `gemini-3.5-flash-lite` /
`gpt-4o-mini` / `openai/gpt-oss-20b`, respectivamente.
Não use a chave de um provedor em outro. O endpoint de moderação de imagens
não compara nomes: esta função usa geração de texto do provedor.

Primeiro são verificadas as correspondências literais em todos os campos.
Se não houver nenhuma, os nomes distintos são analisados individualmente pela
IA, podendo consumir mais de uma chamada por membro. O cache e as cotas são
compartilhados. Detecta disfarces como leetspeak, símbolos, espaços e homoglifos,
não sinônimos ou associações vagas. Exige um termo cadastrado e confiança
declarada de pelo menos 0,98; esse número não é garantia de precisão.
Se um campo falhar e nenhum dos demais tiver correspondência confirmada,
a análise do membro fica inconclusiva, sem zerar avisos nem presumir correção.

Falhas, respostas inválidas e resultados incertos não geram avisos ou expulsão por IA. A regra literal permanece funcionando sem chave. O painel mostra a disponibilidade. `NICKNAME_AI_ENABLED=false` desliga a IA. Há cache de seis horas (invalidado ao alterar os termos), duas requisições simultâneas e teto local de 500 tentativas/dia por processo, ajustável por `NICKNAME_AI_DAILY_REQUESTS`. O contador diário reinicia ao reiniciar o processo; não é limite de cobrança do provedor.

As respostas Gemini usam esquema JSON com termo restrito à lista cadastrada.
Partes internas de raciocínio são ignoradas; respostas truncadas, vazias ou
retidas por filtros são identificadas separadamente e nunca geram punição.
Falhas de IA em um membro não derrubam a varredura inteira: **Verificar agora**
mostra um resultado parcial, preserva os avisos/estado dos membros sem conclusão
e programa nova varredura em cinco minutos. Os demais membros continuam sendo
processados. Erros do painel registram códigos numéricos do Discord/HTTP, sem
copiar apelidos, respostas do modelo ou credenciais para o console.

**Verificar agora** mostra o progresso e, ao terminar, **Verificação concluída**
(ou parcial), com pessoas verificadas, membros sem nomes disponíveis, ocorrências
identificadas, avisos realmente entregues no primeiro lote, expulsões
confirmadas, membros em intervalo/nova tentativa e a fila restante.
A IA/modelo configurado também é exibido; sem chave, fica explícito que só houve
comparação literal. Cada lote processa no máximo dez membros, e o intervalo de
**Verificar agora** também reenvia o aviso imediatamente a todas as pessoas
com nome proibido, mesmo se o intervalo de 24 horas ainda não tiver terminado.
O reenvio usa o texto **“Aviso reenviado”**, não aumenta a contagem de avisos,
não altera o próximo prazo automático e nunca dispara expulsão.
A verificação automática (entrada, mudança de nome e manutenção) continua
respeitando o intervalo de 24 horas e o lote de dez pessoas.

Erros HTTP 500/502/503/504 são identificados como indisponibilidade temporária
do provedor, não como chave inválida. O cliente pausa novas chamadas por um
minuto; a manutenção pode tentar novamente depois desse prazo, sem punição
presumida durante a falha. HTTP 400 indica requisição recusada; 401/403,
credenciais/acesso; 404, modelo indisponível; 429, cota ou limite do provedor.

## Avisos e expulsão (kick)

### Opção de vendas na bio/perfil

No painel privado de **`!protecaouser`**, clique em **Ativar vendas** para
habilitar **Vendas na bio/perfil**. O botão vira **Desativar vendas** para
desligar somente essa regra. A opção começa **desativada** e é salva por
servidor; mudanças exigem **Gerenciar Servidor**.

A IA procura ofertas comerciais **somente no apelido do servidor** que convidam a
olhar a bio ou o perfil, como **“nitrada na bio”**, **“nitrada barata na bio”**
e **“nitro barato no perfil”**, incluindo disfarces claros.
Não abre perfis nem lê a bio.
Menções neutras (“estudante de biologia”, “minha biografia”, “olhe meu perfil”
sem oferta comercial) não devem ser classificadas como venda.

Pode funcionar sem trechos personalizados, mas exige a IA configurada e a
proteção geral **Ativada**. A classificação tem confiança independente dos
termos e exige pelo menos 0,98, sem garantia de precisão da IA.
Falhas e ambiguidades não geram punição. A DM explica que o anúncio de vendas
precisa ser removido do apelido do servidor.

A regra usa os **mesmos avisos acumulados**, intervalo de **24 horas** e
expulsão no terceiro aviso da proteção existente; não cria uma contagem extra.
Desativar vendas não zera avisos e invalida resultados de análises em andamento.
Se não houver trechos personalizados e a opção for desativada, a proteção
geral também é desativada para não ficar ligada sem regras.

### Política de avisos

- O primeiro aviso é enviado ao detectar um nome proibido. Um segundo aviso só pode ser entregue após **24 horas** e o terceiro após mais 24 horas, enquanto algum nome permanecer proibido.
- Os avisos são **acumulados por membro e servidor**. Corrigir ou remover o apelido interrompe as cobranças; o histórico permanece após corrigir, sair/retornar e reiniciar.
- Reiniciar depois de um período offline não gera vários avisos de uma vez: no máximo um por verificação, sempre com novo intervalo de 24 horas.
- Só aumenta a contagem quando o Discord aceita o aviso por DM ou pelo canal acessível configurado. Se não for possível entregar, não há incremento nem expulsão silenciosa; uma nova tentativa é feita após 24 horas e a falha fica registrada. Isso não comprova leitura da mensagem pelo usuário.
- No terceiro aviso, o bot confirma novamente os nomes atuais, a configuração, as permissões e a hierarquia antes de tentar expulsar. Usa **kick, nunca banimento**, e não exclui mensagens. O membro pode retornar usando um convite válido.
- Se a expulsão falhar, a contagem fica em três e as tentativas seguintes respeitam um intervalo de 24 horas, sem quarto aviso. Falhas não são apresentadas como sucesso.
- Administradores podem consultar e zerar avisos com confirmação. Isso preserva auditoria e concede 24 horas antes de nova cobrança. Se o membro retornar após um kick, o histórico acumulado permanece; novas tentativas também respeitam o prazo existente.
- A migração preserva registros de banimentos anteriores, mas não os desfaz automaticamente. Os novos eventos usam campos próprios de expulsão (`kickedAt` e `lastKickAttemptAt`).

## Verificações e persistência

Eventos de entrada e alteração de apelido são verificados com consulta individual
atual. Atualizações de nome de usuário/global não disparam verificações.
Membros ausentes são ignorados. Mudanças de apelido ou regras
durante a chamada invalidam o resultado antigo.
A manutenção roda a cada minuto em lotes de até dez membros; os prazos de 24
horas são mínimos, podendo haver atraso de fila. Varreduras compartilham o
cache/controle de limite do projeto, são retomadas na inicialização e repetidas
periodicamente. Erros não são tratados como violações.
O sistema só opera enquanto o bot estiver online.

São usadas as tabelas `nickname_protection_config`, `nickname_protection_users` e `nickname_protection_audit` no SQLite existente, sem alterar tickets, cargos, mídia ou contagens anteriores. A proteção começa **desativada**. Testes locais não substituem validação no Discord real, sobretudo para DMs, canais de aviso e hierarquia do bot.
