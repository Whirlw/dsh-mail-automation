# dsh-mail-automation

Plugin do DeepSeek Harness (DSH): transforma suas caixas de entrada numa linha de triagem — consulta IMAP e Microsoft
Graph, arquiva cada e-mail novo localmente, entrega-o a um **subagente restrito** que o lê e escreve uma conclusão, e
publica um resumo diário no QQ — e executa **tarefas agendadas de agente** (diárias / semanais / mensais / por
intervalo / ao iniciar), cada uma com seu próprio prompt e com o envio ao QQ feito pelo agente.

- Fontes: IMAP (`imapflow`), POP3 (cliente embutido), Gmail API e Microsoft Graph (OAuth; vinculação em Configurações)
- Uma pasta de arquivo por e-mail: mensagem original, HTML, texto, imagem de prévia, `conclusion.md`
- Subagente por e-mail com preset mínimo (sem shell, sem escrita de arquivos) — ver `agent.preset`
- Tarefas agendadas arbitrárias (vários horários por dia, vários dias da semana/mês, intervalo fixo, ao iniciar);
  cada uma com seu prompt. O agente envia o QQ com `qq_notify`; o plugin não publica mais sozinho.
- Página de ajustes dentro do DSH (resumo / arquivados / caixas / tarefas / prompts / parâmetros / guia) que reescreve o YAML no lugar

## What it is: a default control flow, not a fixed product

De fábrica o plugin encadeia dois passos: polling + arquivo local e um turno do subagente por e-mail. As tarefas
agendadas são explícitas: adicione em `schedules:` com `prompt_file`. Uma tarefa de resumo pode ler o arquivo, escrever
o resumo, chamar `qq_notify` e limpar com `archive_clear`. O fluxo **não é fixo**: adicione/remova tarefas, troque os
prompts e `agent.tools` (e instale outros plugins do DSH). A entrega é uma chamada `qq_notify` dentro do prompt do
agente, então pode mudar ou remover.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- DSH `0.1.2-rc.1` … `0.2.x` — os intervalos peer exatos de `@deepseek-ai/dsh-llm|session|tools|storage-domain|brand`
  estão em `package.json`. Um host fora deles **recusa a instalação** (`dsh plugin add` valida peers).
- Para prévias HTML: navegador baseado em Chromium (Edge/Chrome); fora do Windows configure `render.browser`.
- Para QQ: `appId` / `appSecret` do bot oficial e o `openid` do destinatário.

## Install

As duas formas funcionam; escolha conforme você distribui:

**Instalação por link** (o que "instalar da pasta local" produz no Windows: um junction).
O repositório **é** a cópia instalada — basta editar e reiniciar o DSH:

```powershell
# no app DSH: Ajustes → Plugins → instalar da pasta local → escolha este diretório
# depois reiniciar o DSH
```

**Instalação por cópia** (`file:` ou tarball do `npm pack`). O perfil guarda uma cópia: sincronize depois de editar:

```powershell
node sync.mjs      # copia src/ client.js skills/ scripts/ locale/ docs/ para a instalação do perfil
# depois reiniciar o DSH
```

Medido no dsh `0.2.1-rc.3`: com instalação por link o `@deepseek-ai/*` continua resolvendo (o log mostra
`schema=bare-import`). O plugin **não escreve nada** no perfil. Atenção: o perfil **`desktop` só pode ser reinstalado
pela página de plugins do app** — o CLI o recusa
(`profile "desktop" is managed exclusively by the Electron application`).

## Configure

Três camadas, a última vence:

1. `cordis.patch.yml` → o `config` da linha `mail-automation` (validado por Schemastery; pode ser sobrescrito por perfil)
2. o YAML de `configFile` — padrão `$DSH_HOME/mail-automation/mail-automation.yaml`, relido a cada ciclo
3. os padrões de `src/defaults.js`

No dia a dia basta a camada 2: salve e vale no próximo ciclo (prompts, no próximo e-mail). `poll_seconds` é volátil e
`schedules` é reprogramado no próximo batimento: não precisa recarregar o plugin. Tabelas completas: [docs/configuration.md](docs/configuration.md).

Credenciais por referência:

```yaml
sources:
  - id: private
    name: Privado
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD   # resolvido por ctx.credentials
qq:
  enabled: true
  openid: <openid do destinatário>        # appId/appSecret usam QQ_BOT_APP_ID / QQ_BOT_SECRET por padrão
```

## Quick start

1. Instale como acima e reinicie o DSH.
2. Escreva um YAML mínimo (uma fonte + seu `openid`) em `$DSH_HOME/mail-automation/mail-automation.yaml`.
3. Guarde `MAIL_PRIVATE_PASSWORD` (e opcionalmente `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`) na página de credenciais ou em
   `$DSH_HOME/.credentials.yaml` sob `refs:`.
4. Reinicie e confira em `$DSH_HOME/mail-automation/mail-automation.log` as linhas
   `插件加载 … schema=bare-import` e `已注册工具：qq_notify / …`.
5. Abra **Ajustes → 邮件助理**: você deve ver as fontes, os cursores e os 10 cabeçalhos mais recentes em `startup.md`.

## Tools

