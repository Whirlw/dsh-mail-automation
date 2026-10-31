/**
 * 给 agent 的工具：
 *   qq_notify            —— 通过 QQ 机器人给我发一条消息（紧急邮件提醒走这个）
 *   mail_automation_archive_read    —— 读**本地存档**里的这封邮件（text / html / image / raw / conclusion / meta）
 *   mail_automation_archive_list    —— 批量列出存档邮件 id，可按需附加标题/时间/发件人/收件人/conclusion
 *   mail_automation_archive_clear   —— 清理全部存档或按 id 列表清理
 *   mail_automation_status  —— 看监控状态（轮询时间、各邮箱游标、今天存了几封）
 *   mail_automation_poll    —— 立刻跑一轮轮询（不等 30 秒）
 *   mail_automation_config  —— 读写设置页同一份操作（状态快照 / 参数 / 两份提示词）
 *                           （技能 user-actions.md：UI 的操作也要对 agent 开放，且共用同一实现）
 */
import { dayString } from './store.js';
import { readArchivedMail } from './archiveread.js';
import { listArchives, clearArchives } from './archiveadmin.js';
import { providerFor, sourceTypeLabel } from './sources/index.js';
import { describeSchedule } from './schedule.js';

const okSchema = (extra = {}) => ({
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' }, error: { type: 'string' }, ...extra },
});

/**
 * 邮件时间 → 本地时区的 `YYYY-MM-DD HH:mm`。
 * 后端存的是 ISO(UTC)，直接切字符串会把 UTC 当本地时间（差一个时区），容易被当成另一封邮件。
 */
function localStamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 16);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function registerTools(ctx, defineTool, deps) {
  const { getConfig, getStore, getNotifier, getRunner, monitor, refresh } = deps;
  // 每个 register() 都返回 disposer：返回给调用方，由它的 effect 负责撤销（§3.3 注册即 effect）
  const disposers = [];
  // 手动工具先把配置刷新一次，否则改完 YAML 要等下一轮心跳才生效
  const cancelled = (exec) => Boolean(exec?.signal?.aborted);
  const cancelReply = () => ({ ok: false, error: '已取消（调用方中止了本轮）' });
  /**
   * T10：入口之后才被取消。这时副作用**可能已经发生**（总览已推送/存档已删、轮询已推进游标），
   * 不能回"已取消"——那等于告诉模型什么都没做，它会重跑一遍。只能如实说"可能已执行完、结果未回报"。
   */
  const cancelReplyLate = () => ({
    ok: false,
    cancelled: true,
    error: '调用方在操作完成前后中止了本轮；副作用可能已经发生（结果未回报），不要重跑',
  });

  /**
   * 注册一个工具并接管它的 disposer。
   *
   * 为什么不是直接 `disposers.push(ctx.tools.register(...))`：中途任何一个 register 抛错，
   * 前面几个 disposer 就再也没人拿得到（外层只收到一个 rejection），插件重载后旧工具仍在。
   * 所以统一走 add()，失败时由下面的 catch 逐个撤干净再抛。
   */
  const add = (definition) => {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  const currentConfig = () => {
    try {
      refresh?.();
    } catch {
      // 忽略：拿不到旧配置也能继续
    }
    return getConfig();
  };

  try {
    add(
      defineTool({
        name: 'qq_notify',
        description:
          'Send a message to the user on QQ through the QQ official bot (proactive single chat). Only use it when the user asked to be notified, e.g. an urgent email. Keep it short.',
        parameters: {
          text: { type: 'string', required: true, description: '消息正文（支持简单 Markdown，3 行以内最好）' },
          markdown: { type: 'boolean', description: '是否用 QQ Markdown 渲染（默认跟随插件配置）' },
        },
        output: {
          schema: okSchema({ sent: { type: 'integer' }, chunks: { type: 'integer' } }),
          render(_args, value) {
            if (!value.ok) return [{ type: 'text', text: `qq_notify 失败：${value.error ?? '未知错误'}` }];
            return [{ type: 'text', text: `已通过 QQ 发送 ${value.sent}/${value.chunks} 段消息。` }];
          },
        },
        async execute({ text, markdown }, exec) {
          if (cancelled(exec)) return cancelReply();
          const config = currentConfig();
          const notifier = getNotifier();
          if (!notifier) return { ok: false, error: 'QQ 推送未启用（检查配置文件 qq.enabled）' };
          try {
            const result = await notifier.send(String(text ?? ''), {
              markdown: markdown === undefined ? config?.qq?.markdown !== false : Boolean(markdown),
              ...(exec?.signal ? { signal: exec.signal } : {}),
            });
            return result.ok
              ? { ok: true, sent: result.sent, chunks: result.chunks }
              : { ok: false, error: result.error, sent: result.sent ?? 0, chunks: result.chunks ?? 0 };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_archive_read',
        description:
          'Read this plugin’s LOCAL mail archive only (one folder per mail: body.txt, body.html, preview.png, raw.eml|raw.json, conclusion.md, meta.json). This is the only way to read a monitored mail; it never touches the mailbox. Pass `id` (the archive id from mail_automation_archive_list) or `file` (an archive folder), or `query` (subject/from keyword). `part` picks text (default), html, image, raw, conclusion or meta; use `part: "conclusion"` to read one mail’s conclusion.md. Use `offset`/`maxChars` to page through long text.',
        parameters: {
          id: {
            type: 'string',
            description: '存档 id（`mail_automation_archive_list` 返回的 id / 目录名）；与 file 二选一。读 conclusion.md 用 part="conclusion"',
          },
          file: { type: 'string', description: '存档目录（绝对路径最稳；只给目录名也能在存档目录里找；给目录里的文件也行）' },
          query: { type: 'string', description: '没有路径时按主题/发件人关键词在当前存档（还没总览的邮件）里搜' },
          part: {
            type: 'string',
            description:
              '读哪一份：text（纯文本正文，默认）/ html（原始 HTML）/ image（渲染好的 preview.png 缩略图，返回路径给你用 read_image 看）/ raw（原始报文）/ conclusion（agent 结论）/ meta（元数据 JSON）',
          },
          offset: { type: 'integer', description: '从第几个字开始读，默认 0' },
          maxChars: { type: 'integer', description: '本次最多返回多少字，默认 6000，上限 20000' },
        },
        output: {
          schema: okSchema({
            dir: { type: 'string' },
            part: { type: 'string' },
            file: { type: 'string' },
            note: { type: 'string' },
            subject: { type: 'string' },
            from: { type: 'string' },
            date: { type: 'string' },
            source: { type: 'string' },
            files: { type: 'array' },
            total: { type: 'integer' },
            offset: { type: 'integer' },
            next: { type: 'integer' },
            truncated: { type: 'boolean' },
            text: { type: 'string' },
            image: { type: 'boolean' },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            images: { type: 'array' },
            slices: { type: 'array' },
            links: { type: 'array' },
            candidates: { type: 'array' },
          }),
          /**
           * 模型面向的内容。刻意写短：这段每读一次都进上下文，
           * 所以只留「这是什么文件 + 下一步动作」，不复述已经知道的元数据。
           */
          render(_args, value) {
            if (!value.ok) {
              const list =
                Array.isArray(value.candidates) && value.candidates.length > 0
                  ? `\n候选：\n${value.candidates
                      .map((item) => `- ${item.subject || '(无主题)'} — ${item.from || ''}\n  ${item.dir ?? item.file}`)
                      .join('\n')}`
                  : '';
              return [{ type: 'text', text: `mail_automation_archive_read 失败：${value.error ?? '未知错误'}${list}` }];
            }
            const head = `邮件：${value.subject || '(无主题)'}｜${value.from || ''}｜${value.date || ''}\n存档：${value.dir}`;
            // 宿主侧已经汇总好链接主机：钓鱼判断直接用这一行，不必再读 HTML 或自己抠 href
            const links = Array.isArray(value.links) ? value.links : [];
            const linkLine =
              links.length > 0 ? `\n链接主机：${links.map((link) => `${link.host}×${link.count}`).join('、')}` : '';
            if (value.part === 'image') {
              const size = value.width && value.height ? `${value.width}×${value.height}` : '尺寸未知';
              const slices = Array.isArray(value.slices) ? value.slices : [];
              if (slices.length === 0) {
                return [
                  {
                    type: 'text',
                    text: `${head}\n\n预览图 ${size}：用 read_image 打开（打不开就别猜版式，改读 part="html"）\n${value.file}${linkLine}`,
                  },
                ];
              }
              // 长邮件：整页图不可读，只给分片
              return [
                {
                  type: 'text',
                  text:
                    `${head}\n\n整页图太高，**不要打开**（${size}）：${value.file}\n` +
                    `分片（先看第 1 片；信息不全再逐片看）：\n` +
                    slices.map((slice, index) => `- 第 ${index + 1} 片：${slice.file}`).join('\n') +
                    `${linkLine}`,
                },
              ];
            }
            const tail = value.truncated
              ? `\n\n（共 ${value.total} 字，读到 ${value.next}；续读用 offset=${value.next}）`
              : '';
            return [{ type: 'text', text: `${head}\n\n${value.text}${tail}${linkLine}` }];
          },
        },
        async execute({ id, file, query, part, offset, maxChars }, exec) {
          if (cancelled(exec)) return cancelReply();
          try {
            const config = currentConfig();
            if (!config) return { ok: false, error: '插件还没成功加载配置' };
            return readArchivedMail({ file: file || id, query, part, offset, maxChars }, { archiveDir: config.storage.archiveDir });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_archive_list',
        description:
          'List every locally archived mail (or only the given ids) in one call. Always returns the archive id; `fields` optionally adds subject / date / from / to / conclusion.md content on the same line (conclusion on the next indented line). `ids` accepts archive folder names or the protocol mail id. For a digest call it with `fields: ["subject","date","from","to","conclusion"]` and no ids; for a specific batch pass `ids`. Use this for batch triage instead of calling archive_read per mail.',
        parameters: {
          ids: {
            type: 'array',
            description: '只返回这些邮件：存档目录名（推荐）或 meta.id。不传 = 全部存档；按输入顺序返回',
          },
          fields: {
            type: 'array',
            description: '同一行附加的字段，可任意组合：subject（标题）/ date（时间）/ from（发件人）/ to（收件人）/ conclusion（conclusion.md 内容，另起缩进行）',
          },
          limit: { type: 'integer', description: '最多返回多少封（默认 1000，上限 2000）' },
          max_conclusion_chars: { type: 'integer', description: '每封 conclusion 最多多少字（默认 4000；0 = 不截断）' },
        },
        output: {
          schema: okSchema({ text: { type: 'string' }, total: { type: 'integer' }, returned: { type: 'integer' }, items: { type: 'array' }, missing: { type: 'array' } }),
          render(_args, value) {
            if (!value.ok) return [{ type: 'text', text: `mail_automation_archive_list 失败：${value.error}` }];
            return [{ type: 'text', text: value.text }];
          },
        },
        async execute({ ids, fields, limit, max_conclusion_chars }, exec) {
          if (cancelled(exec)) return cancelReply();
          try {
            const store = getStore();
            if (!store) return { ok: false, error: '状态存储不可用' };
            await store.ready?.();
            return listArchives({
              store,
              ids,
              fields,
              limit,
              maxConclusionChars: max_conclusion_chars,
            });
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_archive_clear',
        description:
          'Delete archived mail folders. Omit `ids` to delete ALL archives; pass an array of archive ids to delete only those. Destructive: for a digest call it only AFTER qq_notify succeeded, otherwise leave archives for the next run; for a user cleanup request delete only the ids they named. Deletes only folders inside the local archive root and drops their retry records.',
        parameters: {
          ids: {
            type: 'array',
            description: '要删除的存档 id（目录名或 meta.id）。不传 = 清理全部；显式空数组会被拒绝',
          },
        },
        output: {
          schema: okSchema({ text: { type: 'string' }, removed: { type: 'integer' }, ids: { type: 'array' }, missing: { type: 'array' }, remaining: { type: 'array' } }),
          render(_args, value) {
            if (!value.ok) return [{ type: 'text', text: `mail_automation_archive_clear 失败：${value.error}` }];
            return [{ type: 'text', text: value.text }];
          },
        },
        async execute({ ids }, exec) {
          if (cancelled(exec)) return cancelReply();
          const store = getStore();
          if (!store) return { ok: false, error: '状态存储不可用' };
          try {
            await store.ready?.();
            const result = clearArchives({ store, ids, logger: deps.logger });
            if (result.ok && result.removed === 0 && result.missing.length === 0) {
              // 全是空目录/没有存档：不是错误，但明确告诉模型没有可删的
              return { ...result, text: '没有可清理的存档。' };
            }
            return result;
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_status',
        description:
          'Show the mail assistant state: enabled sources (IMAP / POP3 / Gmail / Graph) with their cursors, poll interval, and how many mails are archived for a given day.',
        parameters: {
          day: { type: 'string', description: '日期 YYYY-MM-DD，默认今天（只影响"那天存档了多少封"的统计）' },
        },
        output: {
          schema: okSchema({ text: { type: 'string' } }),
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? value.text : `mail_automation_status 失败：${value.error}` }];
          },
        },
        async execute({ day }, exec) {
          if (cancelled(exec)) return cancelReply();
          try {
            const config = currentConfig();
            const store = getStore();
            if (!config || !store) {
              // 零来源是"还没配置"，不是故障：给用户可执行的下一步
              return {
                ok: false,
                error: '还没有配置邮箱：请在设置页「邮箱」里添加 IMAP/POP3，或绑定 Gmail / Microsoft Graph',
              };
            }
            // 游标存在状态后端里（domain 或 state.json）：读之前先等装载完成
            await store.ready?.();
            // archive/ 里就是「还没总览」的邮件（总览完即删）
            const pending = store.listArchived();
            const target = day || dayString();
            const items = day ? store.listArchived({ day }) : [];
            const lines = [
              `轮询间隔：${config.monitor.pollSeconds}s；定时任务 ${(config.schedules ?? []).filter((t) => t.enabled).length} 条`,
              ...(config.schedules ?? [])
                .filter((t) => t.enabled)
                .map((t) => `- ${t.name}（${t.id}）：${describeSchedule(t.schedule)}`),
              `存档目录：${config.storage.archiveDir}（平铺，可用 archive_clear 清理）`,
              `快照文件：${config.storage.snapshotFile}`,
              `提示词：${config.prompt.file || '(内置)'}${config.prompt?.htmlFile ? '（HTML 邮件另用 html_file）' : ''}`,
              '',
              `来源：`,
              ...config.sources.map((source) => {
                const state = store.sourceState(source.id);
                // 游标的人类可读文案由各协议自己给（IMAP=UID / POP3=UIDL / Gmail=historyId / Graph=seen）
                const cursor = (() => {
                  try {
                    return providerFor(source.type).describeCursor(state);
                  } catch {
                    return '未知协议';
                  }
                })();
                const bound = '';
                return `- ${source.name}（${sourceTypeLabel(source.type)}）：${cursor}${bound}`;
              }),
              '',
              `待总览：${pending.length} 封${day ? `（其中 ${target} 到的 ${items.length} 封）` : ''}`,
              ...pending
                .slice(0, 20)
                .map((item, i) => `${i + 1}. ${localStamp(item.date)} ${item.subject} — ${item.from}`),
              '',
              `最近一次轮询：${monitor.lastTickAt ? new Date(monitor.lastTickAt).toLocaleString() : '尚未执行'}`,
              monitor.lastError ? `最近错误：${monitor.lastError}` : '',
            ].filter(Boolean);
            return { ok: true, text: lines.join('\n') };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_poll',
        description: 'Run one mail polling cycle immediately instead of waiting for the next interval.',
        parameters: {},
        output: {
          schema: okSchema({ text: { type: 'string' } }),
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? value.text : `mail_automation_poll 失败：${value.error}` }];
          },
        },
        async execute(_args, exec) {
          if (cancelled(exec)) return cancelReply();
          try {
            // 走 ui.retryPoll()：除了跑一轮，还会解开"卡住"的那一轮（休眠唤醒/网络断开后
            // running 一直为 true 时，直接 tick() 只会返回"上一轮还没结束"）
            const result = deps.ui?.retryPoll
              ? await deps.ui.retryPoll()
              : { ok: true, text: await monitor.tick({ manual: true }) };
            if (!result.ok) return { ok: false, error: result.error };
            // T10：这一轮可能已经推进游标/处理过邮件；取消只是"没拿到回报"，不是"没发生"
            if (cancelled(exec)) {
              deps.logger?.warn?.('[mail-automation] 本轮拉取在取消之后才完成（游标可能已推进）：取消未生效');
              return cancelReplyLate();
            }
            return { ok: true, text: result.text };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );

    add(
      defineTool({
        name: 'mail_automation_config',
        description:
          'Read or change the mail assistant settings that the desktop settings page also edits. action=read returns the same snapshot (status, pending mails, schedules, prompts, params). action=save_params writes poll_seconds / heartbeat_seconds / initial_headers / agent.silent / agent.workspace into mail-automation.yaml (scheduled tasks are configured on the 定时任务 page or in `schedules`). action=save_prompts writes the prompt files from `prompts` {mail, html}. action=retry_failed queues mails whose agent failed. action=retry_poll runs one polling cycle now, releasing a stuck cycle first. save_params also accepts agent.provider, agent.model, agent.reasoning_effort and agent.tools (the tools list of the per-mail sub-agent: read_image / fs / search / web / skill / todo; an empty list means our own tools only).',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: 'read / save_params / save_prompts / retry_failed / retry_poll',
          },
          params: {
            type: 'object',
            additionalProperties: true,
            description: 'save_params 用：{ poll_seconds: 30, "agent.silent": true, ... }（定时任务在 schedules / 设置页「定时任务」里配）',
          },
          prompts: {
            type: 'object',
            additionalProperties: true,
            description: 'save_prompts 用：{ mail: "…", html: "…" }（只提交要改的键；任务提示词在 schedules 里）',
          },
        },
        output: {
          schema: okSchema({ text: { type: 'string' }, changed: { type: 'array' }, written: { type: 'array' } }),
          render(_args, value) {
            return [{ type: 'text', text: value.ok ? value.text : `mail_automation_config 失败：${value.error}` }];
          },
        },
        async execute({ action, params, prompts }, exec) {
          if (cancelled(exec)) return cancelReply();
          const ui = deps.ui;
          if (!ui) return { ok: false, error: '设置操作不可用（插件未成功装配）' };
          const run = String(action ?? '').trim();
          try {
            if (run === 'read') {
              const snap = ui.snapshot();
              const pending = snap.pending.items
                .slice(0, 20)
                .map((item, i) => `${i + 1}. ${localStamp(item.date)} ${item.subject || '(无主题)'} — ${item.from || ''}`);
              const text = [
                `上次拉取：${snap.status.lastTickAtIso || '尚未执行'}`,
                `下次定时任务：${snap.status.nextScheduleAtIso || '-'}${snap.status.nextScheduleTask ? `（${snap.status.nextScheduleTask}）` : ''}`,
                `待总览：${snap.pending.count} 封`,
                `定时任务：${(snap.schedules ?? []).map((row) => `${row.name}=${row.description}${row.lastStatus ? ` [上次 ${row.lastStatus}${row.lastError ? `: ${row.lastError}` : ''}]` : ''}`).join('；') || '(无)'}`,
                ...pending,
                `参数：${JSON.stringify(snap.params)}`,
                `提示词：${Object.entries(snap.prompts).map(([k, v]) => `${k}=${v.exists ? v.path : '(内置)'}`).join('；')}`,
              ].join('\n');
              return { ok: true, text };
            }
            if (run === 'save_params') {
              const result = ui.saveParams(params ?? {});
              if (!result.ok) return { ok: false, error: result.error };
              return {
                ok: true,
                changed: result.changes,
                text: `已保存：${result.changes.map((c) => `${c.name}=${c.value}`).join('、')}`,
              };
            }
            if (run === 'save_prompts') {
              const result = ui.savePrompts(prompts ?? {});
              if (!result.ok) return { ok: false, error: result.error };
              return { ok: true, written: result.written, text: `已写入：${result.written.join('、')}` };
            }
            if (run === 'retry_failed') {
              // 与设置页的「重试失败邮件」按钮同一个操作（技能 user-actions.md）
              const result = await ui.retryFailed();
              if (!result.ok) return { ok: false, error: result.error };
              if (cancelled(exec)) return cancelReplyLate();
              return { ok: true, changed: [{ name: 'queued', value: result.count }], text: `已排队 ${result.count} 封失败的邮件，下一拍开始处理` };
            }
            if (run === 'retry_poll') {
              // 与设置页的「立即重试拉取」同一个操作（能强制解开卡住的那一轮）
              const result = await ui.retryPoll();
              if (!result.ok) return { ok: false, error: result.error };
              if (cancelled(exec)) return cancelReplyLate();
              return { ok: true, text: result.text || '本轮没有产生输出' };
            }
            return { ok: false, error: `不认识的 action：${run || '(空)'}（read / save_params / save_prompts / retry_failed / retry_poll）` };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
      }),
    );
  } catch (err) {
    // 中途失败：先撤掉已经注册的，再把错误抛给 registerAsync 的 effect 记日志。
    // 不撤的话这些 disposer 永远丢失，插件重载后旧工具仍然挂在注册表里。
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 撤销期的异常不该盖住真正的原因
      }
    }
    throw err;
  }

  return disposers;
}
