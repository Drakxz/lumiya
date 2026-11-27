# Voz pelo Amazon Bedrock

Integração opcional com Amazon Nova 2.5 Sonic (pago), voz `carolina`.
No modo de voz, o modelo responde à conversa e gera fala na mesma sessão,
usando o prompt de personalidade definido em `bedrock-speech.js` e o histórico
do canal como contexto. O PCM retornado é convertido para a mensagem de voz
Ogg/Opus do Discord. O chat de texto mantém o provedor e a personalidade já
configurados.
O protocolo de fala exige um fluxo de áudio aberto; para respostas acionadas
por texto, o bot envia apenas quadros curtos de silêncio, nunca uma gravação.

A transcrição devolvida pelo Nova Sonic é gravada na memória do canal
(`ai_chat_channel_messages`, `source=voice`). Assim a Lumiya lembra exatamente
o que falou nas mensagens de voz anteriores. Se o modelo não devolver
transcrição, o bot gera o texto pelo provedor de chat e usa o TTS como
alternativa. A personalidade falada pede risadas não verbais e entonação
natural, sem pronunciar `kkkk`, `hahaha` ou `rsrs`.

## Autenticação obrigatória

Configure credenciais IAM na máquina do bot:
perfil AWS, credenciais temporárias ou `AWS_ACCESS_KEY_ID` e
`AWS_SECRET_ACCESS_KEY` (com `AWS_SESSION_TOKEN` se temporárias).
Não envie segredos no chat. O principal precisa de acesso ao modelo e às
ações `bedrock:InvokeModel` e `bedrock:InvokeModelWithBidirectionalStream`.

Referência: https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-reference.html

O padrão usa `amazon.nova-2-5-sonic` em `us-east-1`, voz `carolina`.
Após liberar o modelo e as permissões de streaming nessa região, as opções podem
ser ajustadas no `.env`:

```env
AI_CHAT_TTS_PROVIDER=bedrock
AI_CHAT_BEDROCK_TTS_REGION=us-east-1
AI_CHAT_BEDROCK_TTS_MODEL=amazon.nova-2-5-sonic
AI_CHAT_BEDROCK_TTS_VOICE=carolina
```

Reinicie o bot e valide um envio real. A integração não troca silenciosamente
para outro provedor se o Bedrock falhar. Cada resposta abre uma sessão curta,
limitada por tempo e tamanho de áudio.
