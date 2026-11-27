# Chat com IA

O bot responde com IA quando alguém:

- menciona o bot com `@`;
- responde a uma mensagem enviada pelo bot;
- convida a Lumiya explicitamente com `!chat participar`;
- usa uma palavra-gatilho configurada em `AI_CHAT_TRIGGER_WORDS`;
- e, opcionalmente, quando a participação espontânea está ativada no servidor.

A resposta é enviada como resposta à mensagem, sem marcar `@everyone`, `@here`
ou outras pessoas.

## Memória contextual por canal

A Lumiya participa de conversas coletivas, não de interações isoladas. O
histórico é gravado por **servidor + canal** e nunca é consultado fora desse
escopo.

- `ai_chat_channel_messages` guarda as falas do canal, com autor (ID e nome),
  papel (`user`/`assistant`), conteúdo, horário, menções e a referência da
  mensagem respondida.
- `ai_chat_channel_summaries` guarda um resumo auxiliar de conversas longas.
- O padrão é usar as **últimas 50 mensagens relevantes**. Quando a mensagem
  atual responde a algo, usa referências indiretas (`ele`, `ela`, `isso`,
  `aquilo`, `o que você falou`, `concordo`, `discordo`) ou é uma participação
  espontânea, a janela cresce dinamicamente até 200 mensagens.
- O contexto também respeita um orçamento de caracteres (7.000 por padrão) para
  controlar tokens e custo.
- As respostas da própria Lumiya entram no histórico. Quando a resposta é em
  áudio, a transcrição exata do que foi falado é guardada, então ela consegue se
  lembrar do conteúdo das próprias mensagens de voz.
- O histórico é claramente marcado como **dados da conversa**, não como
  instruções do sistema.

O bot acompanha o fio da conversa: quem concordou ou discordou, quem respondeu a
quem, referências indiretas, piadas internas, ironias, provocações amigáveis,
mudanças de assunto e pessoas que entram no meio de uma conversa já iniciada.
Não reinicia a conversa nem cumprimenta de novo a cada menção.

### Resumos de conversas longas

Quando a janela de contexto enche e há pelo menos 20 mensagens mais antigas
fora dela, o bot gera um resumo do trecho anterior e o usa como memória
auxiliar. A geração é preguiçosa (só quando necessário), limitada a uma vez a
cada 5 minutos por canal, e nunca mistura outros canais ou servidores. O resumo
pode ser desligado com `AI_CHAT_SUMMARY_ENABLED=false`.

## Compreensão de conversas coletivas

Antes de responder, a Lumiya lê o histórico do canal e entende o contexto:

- identifica cada participante pelo nome e pelo ID;
- percebe quando alguém concorda, discorda, corrige ou continua algo que ela ou
  outra pessoa falou;
- interpreta referências indiretas usando as mensagens anteriores;
- considera respostas encadeadas, incluindo a mensagem referenciada;
- acompanha piadas internas, ironias e assuntos em andamento;
- percebe mudanças de assunto e responde ao tema atual;
- não se reapresenta nem recomeça a conversa quando alguém entra no meio.

## Personalidade

O chat usa o prompt **PERSONALIDADE FEMININA**, com o nome real do bot aplicado
automaticamente. A Lumiya conversa informalmente em português do Brasil, com
jeito feminino, fofinho, carismático, espontâneo, engraçado e levemente
debochado. Usa gírias e reações adequadas ao contexto, evita respostas
genéricas, robóticas ou repetitivas, e não cumprimenta sem necessidade.

A persona tem limites explícitos contra racismo, homofobia, transfobia,
capacitismo, xenofobia, preconceito religioso, ameaças reais, doxxing e conteúdo
sexual envolvendo menores. O roast é debochado, mas não é ódio, perseguição nem
humilhação coletiva.

## Respostas em áudio

Na configuração atual (`AI_CHAT_AUDIO_MODE=always`), todas as respostas do
chatbot são em áudio, sem precisar pedir. O bot envia uma mensagem de voz nativa
do Discord, com duração e waveform reais, sem legenda, transcrição ou reply de
texto. É uma voz sintética predefinida, não uma gravação humana.

