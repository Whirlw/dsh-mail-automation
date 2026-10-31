# dsh-mail-automation

[简体中文](README.md) · [English](README-en.md) · Español · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Plugin de DeepSeek Harness (DSH): convierte tus buzones en una línea de triaje — consulta IMAP y Microsoft Graph,
archiva cada correo nuevo en local, se lo entrega a un **subagente restringido** que lo lee y escribe una conclusión,
y ejecuta **tareas programadas de agente** (diarias / semanales / mensuales / por intervalo / al arrancar), cada una
con su propio prompt y con envío a QQ hecho por el agente.

- Fuentes: IMAP (`imapflow`), POP3 (cliente integrado), Gmail API y Microsoft Graph (OAuth; vinculación desde Ajustes)
- Una carpeta de archivo por correo: mensaje original, HTML, texto, imagen de vista previa, `conclusion.md`
- Subagente por correo con un preset mínimo (sin shell, sin escritura de ficheros) — ver `agent.preset`
- Tareas programadas arbitrarias (varias horas al día, varios días de la semana/mes, intervalo fijo, al arrancar);
  cada una con su prompt. El agente envía QQ con `qq_notify`; el plugin no publica por su cuenta.
- Página de ajustes dentro de DSH (resumen / archivados / buzones / tareas / prompts / parámetros / guía) que reescribe el YAML en su sitio

Una primera instalación crea un flujo listo para usar: tres prompts por defecto y una tarea de **resumen diario a las 21:30**.

- Prompt de correo normal: `prompt/prompt.md`
- Prompt de correo HTML: `prompt/prompt-html.md`
- Prompt de resumen: `prompt/digest-prompt.md`

Tras añadir un buzón, el flujo por defecto es:

1. **poll + archivo**: guarda cada correo nuevo del buzón configurado en `archive/`;
2. **un turno por correo**: entrega el archivo al subagente restringido con el prompt por defecto; clasifica
   (urgente / atención / responder / informativo / ruido), escribe `conclusion.md` y llama a `qq_notify` él mismo
   cuando hace falta avisar;
3. **resumen diario a las 21:30**: la tarea por defecto lee el archivo y las conclusiones, escribe el resumen, lo envía
   con `qq_notify` y limpia los archivos cubiertos con `mail_automation_archive_clear`.

Las tareas nuevas deben declarar `prompt_file` en `schedules:`; la tarea por defecto ya lo incluye. La hora, los
prompts, las herramientas y la entrega son editables: no es un flujo de producto fijo.

**El aviso por QQ y el resumen son solo el flujo por defecto**. Nada está fijado:

- **Tareas programadas**: añade, edita o elimina tareas en Ajustes → Tareas o en `schedules:`; cada una tiene su horario y su `prompt_file`;
- **Prompts**: cámbialos en Ajustes → Prompts / Tareas, o con `prompt.file` / `prompt.html_file`;
- **Herramientas**: `agent.tools` puede incluir herramientas de otros plugins de DSH (`fs`, `search`, `web`, `skill`, `todo`, etc.);
- **Entrega**: el plugin no publica por su cuenta; cada envío es una llamada `qq_notify` del prompt. `archive/` y `conclusion.md` son archivos normales que puedes consumir por tu cuenta.

## Requirements

- Node `^22.19.0 || >=24.0.0`
- DSH `0.1.2-rc.1` … `0.2.x`: los rangos peer exactos de `@deepseek-ai/dsh-llm|session|tools|storage-domain|brand`
  están en `package.json`. Un host fuera de ellos **rechaza la instalación** (`dsh plugin add` valida peers).
- Para las vistas previas HTML: un navegador basado en Chromium (Edge/Chrome); fuera de Windows configura `render.browser`.
- Para QQ: `appId` / `appSecret` del bot oficial y el `openid` del destinatario.

## Install

Varias formas funcionan; elige una:

**Instalación npm** (tras publicar):

```powershell
dsh plugin add dsh-mail-automation
```

**Instalación por enlace** (lo que produce "instalar desde carpeta local" en Windows: un junction).
El repositorio **es** la copia instalada, así que basta editar y reiniciar DSH:

```powershell
# en la app DSH: Ajustes → Plugins → instalar desde carpeta local → elige este directorio
# después, reiniciar DSH
```

**Instalación por copia** (`file:` o un tarball de `npm pack`). El perfil guarda una copia: sincroniza tras editar:

```powershell
node sync.mjs      # copia src/ client.js skills/ scripts/ locale/ docs/ a la instalación del perfil
# después, reiniciar DSH
```

