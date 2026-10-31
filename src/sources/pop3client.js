/**
 * 极简 POP3 客户端（仅实现本项目用到的只读命令）。
 *
 * 为什么手写而不是引第三方库：POP3 是纯行协议（`+OK` / `-ERR` + 多行体），
 * 需要的命令只有 `USER/PASS/UIDL/TOP/RETR/QUIT`；引入一个库会多一条依赖，
 * 而本插件是**链接安装**（源码即副本），少一条依赖就少一个同步/安装坑。
 *
 * 三条实现纪律：
 *   1. **只在行首解 dot-stuffing**（`..` → `.`），正文里的 `.` 原样保留；
 *   2. 用 latin1 读写 socket：8 位 MIME 正文按字节 1:1 还原，不做 UTF-8 猜测
 *      （`RETR` 回来的是 RFC822 字节，交给 mailparser 解析）；
 *   3. 每条命令都有超时，超时/断连都上抛 —— 绝不在"没有新邮件"和"握手失败"之间
 *      返回同一个空值（IMAP 那边 C2 的同类事故）。
 *
 * 测试注入：`createSocket` 可以换成假 Duplex（见 test/issues.test.mjs 的阶段 31），
 * 协议逻辑与网络 I/O 因此可以离线单测。
 */
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 60_000;

/** 一条 POP3 状态行是不是 +OK（`-ERR` 一律当失败） */
export function isOkLine(line) {
  return /^\+OK(?:\s|$)/i.test(String(line ?? ''));
}

/** 去掉多行体的 dot-stuffing：只有行首的 `..` 还原成 `.` */
export function unstuffDot(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => (String(line).startsWith('..') ? String(line).slice(1) : String(line)));
}

/** 解析 UIDL 多行体：`<msgNum> <uidl>`，乱序/坏行直接丢（不让一条坏行毒死整个来源） */
export function parseUidlLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(String(line));
    if (!m) continue;
    const num = Number(m[1]);
    if (!Number.isFinite(num) || num < 1) continue;
    out.push({ n: num, uidl: m[2] });
  }
  return out.sort((a, b) => a.n - b.n);
}

export class Pop3Client {
  /**
   * @param {{host?: string, port?: number, secure?: boolean, timeoutMs?: number,
   *          createSocket?: () => import('node:stream').Duplex}} options
   */
  constructor({ host = '', port = 995, secure = true, timeoutMs = DEFAULT_TIMEOUT_MS, createSocket } = {}) {
    this.host = host;
    this.port = Number(port) || (secure ? 995 : 110);
    this.secure = secure !== false;
    this.timeoutMs = Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.createSocket = createSocket;
    this.socket = null;
    this.buffer = '';
    this.pending = [];
    this.chain = Promise.resolve();
    this.closed = false;
    this.greeting = null;
    this.waiters = [];
  }