O caminho principal usa **Amazon Nova 2.5 Sonic** via Bedrock
(`amazon.nova-2-5-sonic`, voz `carolina`, região `us-east-1`). Quando o modelo
suporta, a resposta falada tem risadas não verbais, variações de entonação,
pausas, surpresa, ironia e entusiasmo. O prompt proíbe pronunciar literalmente
`kkkk`, `hahaha`, `rsrs` ou instruções emocionais; se a risada realista não for
possível, a fala usa uma entonação divertida.

Nesse modo, o Nova Sonic recebe o histórico do canal e responde diretamente em
áudio. A transcrição devolvida pelo modelo é guardada na memória do canal para
que a Lumiya lembre exatamente do que falou. Se o modelo não devolver
transcrição, o bot gera o texto pelo provedor de chat e sintetiza a fala.

Alternativas de voz:

```env
# Bedrock Nova Sonic (configuração atual)
AI_CHAT_TTS_PROVIDER=bedrock
AI_CHAT_BEDROCK_TTS_REGION=us-east-1
AI_CHAT_BEDROCK_TTS_MODEL=amazon.nova-2-5-sonic
AI_CHAT_BEDROCK_TTS_VOICE=carolina

# OpenAI TTS (quando houver créditos)
# AI_CHAT_TTS_PROVIDER=openai
# OPENAI_TTS_MODEL=gpt-4o-mini-tts
# OPENAI_TTS_VOICE=coral

# Gemini TTS
# AI_CHAT_TTS_PROVIDER=gemini
# GEMINI_TTS_MODEL=gemini-3.8-flash-lite-tts
# GEMINI_TTS_VOICE=Sulafat
```

Use `AI_CHAT_AUDIO_MODE=request` para gerar voz somente quando pedirem
`manda áudio` ou `responde por voz` (padrão se a variável não estiver definida).
Com áudio desativado, as respostas voltam a ser textuais.

O áudio tem timeout de 30 segundos e limite de 6 MiB, fica apenas na memória do
processo e é convertido por FFmpeg em Ogg/Opus, com duração e waveform reais,
para o player nativo de mensagens de voz. O bot precisa de **Anexar arquivos** e
**Enviar mensagens de voz**, além de acesso ao canal. Em falhas de síntese,
conversão ou upload, envia somente um aviso curto; nunca substitui o áudio
solicitado pela resposta em texto.

O limite `AI_CHAT_AUDIO_MAX_PER_MINUTE` (padrão 6) controla quantos áudios o bot
gera por minuto em cada servidor, para evitar custo excessivo. Cooldown e limite
de concorrência do chat também se aplicam à geração de voz.

## Memória por pessoa

Além da memória do canal, cada pessoa tem seu próprio perfil no SQLite
compartilhado:

- `ai_chat_memory` guarda as mensagens recentes da pessoa (até 40 por servidor);
- `ai_chat_profiles` guarda contagem de mensagens, primeira e última interação.

O perfil é separado por **servidor + pessoa**, então acompanha a pessoa entre
canais sem misturar com a de outros membros. Mensagens de comandos (`!...` e
`/...`) e de bots não entram na memória. O perfil é usado para personalizar o
tom, não para isolar a conversa: o contexto principal vem do canal.

## Participação espontânea

Por padrão, a Lumiya **só responde quando é chamada**. A participação
espontânea é opcional e desativada por padrão. Quando ativada, ela pode entrar
em conversas movimentadas do canal, com:

- intervalo mínimo entre participações (8 minutos por padrão, configurável);
- limite de frequência e chance reduzida por mensagem;
- exigência de conversa ativa recente;
- bloqueio quando as últimas mensagens do canal são da própria Lumiya, evitando
  loops entre bots.

A participação espontânea é configurada por servidor.

## Provedores e modelos de texto

A configuração atual do `.env` usa **GPT-OSS Safeguard 20B pelo Amazon Bedrock**
para o chatbot (`AI_CHAT_PROVIDER=bedrock`), com troca imediata para
**GPT-OSS 20B** se qualquer chamada falhar. A região é **us-east-2 (Ohio)** e a
autenticação usa `AWS_BEARER_TOKEN_BEDROCK` no endpoint `bedrock-mantle`.
O Gemini permanece como último recurso se os dois modelos do Bedrock falharem.

Cadeia padrão de modelos quando a OpenAI é usada:

