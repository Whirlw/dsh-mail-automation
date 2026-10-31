# dsh-mail-automation

[简体中文](README.md) · English

A DeepSeek Harness (DSH) plugin that automates mailboxes: it polls your mail, archives each new message locally, hands
it to a **restricted sub-agent** that reads it and writes a conclusion, and runs **any number of scheduled agent
tasks** — daily / weekly / monthly / fixed-interval / on-startup, each with its own prompt.

A first install creates a workflow that works out of the box: three default prompts plus one **daily 21:30 digest**
task.

- Plain-mail prompt: `prompt/prompt.md`
- HTML-mail prompt: `prompt/prompt-html.md`
- Digest prompt: `prompt/digest-prompt.md`

Once a mailbox is added, the default workflow is:

1. **poll + archive** every configured mailbox (IMAP / POP3 / OAuth2-IMAP / Gmail API / Microsoft Graph);
2. **one turn per mail** — the archived message is handed to a scoped sub-agent with the default prompt; it classifies
   the mail (urgent / attention / reply / FYI / noise), writes `conclusion.md`, and calls `qq_notify` itself when a
   notification is needed;
3. **a daily 21:30 digest** — the default task reads the archive and conclusions, writes the digest, sends it with
   `qq_notify`, then clears the covered archives with `mail_automation_archive_clear`.

New scheduled tasks must declare a `prompt_file` under `schedules:`; the default task is created with one. The time,
prompts, tools and delivery are all editable — this is not a hard-coded product flow.

The QQ notification and the digest are only the **default workflow**. None of it is hard-wired:

- add, remove or edit **scheduled tasks** (Settings → Mail Assistant → Schedules, or `schedules:` in the YAML
  overlay) — each task has its own schedule (daily at several times, weekly on several weekdays, monthly on several
  days, every N minutes, or once per startup) and its own `prompt_file`;
- change the **prompts** (Settings → Prompts for mail/html, Settings → Schedules for every task) — a task prompt can
  ask for anything (summarise, remind, draft, call other tools, …);
- change **`agent.tools`** and install other DSH plugins/tools; the per-mail sub-agent and the scheduled task get
  exactly the tools you list (for example `fs`, `search`, `web`, `skill`, `todo`), so they can write files, query the
  web, or call your own plugin;
- change or remove the **delivery**: the plugin does not post to QQ by itself. Every send is an agent tool call
  (`qq_notify`) driven by your prompt — drop it from the prompt and nothing is sent; `qq.enabled: false` still
  disables the tool. `archive/` + `conclusion.md` are plain files you can consume yourself.

In short: **“QQ reminder + digest” is just “process a mail” + “one scheduled task whose prompt sends QQ”**. The
reusable pieces are mailbox polling, local archives, the scoped agent turn, and the scheduler; the rest (prompts,
tools, delivery, downstream automation) is yours to replace.

- Five source protocols behind one provider contract: **IMAP** (`imapflow`), **POP3** (built-in client), **OAuth2 (IMAP +
  XOAUTH2)** for Microsoft 365/Outlook (device-code login), **Gmail API** and **Microsoft Graph** (both OAuth, bound from
  the settings page)
- Add / edit / delete mailboxes from **Settings → Mail Assistant → Mailboxes** (written to the YAML overlay, validated
  with the same `normalizeConfig` as startup)
- OAuth binding: Gmail (loopback callback + manual code fallback) and Microsoft Graph (device code); QQ official bot
  binding by **QR code** (writes AppID/openid to YAML, AppID/secret to `ctx.credentials`)
- One archive folder per mail: raw message, HTML, text, preview image, `conclusion.md`
- Per-mail sub-agent with a minimal preset (no shell, no file writes) — see `agent.preset`
- Arbitrary scheduled tasks: daily (multiple times) / weekly (multiple weekdays) / monthly (multiple days, month-end
  clamping) / fixed interval / once per startup — each with its own prompt; QQ is sent by the agent via `qq_notify`
- Settings page can pick the **model / reasoning effort / tool set** of the per-mail sub-agent, and tune the **HTML preview renderer**
- Settings page inside DSH (overview / archived / mailboxes / schedules / prompts / settings / guide) that rewrites the YAML
  overlay in place

## Requirements

