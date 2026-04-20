const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');
const EventEmitter = require('events');

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function normalizeService(def) {
  return {
    name: String(def.name || '').trim(),
    type: def.type ? String(def.type) : 'command',
    command: def.command ? String(def.command) : null,
    args: Array.isArray(def.args) ? def.args.map(String) : [],
    cwd: def.cwd ? String(def.cwd) : null,
    env: def.env && typeof def.env === 'object' ? def.env : null,
    startCommand: def.startCommand ? toArray(def.startCommand) : null,
    stopCommand: def.stopCommand ? toArray(def.stopCommand) : null,
    restartCommand: def.restartCommand ? toArray(def.restartCommand) : null,
    statusCommand: def.statusCommand ? toArray(def.statusCommand) : null,
    stopSignal: def.stopSignal ? String(def.stopSignal) : 'SIGTERM',
    killTimeoutMs: Number.isFinite(def.killTimeoutMs) ? def.killTimeoutMs : 5000,
    maxLogLines: Number.isFinite(def.maxLogLines) ? def.maxLogLines : 2000,
  };
}

function splitCommand(commandArray) {
  if (!Array.isArray(commandArray) || commandArray.length === 0) return null;
  const [cmd, ...args] = commandArray;
  return { cmd: String(cmd), args: args.map(String) };
}

class ServiceManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.runtimeDir = options.runtimeDir || path.join(__dirname, 'runtime');
    this.logsDir = path.join(this.runtimeDir, 'logs');
    ensureDir(this.logsDir);

    this.configPath = options.configPath || process.env.SERVICES_CONFIG || path.join(__dirname, 'services.json');
    this.services = new Map();
    this.procs = new Map();
    this.meta = new Map();
    this.logs = new Map();

    this.reload();
  }

  reload() {
    let defs = [];
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = safeJsonParse(raw);
      if (parsed.ok) defs = Array.isArray(parsed.value) ? parsed.value : [];
    } catch (err) {
      defs = [];
    }

    const normalized = defs.map(normalizeService).filter((d) => d.name);
    this.services.clear();
    for (const def of normalized) {
      this.services.set(def.name, def);
      if (!this.meta.has(def.name)) {
        this.meta.set(def.name, {
          lastStartAt: null,
          lastStopAt: null,
          lastExitAt: null,
          lastExitCode: null,
          lastExitSignal: null,
          lastError: null,
        });
      }
      if (!this.logs.has(def.name)) {
        this.logs.set(def.name, []);
      }
    }
    return { services: normalized.map((d) => d.name) };
  }

  list() {
    const out = [];
    for (const [name, def] of this.services.entries()) {
      out.push(this.describe(name, def));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  describe(name, def = this.services.get(name)) {
    const proc = this.procs.get(name);
    const meta = this.meta.get(name) || {};
    const running = Boolean(proc && proc.exitCode === null && !proc.killed);
    return {
      name,
      type: def?.type || 'unknown',
      running,
      pid: running ? proc.pid : null,
      command: def?.command || null,
      args: def?.args || [],
      cwd: def?.cwd || null,
      lastStartAt: meta.lastStartAt || null,
      lastStopAt: meta.lastStopAt || null,
      lastExitAt: meta.lastExitAt || null,
      lastExitCode: meta.lastExitCode ?? null,
      lastExitSignal: meta.lastExitSignal ?? null,
      lastError: meta.lastError ?? null,
    };
  }

  appendLog(name, stream, chunk) {
    const line = `${nowIso()} [${stream}] ${String(chunk).replace(/\r?\n$/, '')}`;
    const def = this.services.get(name);
    const maxLogLines = def?.maxLogLines || 2000;
    const buffer = this.logs.get(name) || [];
    buffer.push(line);
    if (buffer.length > maxLogLines) buffer.splice(0, buffer.length - maxLogLines);
    this.logs.set(name, buffer);

    try {
      const filePath = path.join(this.logsDir, `${name}.log`);
      fs.appendFileSync(filePath, line + os.EOL);
    } catch (err) {
    }

    this.emit('log', { name, line });
  }

  getLogs(name, tail = 200) {
    const buffer = this.logs.get(name) || [];
    const n = Math.max(1, Math.min(5000, Number(tail) || 200));
    return buffer.slice(-n);
  }

  async execCommand(commandArray, options = {}) {
    const spec = splitCommand(commandArray);
    if (!spec) throw new Error('Invalid command');
    const { cmd, args } = spec;
    return await new Promise((resolve) => {
      execFile(cmd, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          signal: error?.signal ?? null,
          error: error ? String(error.message || error) : null,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      });
    });
  }

  async start(name) {
    const def = this.services.get(name);
    if (!def) throw new Error(`Unknown service: ${name}`);

    if (def.type !== 'command') {
      if (!def.startCommand) throw new Error(`Service ${name} has no startCommand`);
      const result = await this.execCommand(def.startCommand, { cwd: def.cwd || process.cwd(), env: { ...process.env, ...(def.env || {}) } });
      const meta = this.meta.get(name) || {};
      meta.lastStartAt = nowIso();
      meta.lastError = result.ok ? null : result.error || result.stderr || 'start failed';
      this.meta.set(name, meta);
      this.appendLog(name, 'manager', `startCommand ok=${result.ok} code=${result.code}`);
      if (result.stdout) this.appendLog(name, 'stdout', result.stdout.trim());
      if (result.stderr) this.appendLog(name, 'stderr', result.stderr.trim());
      return this.describe(name, def);
    }

    const existing = this.procs.get(name);
    const alreadyRunning = Boolean(existing && existing.exitCode === null && !existing.killed);
    if (alreadyRunning) return this.describe(name, def);

    if (!def.command) throw new Error(`Service ${name} has no command`);

    const proc = spawn(def.command, def.args || [], {
      cwd: def.cwd || process.cwd(),
      env: { ...process.env, ...(def.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.procs.set(name, proc);
    const meta = this.meta.get(name) || {};
    meta.lastStartAt = nowIso();
    meta.lastError = null;
    this.meta.set(name, meta);

    this.appendLog(name, 'manager', `spawn pid=${proc.pid} cmd=${def.command} args=${JSON.stringify(def.args || [])}`);

    proc.stdout.on('data', (d) => this.appendLog(name, 'stdout', d));
    proc.stderr.on('data', (d) => this.appendLog(name, 'stderr', d));

    proc.on('exit', (code, signal) => {
      const m = this.meta.get(name) || {};
      m.lastExitAt = nowIso();
      m.lastExitCode = code;
      m.lastExitSignal = signal;
      this.meta.set(name, m);
      this.appendLog(name, 'manager', `exit code=${code} signal=${signal || ''}`.trim());
    });

    proc.on('error', (err) => {
      const m = this.meta.get(name) || {};
      m.lastError = String(err?.message || err);
      this.meta.set(name, m);
      this.appendLog(name, 'manager', `error ${String(err?.message || err)}`);
    });

    return this.describe(name, def);
  }

  async stop(name) {
    const def = this.services.get(name);
    if (!def) throw new Error(`Unknown service: ${name}`);

    if (def.type !== 'command') {
      if (!def.stopCommand) throw new Error(`Service ${name} has no stopCommand`);
      const result = await this.execCommand(def.stopCommand, { cwd: def.cwd || process.cwd(), env: { ...process.env, ...(def.env || {}) } });
      const meta = this.meta.get(name) || {};
      meta.lastStopAt = nowIso();
      meta.lastError = result.ok ? null : result.error || result.stderr || 'stop failed';
      this.meta.set(name, meta);
      this.appendLog(name, 'manager', `stopCommand ok=${result.ok} code=${result.code}`);
      if (result.stdout) this.appendLog(name, 'stdout', result.stdout.trim());
      if (result.stderr) this.appendLog(name, 'stderr', result.stderr.trim());
      return this.describe(name, def);
    }

    const proc = this.procs.get(name);
    const running = Boolean(proc && proc.exitCode === null && !proc.killed);
    if (!running) return this.describe(name, def);

    const meta = this.meta.get(name) || {};
    meta.lastStopAt = nowIso();
    this.meta.set(name, meta);
    this.appendLog(name, 'manager', `stop signal=${def.stopSignal}`);
    try {
      proc.kill(def.stopSignal || 'SIGTERM');
    } catch (err) {
      this.appendLog(name, 'manager', `kill error=${String(err?.message || err)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, def.killTimeoutMs || 5000));

    const stillRunning = Boolean(proc.exitCode === null && !proc.killed);
    if (stillRunning) {
      this.appendLog(name, 'manager', 'force kill SIGKILL');
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        this.appendLog(name, 'manager', `sigkill error=${String(err?.message || err)}`);
      }
    }

    return this.describe(name, def);
  }

  async restart(name) {
    const def = this.services.get(name);
    if (!def) throw new Error(`Unknown service: ${name}`);

    if (def.type !== 'command') {
      if (def.restartCommand) {
        const result = await this.execCommand(def.restartCommand, { cwd: def.cwd || process.cwd(), env: { ...process.env, ...(def.env || {}) } });
        this.appendLog(name, 'manager', `restartCommand ok=${result.ok} code=${result.code}`);
        if (result.stdout) this.appendLog(name, 'stdout', result.stdout.trim());
        if (result.stderr) this.appendLog(name, 'stderr', result.stderr.trim());
        return this.describe(name, def);
      }
      await this.stop(name);
      return await this.start(name);
    }

    await this.stop(name);
    return await this.start(name);
  }
}

module.exports = { ServiceManager };