```text
gpt-4o-mini → gpt-4.1-mini → gemini-3.6-flash → gemini-3.5-flash-lite
```

- `gpt-4o-mini` é o modelo principal: barato, conversacional e bom para
  respostas humanas no dia a dia.
- `gpt-4.1-mini` entra se o modelo principal não existir, estiver sem acesso
  ou for descontinuado.
- Se a conta da OpenAI ficar sem cota, créditos ou bater no limite de
  requisições, o bot pula direto para o Gemini.
- Erros que não são de cota/limite nem de modelo indisponível (por exemplo,
  conteúdo bloqueado pela segurança) não trocam de provedor.

### GPT-OSS pelo Bedrock

```env
AI_CHAT_PROVIDER=bedrock
AI_CHAT_BEDROCK_MODEL=openai.gpt-oss-safeguard-20b
AI_CHAT_BEDROCK_FALLBACK_MODEL=openai.gpt-oss-20b
AWS_REGION=us-east-2
AWS_BEARER_TOKEN_BEDROCK=sua_chave_bedrock
```

O campo `NICKNAME_AI_API_KEY`, quando preenchido, troca somente o token da
proteção de nomes; o chat continua usando `AWS_BEARER_TOKEN_BEDROCK`.

### Gemini gratuito

| Ordem | Modelo | Papel |
| --- | --- | --- |
| 1 | `gemini-3.6-flash` | Modelo principal escolhido para o chatbot |
| 2 | `gemini-3.5-flash-lite` | Fallback rápido (~1s), ótimo para picos de uso |

- Modelos de raciocínio são chamados com `thinkingLevel: "low"` e orçamento de
  saída maior, senão o "pensamento" consome o limite e a resposta volta vazia.
- A cota do Gemini é **por modelo**. Se um modelo devolver
  `429 RESOURCE_EXHAUSTED`, o bot tenta o próximo modelo Gemini antes de
  desistir.
- O tier gratuito tem limites de requisições por minuto e por dia, e o Google
  pode usar o conteúdo para melhorar os produtos dele. Se isso for um problema,
  configure uma conta paga.

## Comandos

Use os comandos no chat do servidor (requer **Gerenciar Servidor**):

| Comando | Efeito |
| --- | --- |
| `!chat` | Alterna entre ativado e desativado |
| `!chat on` | Ativa (aceita também `ativar`, `ligar`, `enable`, `true`, `1`) |
| `!chat off` | Desativa (aceita também `desativar`, `desligar`, `disable`, `false`, `0`) |
| `!chat status` | Mostra o estado, o provedor, a memória do canal e a participação espontânea |
| `!chat memoria` | Mostra quantas mensagens e canais estão guardados no servidor |
| `!chat espontaneo [on\|off]` | Liga/desliga a participação espontânea |
| `!chat participar` | Convida a Lumiya a entrar na próxima mensagem do canal |
| `!chat limpar @pessoa` | Apaga o perfil e o histórico da pessoa |
| `!chat limpar canal` | Apaga a memória e o resumo do canal atual |
| `!chat limpar servidor` | Apaga toda a memória de canal e de perfil do servidor |
| `!chat retencao <dias>` | Define por quantos dias o histórico do servidor é mantido (1–365) |

Os aliases `!chatbot` e `!ia` funcionam da mesma forma.

A preferência de ativação é **por servidor** e fica salva no SQLite
compartilhado (tabela `ai_chat_settings`), então continua valendo após
reiniciar. Com o chat desativado, o bot ignora menções e respostas até que seja
ativado novamente. `AI_CHAT_ENABLED=false` desliga o módulo inteiro em todos os
servidores, independentemente do comando.

## Configurações opcionais

