const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function now() {
  return new Date();
}

function formatWithTz(date, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    });
    return fmt.format(date).replace(',', '');
  } catch (err) {
    return date.toISOString();
  }
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
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

class DeployHook {
  constructor(options = {}) {
    this.repoDir = options.repoDir || path.join(__dirname);
    this.runtimeDir = options.runtimeDir || path.join(__dirname, 'runtime');
    this.dataDir = path.join(this.runtimeDir, 'deploy');
    ensureDir(this.dataDir);
    this.statePath = path.join(this.dataDir, 'state.json');
    this.timeZone = options.timeZone || process.env.DEPLOY_TIMEZONE || 'Asia/Bangkok';
    this.state = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf8');
      const parsed = safeJsonParse(raw);
      if (parsed.ok && parsed.value && typeof parsed.value === 'object') return parsed.value;
    } catch (err) {
    }
    return {
      lastPullAt: null,
      lastPullAtFormatted: null,
      lastPullCommit: null,
      lastPullOk: null,
      lastPullOutput: null,
      lastPullError: null,
    };
  }

  save() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  async getHead() {
    const r = await execGit(['rev-parse', '--short', 'HEAD'], this.repoDir);
    if (!r.ok) return null;
    return r.stdout.trim();
  }

  getStatus() {
    return { ...this.state, timeZone: this.timeZone, repoDir: this.repoDir };
  }

  async pull() {
    const at = now();
    this.state.lastPullAt = at.toISOString();
    this.state.lastPullAtFormatted = formatWithTz(at, this.timeZone);
    this.save();

    const pullRes = await execGit(['pull', '--ff-only', 'origin', 'main'], this.repoDir);
    const head = await this.getHead();

    this.state.lastPullCommit = head;
    this.state.lastPullOk = pullRes.ok;
    this.state.lastPullOutput = (pullRes.stdout || '').trim() || null;
    this.state.lastPullError = (pullRes.stderr || pullRes.error || '').trim() || null;
    this.save();

    return this.getStatus();
  }
}

module.exports = { DeployHook };