Medido en dsh `0.2.1-rc.3`: con instalación por enlace `@deepseek-ai/*` sigue resolviéndose (el log muestra
`schema=bare-import`). El plugin **no escribe nada** en el perfil. Ojo: el perfil **`desktop` solo se puede reinstalar
desde la página de plugins de la app** — el CLI lo rechaza
(`profile "desktop" is managed exclusively by the Electron application`).

## Configure

Precedencia, **de menor a mayor**:

1. **Valores de respaldo en código**: prompts de `src/defaults.js` y fallbacks por campo de `normalizeConfig()`;
2. **`config` de `cordis.patch.yml`**: capa de esquema de DSH, validada por Schemastery; un perfil puede sobrescribir esa fila por `id`;
3. **YAML de `configFile`**: por defecto `$DSH_HOME/mail-automation/mail-automation.yaml`, máxima prioridad y se relee en cada ciclo.

Un cambio en el YAML gana a la capa 2; un campo ausente en ambas cae en los valores de código. La ruta `configFile` viene de la capa 2 (el `config.configFile` del perfil), no del propio YAML. Los arrays `sources` / `schedules` se combinan por id, no se reemplazan enteros.

Por qué `cordis.patch.yml`: no es un tercer fichero de ajustes, sino el punto de montaje de DSH. DSH usa el patch para insertar `mail-automation` en la pila de plugins del perfil y valida/inyecta la configuración con su esquema `Config`; sin el patch el plugin no se carga. El bundle no lleva `config` / `configFile` locales para no conservar rutas absolutas de otra máquina; las rutas de despliegue viven en la fila de override del perfil y los ajustes diarios en el YAML. Así código, despliegue y configuración diaria quedan separados, y editar el YAML no recarga el plugin.

Para el día a día basta la capa 3: guarda y se aplica en el siguiente ciclo (los prompts, en el siguiente correo).
`poll_seconds` es volátil y `schedules` se reprograma en el siguiente latido: no hace falta recargar el plugin.
Tablas completas de campos: [docs/configuration.md](docs/configuration.md).

Las credenciales mejor por referencia:

```yaml
sources:
  - id: private
    name: Privado
    type: imap
    host: imap.qq.com
    user: me@qq.com
    password_ref: MAIL_PRIVATE_PASSWORD   # se resuelve por ctx.credentials
qq:
  enabled: true
  openid: <openid del destinatario>       # appId/appSecret usan QQ_BOT_APP_ID / QQ_BOT_SECRET por defecto
```

## Quick start

1. Instala como arriba y reinicia DSH.
2. Escribe un YAML mínimo (una fuente + tu `openid`) en `$DSH_HOME/mail-automation/mail-automation.yaml`.
3. Guarda `MAIL_PRIVATE_PASSWORD` (y opcionalmente `QQ_BOT_APP_ID` / `QQ_BOT_SECRET`) en la página de credenciales o en
   `$DSH_HOME/.credentials.yaml` bajo `refs:`.
4. Reinicia y comprueba en `$DSH_HOME/mail-automation/mail-automation.log` las líneas
   `插件加载 … schema=bare-import` y `已注册工具：qq_notify / …`.
5. Abre **Ajustes → 邮件助理**: verás las fuentes, sus cursores y las 10 cabeceras más recientes en `startup.md`.

## Tools

| Herramienta | Para qué |
|---|---|
| `qq_notify` | Enviar un mensaje por el bot oficial de QQ |
| `mail_automation_archive_read` | Leer **solo un correo** del archivo local (`text` / `html` / `image` / `raw` / `conclusion` / `meta`) |
| `mail_automation_archive_list` | Listar todo el archivo (o ids) y adjuntar asunto/fecha/emisor/destinatario/conclusion.md |
| `mail_automation_archive_clear` | Borrar todo el archivo o solo la lista de ids (destructivo) |
| `mail_automation_status` | Intervalo, próxima tarea, cursores por fuente, pendientes |
| `mail_automation_poll` | Ejecutar un ciclo ahora (y liberar un ciclo atascado) |
| `mail_automation_config` | Las mismas operaciones que la página: read / save_params / save_prompts / retry_failed / retry_poll |

Parámetros, valores de retorno y API HTTP: [docs/api.md](docs/api.md).

## Settings page