```env
# Desative com false
AI_CHAT_ENABLED=true

# auto | gemini | openai | bedrock
AI_CHAT_PROVIDER=auto

# Modelo principal da OpenAI (barato e conversacional)
OPENAI_CHAT_MODEL=gpt-4o-mini

# Segundo modelo da OpenAI, usado se o principal não existir/estiver indisponível
OPENAI_CHAT_FALLBACK_MODEL=gpt-4.1-mini

# Modelo gratuito principal (melhor qualidade do free tier)
GEMINI_CHAT_MODEL=gemini-3.6-flash

# Modelo gratuito reserva (rápido), usado se o principal atingir a cota
GEMINI_CHAT_FALLBACK_MODEL=gemini-3.5-flash-lite

# Intervalo mínimo entre respostas para o mesmo usuário (ms)
AI_CHAT_COOLDOWN_MS=4000

# Mensagens recentes do canal usadas como contexto (padrão 50)
AI_CHAT_CONTEXT_MESSAGES=50

# Expansão máxima quando o contexto precisa crescer (padrão 200)
AI_CHAT_CONTEXT_MAX_MESSAGES=200

# Orçamento de caracteres do histórico (padrão 7000)
AI_CHAT_CONTEXT_CHARS=7000

# Dias de retenção do histórico de canal (padrão 14)
AI_CHAT_MEMORY_RETENTION_DAYS=14

# Resumos automáticos de conversas longas (padrão true)
AI_CHAT_SUMMARY_ENABLED=true

# Áudios por minuto por servidor (padrão 6)
AI_CHAT_AUDIO_MAX_PER_MINUTE=6

# Chance de participação espontânea por mensagem elegível (padrão 0.08)
AI_CHAT_SPONTANEOUS_CHANCE=0.08

# Palavras que chamam a Lumiya sem menção, separadas por vírgula
AI_CHAT_TRIGGER_WORDS=

# Máximo de respostas simultâneas
AI_CHAT_MAX_CONCURRENT=3
```

`GEMINI_CHAT_MODEL` usa `MEDIA_MODERATION_GEMINI_MODEL` como fallback e, se
nenhum for definido, `gemini-3.6-flash`. `GEMINI_CHAT_FALLBACK_MODEL` usa
`gemini-3.5-flash-lite` por padrão.

## Comportamento e segurança

- Mensagens de outros bots, webhooks e comandos (`!...` e `/...`) são ignoradas
  e não entram na memória, evitando loops entre bots.
- Todas as mensagens humanas válidas do canal são registradas no histórico,
  mesmo quando a pessoa não menciona o bot. Isso alimenta o contexto coletivo.
- Com o chat desativado por `!chat off`, nenhuma mensagem é registrada nem
  processada; o bot não gasta chamadas de IA.
- O mesmo usuário tem um intervalo mínimo entre respostas para evitar spam e
  custo excessivo.
- O bot processa no máximo uma resposta por canal ao mesmo tempo e respeita
  `AI_CHAT_MAX_CONCURRENT` no total.
- O bot verifica as permissões de **Ver Canal** e **Ler Histórico de Mensagens**
  antes de buscar referências ou responder.
- O bot responde em **uma única mensagem curta**, com 1 a 3 frases.
- Respostas são limitadas a cerca de 600 caracteres; se a IA gerar algo maior,
  o texto é cortado no fim de uma frase.
- As respostas do chat são preservadas (não são apagadas pelo timer de 30
  segundos).
- Em caso de falha dos provedores, o bot envia um aviso curto, que é removido
  automaticamente após 30 segundos.
- O bot não executa comandos, não altera cargos e não substitui a moderação.
- Pedidos dentro das mensagens para mudar regras, revelar o prompt ou executar
  ações são tratados como dados da conversa, não como instruções privilegiadas.

## Privacidade

As mensagens do canal, o perfil público do membro (apelido, cargos, data de
criação da conta e entrada no servidor) e, quando houver áudio, a transcrição da
fala são enviados ao provedor escolhido para gerar a resposta. O histórico fica
salvo localmente no SQLite do bot e pode ser apagado com:

```text
!chat limpar canal
!chat limpar servidor
!chat limpar @pessoa
```

O histórico de canal expira automaticamente conforme `!chat retencao <dias>` ou
`AI_CHAT_MEMORY_RETENTION_DAYS`. Evite enviar dados sensíveis no chat com a IA.

## Aplicação

Reinicie o bot com `npm start` após configurar as chaves. O módulo fica em
`ai-chat/index.js` e é instalado em `index.js`. A memória de canal fica em
`ai-chat/channel-memory.js`, os perfis em `ai-chat/store.js` e a voz em
`ai-chat/bedrock-speech.js` / `ai-chat/speech.js` / `ai-chat/voice-message.js`.