| Ferramenta | Para quê |
|---|---|
| `qq_notify` | Enviar uma mensagem pelo bot oficial do QQ |
| `mail_automation_archive_read` | Ler **apenas um e-mail** do arquivo local (`text` / `html` / `image` / `raw` / `conclusion` / `meta`) |
| `mail_automation_archive_list` | Listar todo o arquivo (ou ids) e anexar assunto/data/remetente/destinatário/conclusion.md |
| `mail_automation_archive_clear` | Apagar todo o arquivo ou só a lista de ids (destrutivo) |
| `mail_automation_status` | Intervalo, próxima tarefa, cursores por fonte, pendentes |
| `mail_automation_poll` | Rodar um ciclo agora (e liberar um ciclo travado) |
| `mail_automation_config` | As mesmas operações da página: read / save_params / save_prompts / retry_failed / retry_poll |

Parâmetros, retornos e API HTTP: [docs/api.md](docs/api.md).

## Settings page

**Ajustes → 邮件助理** tem sete abas: **Resumo** (estado, próxima tarefa agendada, backend, caminho da configuração,
cursores por fonte, "tentar agora"), **Arquivados** (e-mails salvos localmente, com selos ✓ / falha / processando;
"reprocessar falhas" fica no canto superior direito e cada tarefa agendada tem seu "executar agora"),
**Caixas**, **Tarefas agendadas** (adicionar/editar/remover qualquer
número de tarefas, cada uma com seu horário e prompt), **Prompts** (e-mail / HTML, ambos na pasta `prompt/`) e
**Parâmetros** (intervalo de consulta/batimento/cabeçalhos, modo silencioso, o workspace do agente e o modelo /
esforço / ferramentas do e-mail), **Guia** (variáveis, sintaxe de comentários, skills internas e como carregá-las).
Salvar reescreve apenas os escalares alterados do YAML (comentários preservados) e
revalida a tabela inteira; as tarefas são gravadas como um array completo validado.

## Common pitfalls

- **Não consulta nada** → a configuração não tem `sources`, ou `configFile` aponta para um arquivo inexistente (o log nomeia).
- **Nada é arquivado** → `password_ref` não resolveu (credencial vazia nunca conta como configurada) ou o `STATUS` do IMAP
  não era utilizável (o ciclo é pulado e o cursor não avança).
- **Todo e-mail falha** → veja `conclusion.md` (`（agent 处理失败：…）`); se a sessão pai não foi preparada ou o subagente
  foi recusado por `agent/pre-step`, o log diz. Um preset `mail-automation-agent` quebrado só custa tokens: cai no padrão.
- **Sem prévia** → Edge/Chrome não encontrado; configure `render.browser`. `render.remote_images: false` também bloqueia
  imagens e estilos remotos (evita pixels de rastreamento).
- **A tarefa agendada não rodou** → entrada inválida em `schedules` (a aba Resumo mostra o erro persistente) ou a tarefa
  está desativada; o log `下次定时任务` nomeia a próxima.
- **O resumo rodou mas o QQ não recebeu nada** → veja o prompt da tarefa (deve chamar `qq_notify`) e a sessão do
  agente. O plugin não envia nem altera prompts em runtime.
- **Resumo gerado mas arquivos mantidos** → o turno do agente falhou ou ele reportou `（QQ 发送失败：…）`. O prompt
  deve chamar `archive_clear` após um envio bem-sucedido; tudo é registrado com `[schedule:<id>]`.
- **Página de ajustes 404 / em branco** → falta `webServer` ou a rota é de outra instância; o plugin apenas avisa.
- **Atualizar para 0.8.0 (limpeza incompatível)**: `digest.*`, `schedules[].prompt` inline, `prompt.inline`,
  `kind`/`consume_archive`, a migração do token Graph, a adoção de cursores antigos, as cópias de prompts antigos e a
  ferramenta `mail_automation_digest` foram removidos. Cada tarefa precisa de `prompt_file`; prompts ficam em `prompt/`;
  Graph usa um token por origem: `tokens/graph-<id>.json` (sem sufixo de pasta).

## Tests

```powershell
node test\entry.test.mjs     # 92 verificações: contrato, ordem de registro, descarga, credenciais, parâmetros
node test\issues.test.mjs    # 22 verificações: configuração atual, ferramentas de arquivo, snapshot e cliente
node test\harness.mjs        # ponta a ponta com ctx falso (precisa de configuração real de caixa)
node src\cli.js config       # configuração resolvida com segredos mascarados
```

## Docs

- [docs/architecture.md](docs/architecture.md) — ciclo de vida, módulos, a vida de um e-mail, concorrência, modelo de agente
- [docs/configuration.md](docs/configuration.md) — todos os campos, expansão de caminhos, voláteis, limites conhecidos
- [docs/api.md](docs/api.md) — ferramentas, skills, API HTTP de ajustes, CLI
- [docs/operations.md](docs/operations.md) — formas de instalação, caminhos de dados, verificação, diagnóstico, rollback
- [docs/lessons.md](docs/lessons.md) — semântica de execução que o guia do plugin não cobre
- [docs/development.md](docs/development.md) — disciplina de mudanças, registro de defeitos, resultados de check/doctor

## Boundaries

- Somente leitura na caixa: nunca marca como lida, move ou apaga correio no servidor.
- Monitora apenas as pastas configuradas; nunca envia mala direta.
- O trabalho do agente é serial: um e-mail por vez.
- Falhas da caixa vão para o log, nunca são lançadas ao host.

## License

MIT — ver [LICENSE](LICENSE).
