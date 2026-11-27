# Whitelist de cargos

`!wlcargos` abre o painel privado. Somente o dono do servidor e administradores
autorizados no painel podem alterar as regras.

## Presets

Em **Presets** é possível criar, editar e excluir modelos de whitelist. Cada
preset guarda cargo máximo, cargos permitidos, bloqueados e protegidos, além da
opção de ver histórico.

- **Aplicar**: escolhe a pessoa e abre a ficha com o preset já preenchido. Você
  confirma a duração e salva.
- **Vincular cargo**: associa um ou mais cargos do servidor ao preset. Quem já
  possui ou receber o cargo usa o preset automaticamente, inclusive se o cargo
  for concedido diretamente pelo Discord. Edições no preset valem no próximo
  acesso, sem retirar e conceder o cargo de novo. Um cargo tem apenas um preset.
- Se a pessoa possui vários cargos vinculados, vale o de maior posição no Discord.
  Ele tem prioridade sobre a configuração individual ativa, mas nunca contorna
  uma autorização suspensa, revogada ou expirada.
- **Desvincular**: remove o acesso herdado desse vínculo sem apagar o preset nem
  autorizações individuais já concedidas.

A vinculação respeita a hierarquia: o cargo precisa existir, não ser gerenciado
por integração e ficar abaixo do cargo mais alto do bot.

Quando o preset é excluído, seus vínculos são removidos. As autorizações já
aplicadas permanecem, pois são independentes do modelo. Presets e vínculos são
salvos no SQLite e incluídos nos backups de configuração do servidor.

Sem cargo vinculado, a autorização individual continua sendo usada. Se ela
apontar para um cargo máximo realmente excluído, edite o limite em `!wlcargos`;
o bot não substitui cargos antigos por outros de nome semelhante.
