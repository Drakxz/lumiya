# Erros e recusas

As respostas de erro e acesso negado no Discord usam exclusivamente:

`<a:1175261181741641789:1569933923641983038>`

O padrão está centralizado em `error-ui.js`:

- `errorText(texto)` para respostas sabidamente de erro, inclusive validações.
- `statusText(texto)` para renderizadores compartilhados de painéis; verifica
  somente o título, preservando mensagens de sucesso e revisão neutra.

Mantenha os erros de novos módulos usando `errorText`. O helper preserva títulos
e negrito, não duplica o emoji e corrige sua forma estática para a animada.
Não altera permissões, punições, menções nem regras de acesso.

Reinicie o bot para carregar alterações. Mensagens já enviadas não são
reescritas retroativamente; o padrão vale para novas respostas.