- Node `^22.19.0 || >=24.0.0`
- DSH `0.1.2-rc.1` … `0.2.x` — the exact peer ranges of `@deepseek-ai/dsh-llm|session|tools|storage-domain|brand` are in
  `package.json`. A host outside them **rejects the install** (`dsh plugin add` enforces peers).
- For HTML preview images: a Chromium-based browser (Edge/Chrome). On non-Windows set `render.browser` explicitly.
- For QQ: a QQ official-bot `appId` / `appSecret` and the recipient `openid`.

## Install

Several shapes work; pick one:

**npm install** (after publishing):

```powershell
dsh plugin add dsh-mail-automation
```

**Link install** (what the plugin page's "install from local folder" produces on Windows: a junction).
The checkout *is* the installed copy, so editing it and restarting DSH is enough:

```powershell
# in the DSH desktop app: Settings → Plugins → install from local folder → pick this directory
# then restart DSH
```

**Copy install** (`file:` or a packed tarball). The profile holds a copy, so sync after editing:

```powershell
node sync.mjs      # copy src/ client.js skills/ scripts/ locale/ docs/ into the profile install
# then restart DSH
```

Measured on dsh `0.2.1-rc.3`: a link install still resolves `@deepseek-ai/*` (the plugin log shows `schema=bare-import`).
The plugin writes nothing into the profile. Note that the **`desktop` profile can only be reinstalled from the in-app
plugin page** — the CLI refuses it (`profile "desktop" is managed exclusively by the Electron application`).

## Configure

Precedence, **lowest to highest**:

1. **Code fallbacks**: prompt texts in `src/defaults.js` plus the per-field fallbacks in `normalizeConfig()`;
2. **`cordis.patch.yml` `config`**: the DSH schema layer, validated by Schemastery; a profile can override that row by `id`;
3. **the YAML overlay at `configFile`**: default `$DSH_HOME/mail-automation/mail-automation.yaml`, highest priority, re-read on every poll.

So a day-to-day YAML edit beats layer 2; a field absent from both layer 2 and the YAML falls back to code defaults. The
`configFile` path itself comes from layer 2 (the profile's `config.configFile`) — the YAML cannot choose its own path.
Array fields (`sources` / `schedules`) merge by id rather than replacing the whole array.

Why `cordis.patch.yml`: it is not a third settings file but the DSH mount point. DSH uses the patch to insert
`mail-automation` into the profile's plugin stack and validates/injects config against its `Config` schema; without the
patch the plugin is never loaded. The bundle deliberately carries no local `config` / `configFile`, so a distributed
copy cannot retain another machine's absolute path. Deployment paths live in the profile's same-id override row; runtime
settings live in the YAML overlay. That keeps plugin code, deployment config and daily config independent, and a YAML edit
needs no plugin reload.

Only the overlay is meant for day-to-day edits: save the file and it applies on the next tick (prompts apply on the next
mail). `poll_seconds` is volatile; `schedules` is re-armed on the next heartbeat when it changes, so neither needs a
plugin reload. Full field tables: [docs/configuration.md](docs/configuration.md).

Credentials never go in the YAML if you can avoid it. Use references instead:

```yaml
sources:
  - id: private
    name: Private
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD   # resolved through ctx.credentials
  - id: old-pop3
    name: Old mailbox
    type: pop3                     # pop.qq.com / pop.163.com … inferred from provider or domain
    provider: qq
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD
  - id: gmail-main
    name: Gmail
    type: gmail
    user: me@gmail.com
    client_id: <oauth desktop-app client id>
    client_secret_ref: GMAIL_CLIENT_SECRET
    # token file defaults to $DSH_HOME/mail-automation/tokens/gmail-me@gmail.com.json
schedules:
  - id: digest
    name: Mail digest
    schedule:
      type: daily                    # daily / weekly / monthly / interval / startup
      times: ["12:00", "21:00"]      # two runs per day
    prompt_file: prompt/digest-prompt.md
  - id: friday
    name: Friday reminder
    schedule:
      type: weekly
      weekdays: [3, 5]               # ISO: 1=Mon … 7=Sun
      times: ["15:00"]
    prompt_file: prompt/friday-prompt.md
  - id: boot
    name: Startup snapshot
    schedule:
      type: startup                  # once per plugin start, after the baseline
    prompt_file: prompt/boot-prompt.md
qq:
  enabled: true
  openid: <recipient openid>               # appId/appSecret default to QQ_BOT_APP_ID / QQ_BOT_SECRET refs
```

All user prompts live in `$DSH_HOME/mail-automation/prompt/` (`prompt.md`, `prompt-html.md`, and one
`<task-id>-prompt.md` per scheduled task). For a scheduled task, leave `prompt_file` empty in the settings form and
the plugin creates `prompt/<id>-prompt.md` for you; an explicit `prompt_file` is still respected. The prompt body is required either way.

Bind from the UI instead of hand-writing tokens: **Settings → Mail Assistant → Mailboxes** has *Add mailbox*, a
*Bind* button per Gmail/Graph row, and *Scan to bind QQ bot*. The binding writes the token file (mode 0600, atomic)
and, for QQ, `qq.app_id` / `qq.openid`; `QQ_BOT_APP_ID` / `QQ_BOT_SECRET` also go to `ctx.credentials` so other QQ plugins can reuse them.

## Quick start

1. Install as above and restart DSH.
2. Write a minimal overlay (one source + your `openid`) to `$DSH_HOME/mail-automation/mail-automation.yaml`.
3. Store `MAIL_PRIVATE_PASSWORD` (and optionally `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`) in the credentials page or
   `$DSH_HOME/.credentials.yaml` under `refs:`.
4. Restart DSH and check `$DSH_HOME/mail-automation/mail-automation.log` for
   `插件加载 … schema=bare-import` and `已注册工具：qq_notify / …`.
5. Open **Settings → 邮件助理**: you should see the sources, their cursors and the latest 10 headers in `startup.md`.

## Tools

| Tool | Purpose |
|---|---|
| `qq_notify` | Send a QQ message through the official bot |
| `mail_automation_archive_read` | Read **one** archived mail only (`text` / `html` / `image` / `raw` / `conclusion` / `meta`) |
| `mail_automation_archive_list` | List all archived mails (or given ids); optionally attach subject / date / from / to / conclusion.md |
| `mail_automation_archive_clear` | Delete all archives, or only the given id list (destructive) |
| `mail_automation_status` | Poll interval, scheduled tasks, per-source cursors, archived count |
| `mail_automation_poll` | Run one polling cycle now (also clears a stuck cycle) |
| `mail_automation_config` | Same operations as the settings page: read / save params / save prompts / retry failed / retry poll |

The two archive skills (`mail-automation-archive-batch` / `mail-automation-archive-clear`) are registered for the
agent and the two tools are part of the default `agent.tools`.

## Settings page

**Settings → 邮件助理** has seven tabs: **Overview** (state, last/next scheduled task, backend, config path, per-source
cursors, "retry now"), **Archived** (mails saved locally, with ✓ / failed / processing badges; each mail has a
two-step "delete" button, "retry failed" sits top-right, and each scheduled task has its own "run now"), **Mailboxes** (QQ QR binding, mailbox list with
bind/test/delete, add/edit
form), **Schedules** (add/edit/delete any number of tasks, each with its own schedule and prompt, run one now),
**Prompts** (the mail / HTML prompt files under `prompt/`), **Settings** (poll/heartbeat/
headers, silent mode and the agent workspace, plus the mail model / reasoning effort / tool set), **Guide** (available
variables, comment syntax, internal skills and how to make the model load them). Saving rewrites only
the changed scalars in the YAML (comments preserved) — except the task list, which is written as a whole array — and
revalidates the whole table before writing.

## Common pitfalls

- **No polling at all** → the config has no `sources`, or `configFile` points at a missing file (the log names the path).
- **Nothing archived** → `password_ref` did not resolve (empty credentials are never treated as configured), or the IMAP
  `STATUS` reply was unusable (the plugin skips the tick and keeps the cursor).
- **POP3 misses mail** → POP3 has no `UIDVALIDITY`/`UIDNEXT`; the cursor is a set of `UIDL`s. If another client downloads
  and deletes mail before this plugin polls it, that mail is permanently missed (protocol limit). Servers without `UIDL`
  are rejected with an explicit error — use IMAP there.
- **Gmail source fails** → the token file is missing/expired: bind again from **Mailboxes**. A stale `historyId` (404) makes
  the plugin rebuild the baseline (it will not replay history). `seenIds` deduplicates.
- **Graph source fails** → the token file is missing or lacks `Mail.Read`; re-bind. A device-code app registration must
  allow public clients.
- **QR binding does not start** → `q.qq.com` refuses the request (endpoint/anti-bot change). Fall back to the manual
  AppID / openid / appSecret fields in the same card.
- **Every mail fails** → check `conclusion.md` for `（agent 处理失败：…）`; if the parent session could not be primed or the
  sub-agent was blocked by `agent/pre-step`, the log says so. A broken `mail-automation-agent` preset only costs tokens —
  it falls back to the deployment default.
- **No preview image** → Edge/Chrome not found; set `render.browser`. `render.remote_images: false` also strips remote
  images/styles (avoids tracking pixels).
- **A scheduled task did not run** → invalid `schedules` entry (the Overview tab keeps showing the config error), or
  the task is disabled. The log line `下次定时任务：…` names the next one; `mail_automation_status` lists every task.
- **The digest ran but QQ got nothing** → check the task prompt (it must call `qq_notify`) and the agent's child
  session. The plugin no longer patches prompts at runtime.
- **Digest sent but archives kept** → the agent turn failed or the agent reported `（QQ 发送失败：…）`. The task prompt
  must call `archive_clear` after a successful send; all cases are logged with `[schedule:<id>]`.
- **Startup task runs on every restart but not on a hot reload** → by design: the startup slot is claimed once per
  process; a plugin reload inside the same process is not a new start. A startup task added/edited while running is
  marked "Next startup" and runs only on the next DSH start.
- **Settings page 404 / blank** → `webServer` missing or the route is owned by another instance; the plugin only warns,
  mail handling is unaffected.
- **Upgrading to 0.8.0**: this is a breaking cleanup. `digest.*`, `schedules[].prompt` (inline), `prompt.inline`,
  `kind` / `consume_archive`, legacy Graph token migration, legacy source-id cursor adoption, old prompt-file copies
  and the `mail_automation_digest` tool are all gone. Configure every task explicitly in `schedules` with a
  `prompt_file`; prompt files live under `prompt/`; Graph always uses a per-source token file
  (`tokens/graph-<id>.json`, no folder suffix). An auto-derived Graph source id is `graph-<clientId>`
  (`graph-mailbox` when no client id); give the source an explicit `id` if you need a stable key.
- **POP3 `UIDL` unsupported** → the source fails with an explicit error; use IMAP for that mailbox (POP3 cannot do
  reliable incremental sync without UIDL).

## Tests

```powershell
node test\entry.test.mjs     # 92 checks: contract, registration order, teardown, credentials, settings params, schedules
node test\issues.test.mjs    # 22 checks: current config, archive tools, snapshot and client invariants
node test\harness.mjs        # end-to-end with a fake ctx (needs a real mailbox config)
node src\cli.js config       # resolved config with secrets masked
```

## Docs

- [docs/architecture.md](docs/architecture.md) — lifecycle, modules, a mail's life, concurrency, agent model, persistence
- [docs/configuration.md](docs/configuration.md) — every field, path expansion, volatile fields, known limits
- [docs/api.md](docs/api.md) — tools, skills, settings HTTP API, CLI
- [docs/operations.md](docs/operations.md) — install shapes, file locations, verification, troubleshooting, rollback
- [docs/lessons.md](docs/lessons.md) — hard-won runtime semantics the plugin guide does not cover
- [docs/development.md](docs/development.md) — change discipline, defect ledger, check/doctor results
- [docs/multi-source.md](docs/multi-source.md) — adding POP3 / Gmail API / Graph delta: provider contract, pitfalls, order of work

## Boundaries

- Read-only towards the mailbox: never marks read, moves, or deletes mail on the server (POP3 `RETR` is a download; the
  plugin never sends `DELE`).
- Watches the configured folders only; never sends bulk mail.
- Agent work is serialised: one mail or one scheduled task at a time.
- Mailbox failures are logged, never thrown into the host.

## License

MIT — see [LICENSE](LICENSE).
