# Central de Comandos | mds

## Uso

- **`!comandos`**: consulta normal no canal, com navegação exclusiva de quem pediu.
- **`/comandos`**: a mesma consulta em resposta privada (ephemeral).
- **`!painelcomandos`** ou **`!painelcomandos #canal`**: publica/atualiza o painel permanente. Exige **Gerenciar Servidor** (`ManageGuild`). Repetir no mesmo canal edita a mensagem conhecida, sem publicar uma cópia.

Reinicie com `node .` após instalar os arquivos. Não há dependências novas; continua usando Node.js 22.13+ e o SQLite existente. O bot precisa ver o canal e enviar mensagens; para buscar/atualizar painéis já enviados, precisa também ler o histórico.

## Tickets em tópicos privados

Os botões dos painéis de **suporte** e **migração** agora abrem tópicos privados no canal de texto onde cada painel está publicado. O usuário solicitante é adicionado ao tópico. Os cargos configurados para menção são mencionados na mensagem inicial, mas **os membros da equipe não são adicionados automaticamente**. O cargo/equipe de atendimento precisa ter **Ver Canal** e **Gerenciar Tópicos** no canal-pai para visualizar e acompanhar tópicos privados; o bot precisa de **Criar Tópicos Privados**, **Enviar Mensagens em Tópicos** e **Gerenciar Tópicos**. Mantenha o canal-pai visível à equipe. Tópicos ativos já registrados impedem a abertura de um segundo ticket do mesmo tipo pelo mesmo membro.

Os controles existentes de assumir, encerrar e adicionar/remover participantes continuam no tópico. Fechar exclui o tópico após o período de encerramento já configurado. `CATEGORY_ID` deixa de determinar a localização de novos tickets: a localização passa a ser o canal do painel clicado. Canais de fórum, tópicos e outros canais que não sejam canais de texto normais não servem como canal-pai.

Os controles de um painel permanente abrem uma **consulta privada individual**. Assim, vários membros podem navegar ao mesmo tempo sem substituir a página pública ou interferir uns nos outros. Selecionar categoria, pesquisar, abrir detalhes e voltar na consulta pessoal edita a mesma resposta.

## Catálogo real e compartilhado com a execução

`command-system/registry.js` é a fonte única do catálogo e o despachante de prefixos/slash. Os antigos handlers digitáveis foram registrados com suas definições; tickets, menus e botões internos continuam nos handlers existentes e não viram comandos fictícios.

O catálogo contém as entradas lógicas realmente implementadas: suporte, migração, gerenciamento de cargos, ficha, horas, UP público, administração de UP, CL e os comandos da própria Central. Variantes com argumentos, aliases e versões prefixo/slash **não são contadas como comandos adicionais**.

Comandos slash só aparecem como formas disponíveis depois de uma criação/atualização bem-sucedida na API do Discord. Se o registro slash falhar, uma versão de prefixo funcional continua disponível. A propagação de comandos globais na interface do Discord pode demorar.

## Adicionar novos comandos, sem editar a Central

Crie arquivos **`.js` ou `.cjs`** em **`commands/`**. Essa pasta é carregada automaticamente pelo `index.js` na inicialização; pode ser criada quando houver o primeiro comando adicional.

Cada arquivo exporta uma definição (ou array de definições), com:

- `name`: identificador lógico minúsculo, único, com letras, números, `_` ou `-`.
- `description`: descrição real e curta.
- `category`: categoria real; categorias vazias nunca são exibidas.
- `permissions`: nomes oficiais de `PermissionFlagsBits`, quando necessários.
- `public`: `false` para uma entrada interna que nunca deve aparecer na Central.
- `result` e `examples`: detalhes opcionais de uso.
- `prefix`: objeto com `trigger`, `execute(message)`, `usage` opcional, `aliases` opcionais e políticas `exact`, `caseInsensitive`, `trimLeading` quando necessárias.
- `slash`: objeto com `data` (`SlashCommandBuilder` ou JSON oficial), `execute(interaction)` e `usage` opcional.

A definição precisa ter pelo menos um executor. A versão slash deve ter o mesmo nome lógico. Comandos com ambas as formas ficam na **mesma definição**, para evitar duplicação na contagem.

Se o módulo precisar de serviços existentes, pode exportar uma função que recebe `{ client, registry, horasCall, fichaCargos }` e **retorna** as definições. O executor deve responder às interações no prazo e usar Components V2 conforme o padrão do projeto. Não crie outro Client/login ou um segundo listener digitável para esses mesmos comandos.

Módulos integrados diretamente podem usar `registry.register(definition)`. Registrar novamente o mesmo nome atualiza seus metadados e executores; `registry.unregister(name)` remove a entrada e sua execução. Conflitos de prefixos/aliases são rejeitados.

Para recarregar extensões em um mecanismo de hot reload já existente, use novamente `registry.loadDirectory(directory, context)`. Ele limpa o cache dos arquivos daquela pasta e detecta adições, edições e remoções. Definições inválidas não substituem o catálogo anterior. Não há watcher de arquivos nem comando público de recarga: arquivos novos passam a valer no reinício ou nessa recarga explícita.

**Nenhuma dessas operações exige alterar o código de `command-center/`.**

## Atualização dos painéis publicados

No mesmo SQLite do contador, são criadas:

- `command_center_panels`: servidor, canal, mensagem, identificador do painel e hash do catálogo.
- `command_center_sessions`: filtros, página, pesquisa e solicitante, com validade de 24 horas.
- `command_center_remote`: IDs slash gerenciados pelo registro.

Ao iniciar, o registro sincroniza seus slash e a Central compara os hashes. Painéis desatualizados são buscados e **editados**, sem reenvio automático. Alterações do catálogo em runtime também provocam atualização, agrupadas por um debounce curto.

Se a mensagem sumir ou faltar acesso, a falha é registrada no terminal. A atualização automática **não publica outra mensagem** para tentar contornar o erro. Um administrador pode usar `!painelcomandos` novamente: se a mensagem foi apagada, publica uma nova; se ainda existe, tenta editá-la. Mensagens de outro autor nunca são editadas como se pertencessem ao bot.

Somente comandos slash cujos IDs foram armazenados como gerenciados pelo registro são removidos da API quando saem do catálogo. Outros comandos da aplicação não são apagados em massa.

## Visibilidade e segurança

Por padrão, a consulta pessoal mostra apenas os comandos públicos que o membro pode executar. Administradores veem também os administrativos autorizados. Entradas com `public: false` ficam ocultas em qualquer painel.

Opcional no `.env`:

```dotenv
COMMAND_CENTER_SHOW_RESTRICTED=true
```

Com essa opção, comandos públicos restritos também aparecem para consulta, identificados com a permissão exigida e sem autorização de execução. Os handlers e o registro continuam validando as permissões reais.

O painel permanente exibe os totais do catálogo público registrado; a consulta aberta por ele aplica a política pessoal acima. Não há categorias fictícias ou campos preenchidos com exemplos de contagem.

Categorias usam grupos de até 24 + a opção Todas, respeitando as 25 opções por menu. Listas têm quatro comandos por página; detalhes vêm dos mesmos metadados usados no registro. Os limites de texto e componentes são validados e testados.

IDs persistentes de painéis continuam válidos após reinícios. Sessões pessoais expiradas devem ser abertas novamente com `!comandos` ou `/comandos`.

## Testes

`npm test` executa os testes de registro, descoberta/recarga, permissões, categorias, busca, paginação, detalhes, persistência e atualização automática, além dos sistemas anteriores. Os testes não substituem a validação de acesso e registro slash no servidor real.