  #makeSocket() {
    if (typeof this.createSocket === 'function') return this.createSocket();
    if (this.secure) {
      return tls.connect({ host: this.host, port: this.port, servername: this.host, timeout: this.timeoutMs });
    }
    return net.connect({ host: this.host, port: this.port, timeout: this.timeoutMs });
  }

  async connect() {
    if (this.socket) return this;
    const socket = this.#makeSocket();
    this.socket = socket;
    socket.setEncoding?.('latin1');
    socket.setTimeout?.(this.timeoutMs);
    socket.on('data', (chunk) => {
      this.buffer += String(chunk);
      this.#pump();
    });
    socket.on('timeout', () => {
      this.#failAll(new Error(`POP3 连接超时（${this.host}:${this.port}，${this.timeoutMs} ms）`));
      // 超时后 socket 可能已经半死：不 destroy 会留下一个不可达的 fd（长时间运行会堆积）
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    });
    socket.on('error', (err) => this.#failAll(err instanceof Error ? err : new Error(String(err))));
    socket.on('close', () => {
      this.closed = true;
      this.#failAll(new Error('POP3 连接已关闭'));
    });
    /*
     * 真实 socket（net/tls）在 `connect` 之前 `connecting === true`，要等事件；
     * 测试注入的假 Duplex 没有 `connecting` 字段，视为已经连上（协议逻辑与 I/O 解耦）。
     */
    const needsConnect = typeof socket.connecting === 'boolean' ? socket.connecting : false;
    if (needsConnect) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`POP3 连接超时（${this.host}:${this.port}）`)), this.timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        const done = (err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        socket.once('connect', () => done());
        socket.once('error', done);
        // tls.connect 的 'secureConnect' 比 'connect' 晚；'connect' 已足够（TLS 握手失败会走 error）
      });
    }
    // 服务器问候语也必须等到。失败要主动关掉 socket：否则每次认证/握手失败都留一条连接
    try {
      this.greeting = await this.#readResponse('连接');
    } catch (err) {
      this.close();
      throw err;
    }
    if (!this.greeting.ok) throw new Error(`POP3 服务端拒绝连接：${this.greeting.status || '无问候语'}`);
    return this;
  }

  #pump() {
    // 每读到一个完整行就唤醒一个等待者；不完整的半行留在 buffer 里等下一次 data
    while (this.waiters.length > 0) {
      const index = this.buffer.indexOf(CRLF);
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      const waiter = this.waiters.shift();
      try {
        waiter.resolve(line);
      } catch {
        // 等待者的回调异常不影响下一条
      }
    }
  }

  /** 读一行（不消费多行体） */
  #readLine() {
    return new Promise((resolve, reject) => {
      if (this.buffer.includes(CRLF)) {
        const index = this.buffer.indexOf(CRLF);
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        resolve(line);
        return;
      }
      const waiter = { resolve: null, reject: null };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error('POP3 等待服务端回复超时'));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      waiter.resolve = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      waiter.reject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.waiters.push(waiter);
    });
  }

  /** 读一条响应：状态行；-ERR 抛出并带上命令名（认证失败与 UIDL 被禁要能区分） */
  async #readResponse(label = '命令') {
    const status = await this.#readLine();
    const ok = isOkLine(status);
    if (!ok) throw new Error(`POP3 ${label} 失败：${status}`);
    return { ok, status, lines: [] };
  }

  async #readMultiline() {
    const lines = [];
    for (;;) {
      const line = await this.#readLine();
      if (line === '.') break;
      lines.push(line);
    }
    return unstuffDot(lines);
  }

  #send(line) {
    if (!this.socket) throw new Error('POP3 未连接');
    return new Promise((resolve, reject) => {
      try {
        this.socket.write(`${line}${CRLF}`, 'latin1', (err) => (err ? reject(err) : resolve()));
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 串行执行一条命令：POP3 是单通道状态机，并发命令会把回复配错 */
  #run(task) {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  command(line, { multiline = false } = {}) {
    return this.#run(async () => {
      await this.#send(line);
      const label = String(line).split(/\s+/, 1)[0].toUpperCase() || '命令';
      const response = await this.#readResponse(label);
      if (multiline) response.lines = await this.#readMultiline();
      return response;
    });
  }

  async login(user, password) {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${password}`);
    return this;
  }

  async stat() {
    const { status } = await this.command('STAT');
    const parts = String(status).split(/\s+/);
    return { count: Number(parts[1]) || 0, size: Number(parts[2]) || 0 };
  }

  async uidl() {
    const { lines } = await this.command('UIDL', { multiline: true });
    return parseUidlLines(lines);
  }

  /** TOP n 0：只取头部（省流量）；服务器不支持 TOP 时调用方退回 RETR */
  async top(n, lines = 0) {
    const response = await this.command(`TOP ${Number(n)} ${Math.max(0, Number(lines) || 0)}`, { multiline: true });
    return response.lines.join(CRLF);
  }

  /** RETR n：返回原始 RFC822 字节（latin1 往返不改变字节；补回报文末尾的行尾） */
  async retr(n) {
    const response = await this.command(`RETR ${Number(n)}`, { multiline: true });
    const body = response.lines.join(CRLF);
    return Buffer.from(response.lines.length > 0 ? `${body}${CRLF}` : body, 'latin1');
  }

  async noop() {
    await this.command('NOOP');
  }

  async quit() {
    try {
      await this.command('QUIT');
    } catch {
      // QUIT 失败不影响清理
    }
    this.close();
  }

  close() {
    this.closed = true;
    this.#failAll(new Error('POP3 连接已关闭'));
    try {
      this.socket?.end?.();
      this.socket?.destroy?.();
    } catch {
      // ignore
    }
    this.socket = null;
  }

  #failAll(err) {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      try {
        waiter.reject?.(err);
      } catch {
        // ignore
      }
    }
  }
}