**Ajustes → 邮件助理** tiene siete pestañas: **Resumen** (estado, próxima tarea programada, backend, ruta de configuración,
cursores por fuente, "reintentar ahora"), **Archivados** (correos guardados en local, con insignias ✓ / fallo /
procesando; "reintentar fallidos" está arriba a la derecha y cada tarea programada tiene su "ejecutar ahora"),
**Buzones**, **Tareas programadas** (añadir/editar/borrar
cualquier número de tareas, cada una con su horario y su prompt), **Prompts** (correo / HTML, ambos en la carpeta
`prompt/`), **Parámetros** (intervalo de consulta/latido/cabeceras, modo silencioso, el workspace del agente
y el modelo / esfuerzo / herramientas del correo), **Guía** (variables, sintaxis de comentarios, skills internas y
cómo cargarlas). Al guardar solo se reescriben los escalares cambiados del YAML
(comentarios intactos) y se revalida la tabla completa; las tareas se escriben como un array completo validado.

## Common pitfalls

- **No consulta nada** → la configuración no tiene `sources`, o `configFile` apunta a un fichero inexistente (el log lo nombra).
- **No se archiva nada** → `password_ref` no se resolvió (una credencial vacía nunca cuenta como configurada) o el `STATUS`
  de IMAP no era utilizable (el ciclo se salta y el cursor no avanza).
- **Todos los correos fallan** → mira `conclusion.md` (`（agent 处理失败：…）`); si la sesión padre no pudo prepararse o el
  subagente fue rechazado por `agent/pre-step`, el log lo dice. Un preset `mail-automation-agent` roto solo cuesta tokens:
  se vuelve al preset por defecto.
- **Sin vista previa** → no se encontró Edge/Chrome; configura `render.browser`. `render.remote_images: false` también
  bloquea imágenes y estilos remotos (evita píxeles de seguimiento).
- **La tarea programada no se ejecutó** → entrada inválida en `schedules` (la pestaña Resumen muestra el error de
  configuración persistente) o la tarea está deshabilitada; el log `下次定时任务` nombra la siguiente.
- **El resumen se ejecutó pero QQ no recibió nada** → revisa el prompt de la tarea (debe llamar a `qq_notify`) y la
  sesión del agente. El plugin ya no envía ni parchea prompts.
- **Resumen generado pero archivos conservados** → el turno del agente falló o reportó `（QQ 发送失败：…）`. El prompt
  debe llamar a `archive_clear` tras un envío correcto; todo se registra con `[schedule:<id>]`.
- **Página de ajustes 404 / en blanco** → falta `webServer` o la ruta la ocupa otra instancia; el plugin solo avisa.
- **Actualizar a 0.8.0 (limpieza incompatible)**: se eliminan `digest.*`, `schedules[].prompt` en línea,
  `prompt.inline`, `kind`/`consume_archive`, la migración del token Graph, la adopción de cursores antiguos, las copias
  de prompts antiguos y la herramienta `mail_automation_digest`. Cada tarea debe declarar `prompt_file`; los prompts
  viven en `prompt/`; Graph usa un token por origen: `tokens/graph-<id>.json` (sin sufijo de carpeta).

## Tests

```powershell
node test\entry.test.mjs     # 92 comprobaciones: contrato, orden de registro, descarga, credenciales, parámetros
node test\issues.test.mjs    # 22 comprobaciones: configuración actual, herramientas de archivo, snapshot y cliente
node test\harness.mjs        # extremo a extremo con un ctx falso (necesita configuración real de buzón)
node src\cli.js config       # configuración resuelta con secretos enmascarados
```

## Docs

- [docs/architecture.md](docs/architecture.md) — ciclo de vida, módulos, la vida de un correo, concurrencia, modelo de agente
- [docs/configuration.md](docs/configuration.md) — todos los campos, expansión de rutas, volátiles, límites conocidos
- [docs/api.md](docs/api.md) — herramientas, skills, API HTTP de ajustes, CLI
- [docs/operations.md](docs/operations.md) — formas de instalación, rutas de datos, verificación, diagnóstico, rollback
- [docs/lessons.md](docs/lessons.md) — semántica de ejecución que la guía del plugin no cubre
- [docs/development.md](docs/development.md) — disciplina de cambios, registro de defectos, resultados de check/doctor

## Boundaries

- Solo lectura sobre el buzón: nunca marca como leído, mueve ni borra correo en el servidor.
- Solo vigila las carpetas configuradas; nunca envía correo masivo.
- El trabajo del agente es serial: un correo a la vez.
- Los fallos del buzón se registran en el log, nunca se lanzan al host.

## License

MIT — ver [LICENSE](LICENSE).
