# Publicação

- As alterações solicitadas pelo usuário devem ser publicadas na instalação ativa
  da AWS, não apenas implementadas localmente.
- Consulte `MIGRACAO-AWS.md` para acesso, caminho e serviço. Faça backup dos arquivos
  alterados, execute os testes relevantes, publique e verifique o serviço e a saúde.
- Preserve alterações remotas não relacionadas. Não substitua `.env`, bancos,
  uploads, chaves ou outros dados de produção por cópias locais.
- Não inicie uma segunda instância do bot local enquanto a AWS estiver ativa.
- Informe o resultado real da publicação. Se houver um impedimento, comunique-o
  explicitamente; não apresente mudanças locais como publicadas.
