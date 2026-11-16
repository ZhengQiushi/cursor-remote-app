// Claude Code CLI bridge: drives `claude -p` via stream-json and maps state
// to the same chat snapshot shape the phone UI already understands.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './auth.mjs';

const MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

const MODE_LABEL = Object.fromEntries(MODE_OPTIONS.map(m => [m.value, m.label]));

export function whichClaude(bin) {
  if (bin && bin !== 'claude' && fs.existsSync(bin)) return bin;
  const home = os.homedir();
  const candidates = [
    bin || 'claude',
    path.join(home, '.nvm/versions/node', process.version.slice(1), 'bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try {
      if (c === 'claude') {
        // resolved by PATH when spawned
        return 'claude';
      }
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return 'claude';
}

let _modelsCache = null;
let _apiModelsCache = null;

async function fetchApiModels(base, key) {
  if (!base || !key) return [];
  if (_apiModelsCache && Date.now() - _apiModelsCache.at < 300_000) return _apiModelsCache.list;
  try {
    const url = base.replace(/\/+$/, '') + '/v1/models';
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return _apiModelsCache?.list || [];
    const body = await res.json();
    const models = (body.data || []).map(m => {
      const id = m.id;
      let group = 'Other';
      if (/^claude-/i.test(id)) group = 'Claude';
      else if (/^gpt-/i.test(id)) group = 'GPT';
      else if (/^gemini-/i.test(id)) group = 'Gemini';
      else if (/^grok-/i.test(id)) group = 'Grok';
      else if (/^deepseek/i.test(id)) group = 'DeepSeek';
      else if (/^kimi-/i.test(id)) group = 'Kimi';
      else if (/^qwen/i.test(id)) group = 'Qwen';
      else if (/^glm-/i.test(id)) group = 'GLM';
      else if (/^minimax|^MiniMax/i.test(id)) group = 'MiniMax';
      return { value: id, displayName: id, resolvedModel: id, group };
    });
    _apiModelsCache = { at: Date.now(), list: models };
    return models;
  } catch {
    return _apiModelsCache?.list || [];
  }
}

function fetchModelList(bin) {
  if (_modelsCache && Date.now() - _modelsCache.at < 120_000) return Promise.resolve(_modelsCache.list);
  return new Promise(resolve => {
    const child = spawn(whichClaude(bin), [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-remote-lite' } });
    let buf = '', done = false;
    const finish = (list) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(list); };
    const timer = setTimeout(() => finish([]), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'control_response') {
            const r = msg.response || {};
            if (r.request_id === 'lm') {
              const models = r.response?.models || [];
              _modelsCache = { at: Date.now(), list: models };
              finish(models);
            }
          }
        } catch {}
      }
    });
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'lm', request: { subtype: 'list_models' } }) + '\n');
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Lightweight markdown → HTML for assistant bubbles (tags match Cursor sanitizer whitelist).
function mdToHtml(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';
  const parts = [];
  const re = /```([\w-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    if (m.index > last) parts.push({ t: 'text', v: raw.slice(last, m.index) });
    parts.push({ t: 'code', v: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push({ t: 'text', v: raw.slice(last) });

  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, c) => `<em>${c}</em>`)
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, label, url) => {
      const safe = /^https?:\/\//i.test(url) ? esc(url) : '#';
      return `<a href="${safe}">${label}</a>`;
    });

  let html = '';
  for (const p of parts) {
    if (p.t === 'code') {
      html += `<pre><code>${esc(p.v)}</code></pre>`;
      continue;
    }
    for (const para of p.v.split(/\n{2,}/)) {
      const lines = para.split('\n').map(l => inline(l)).join('<br>');
      if (lines.trim()) html += `<div>${lines}</div>`;
    }
  }
  return html;
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return name;
  if (name === 'Bash') return `Bash: ${(input.command || '').slice(0, 120)}`;
  if (name === 'Read') return `Read: ${input.file_path || input.path || ''}`;
  if (name === 'Edit' || name === 'Write') return `${name}: ${input.file_path || input.path || ''}`;
  if (name === 'Glob') return `Glob: ${input.pattern || ''}`;
  if (name === 'Grep') return `Grep: ${input.pattern || ''}`;
  if (name === 'AskUserQuestion') return 'AskUserQuestion';
  const keys = Object.keys(input).slice(0, 2);
  const hint = keys.map(k => `${k}=${String(input[k]).slice(0, 40)}`).join(' ');
  return hint ? `${name}: ${hint}` : name;
}

function toolFile(name, input) {
  if (!input) return null;
  const p = input.file_path || input.path || null;
  if (p && (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'NotebookEdit')) return p;
  return null;
}

function projectDirKey(cwd) {
  // Claude stores transcripts under ~/.claude/projects/<cwd with every / → ->, so the leading slash
  // becomes the folder's leading dash (-Users-lion-...). Dropping it finds no folder at all.
  return cwd.replace(/[\\/]/g, '-');
}

// The conversation's topic: the first thing the person typed, read from its transcript. Claude Code's
// derived name (ai-tutor-web-96) is only a counter, and command lines (/model) are not topics.
// A session's topic is pinned the first time it is read, so it never changes afterwards, even if the
// transcript is later rewritten or a newer message comes first. Kept per session id.
const TOPIC_FILE = path.join(DATA_DIR, 'topics.json');
function readTopics() {
  try { return JSON.parse(fs.readFileSync(TOPIC_FILE, 'utf8')) || {}; } catch { return {}; }
}
export function pinnedTopic(sessionId, file) {
  if (!sessionId) return topicOf(file);
  const pins = readTopics();
  if (pins[sessionId]) return pins[sessionId];
  const topic = topicOf(file);
  if (!topic) return '';
  pins[sessionId] = topic;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOPIC_FILE, JSON.stringify(pins, null, 2), { mode: 0o600 });
  return topic;
}

export function topicOf(file) {
  let head;
  try { head = fs.readFileSync(file, 'utf8').split('\n').slice(0, 400); } catch { return ''; }
  for (const line of head) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== 'user' || row.isMeta) continue;
    const content = row.message?.content;
    const text = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content.find(c => c?.type === 'text')?.text : '');
    const clean = String(text || '').trim();
    if (!clean || clean.startsWith('<') || clean.startsWith('[Request interrupted')) continue; // wrappers, not the person's ask
    // A topic can be a pasted key or token; it is shown on the phone, so those never go in.
    return clean.replace(/\s+/g, ' ').replace(/\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]').slice(0, 60);
  }
  return '';
}

function listSessionFiles(cwd) {
  const dir = path.join(os.homedir(), '.claude/projects', projectDirKey(cwd));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.jsonl'))
    .map(n => {
      const full = path.join(dir, n);
      let st;
      try { st = fs.statSync(full); } catch { return null; }
      const id = n.replace(/\.jsonl$/, '');
      const title = pinnedTopic(id, full) || id.slice(0, 8);
      return { id, title, mtime: st.mtimeMs, file: full };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

export class ClaudeBridge {
  constructor(opts = {}) {
    this.bin = whichClaude(opts.bin || process.env.CLAUDE_BIN || 'claude');
    this.cwd = path.resolve(opts.cwd || process.env.CLAUDE_CWD || process.cwd());
    this.onUpdate = typeof opts.onUpdate === 'function' ? opts.onUpdate : () => {};
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.child = null;
    this.buf = '';
    this.reqSeq = 0;
    this.pending = new Map(); // request_id → {resolve,reject,timer}
    this.sessionId = null;
    this.model = null;
    this.modelLabel = null;
    this.permissionMode = 'default';
    this.busy = false;
    this.items = [];
    this.itemSeq = 0;
    this.liveAssistant = null; // streaming assistant bubble
    this.pendingPerms = []; // {request_id, tool_name, input, tool_use_id, itemId}
    this.pendingQuestions = null;
    this.queued = [];
    this.changed = 0;
    this.diffCache = null;
    this.modelsCache = null;
    this.startedAt = 0;
    this.alive = false;
    this.resumeId = opts.resume || null;
  }

  nextId(prefix = 'c') {
    this.itemSeq += 1;
    return `${prefix}${this.itemSeq}`;
  }

  write(obj) {
    if (!this.child?.stdin?.writable) throw new Error('Claude CLI 未运行');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  control(subtype, extra = {}) {
    const request_id = `req-${++this.reqSeq}-${crypto.randomBytes(3).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error(`Claude 控制请求超时：${subtype}`));
      }, 20000);
      this.pending.set(request_id, { resolve, reject, timer });
      try {
        this.write({ type: 'control_request', request_id, request: { subtype, ...extra } });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(e);
      }
    });
  }

  async start() {
    if (this.child) return this;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
      '--include-partial-messages',
    ];
    if (this.resumeId) args.push('--resume', this.resumeId);
    this.child = spawn(this.bin, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-remote-lite' },
    });
    this.alive = true;
    this.startedAt = Date.now();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      const s = String(chunk).trim();
      if (s) console.log(`[claude:err] ${s.slice(0, 300)}`);
    });
    this.child.on('exit', (code, signal) => {
      this.alive = false;
      this.busy = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('Claude CLI 已退出'));
      }
      this.pending.clear();
      this.child = null;
      this.pushChat();
      this.onEvent({ type: 'exit', code, signal });
      console.log(`[claude] 进程退出 code=${code} signal=${signal || ''}`);
    });
    this.child.on('error', e => {
      this.alive = false;
      this.onEvent({ type: 'error', error: e.message });
      console.log(`[claude] 启动失败：${e.message}`);
    });

    // Warm control channel; init arrives after first user message.
    try {
      const ver = await this.control('get_binary_version');
      console.log(`[claude] 已连接 ${this.bin} ${ver?.version || ''} cwd=${this.cwd}`);
    } catch (e) {
      console.log(`[claude] 控制通道探测失败：${e.message}`);
    }
    this.pushChat();
    return this;
  }

  async stopProcess() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch {}
    this.child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 400));
    if (this.child) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
    this.child = null;
    this.alive = false;
  }

  async restart({ resume = null } = {}) {
    await this.stopProcess();
    this.items = [];
    this.itemSeq = 0;
    this.liveAssistant = null;
    this.pendingPerms = [];
    this.pendingQuestions = null;
    this.queued = [];
    this.busy = false;
    this.sessionId = null;
    this.resumeId = resume;
    await this.start();
  }

  onStdout(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        console.log(`[claude] 非 JSON 行：${line.slice(0, 120)}`);
        continue;
      }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'control_response':
        return this.handleControlResponse(msg);
      case 'control_request':
        return this.handleControlRequest(msg);
      case 'system':
        return this.handleSystem(msg);
      case 'assistant':
        return this.handleAssistant(msg);
      case 'user':
        return this.handleUserEcho(msg);
      case 'stream_event':
        return this.handleStream(msg);
      case 'result':
        return this.handleResult(msg);
      default:
        return;
    }
  }

  handleControlResponse(msg) {
    const r = msg.response || {};
    const id = r.request_id;
    const pending = id && this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (r.subtype === 'error') pending.reject(new Error(r.error || 'control error'));
    else pending.resolve(r.response ?? r);
  }

  handleControlRequest(msg) {
    const req = msg.request || {};
    if (req.subtype === 'can_use_tool') {
      const itemId = this.nextId('p');
      const entry = {
        request_id: msg.request_id,
        tool_name: req.tool_name,
        input: req.input || {},
        tool_use_id: req.tool_use_id,
        itemId,
        permission_suggestions: req.permission_suggestions || [],
      };
      this.pendingPerms.push(entry);
      this.items.push({
        i: itemId,
        k: 'tool',
        t: `需要批准：${toolSummary(req.tool_name, req.input)}`,
        f: toolFile(req.tool_name, req.input),
        b: ['允许', '拒绝'],
        _perm: msg.request_id,
      });
      this.busy = true;
      this.pushChat();
      this.onEvent({ type: 'permission', entry });
      return;
    }
    if (req.subtype === 'request_user_dialog' || req.subtype === 'elicitation') {
      // Surface as questions card when possible.
      const questions = normalizeDialog(req);
      if (questions) {
        this.pendingQuestions = { request_id: msg.request_id, questions };
        this.pushChat();
      } else {
        // Auto-ack unknown dialogs as cancel to avoid hanging the turn.
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: msg.request_id,
            response: { behavior: 'deny', message: '手机端暂不支持此对话框' },
          },
        });
      }
      return;
    }
    // Unhandled host-bound control: deny safely.
    this.write({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: msg.request_id,
        error: `unsupported control request: ${req.subtype}`,
      },
    });
  }

  handleSystem(msg) {
    if (msg.subtype === 'init') {
      this.sessionId = msg.session_id || this.sessionId;
      this.model = msg.model || this.model;
      this.modelLabel = shortModel(this.model);
      if (msg.cwd) this.cwd = msg.cwd;
      this.pushChat();
    }
  }

  handleUserEcho(msg) {
    // Tool results and replayed user messages — ignore text we already added locally.
  }

  handleAssistant(msg) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    // Finalize any streaming bubble first.
    if (this.liveAssistant) {
      this.liveAssistant = null;
    }
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) {
        // Prefer updating the last assistant item if it was the stream target.
        const last = this.items[this.items.length - 1];
        if (last?.k === 'assistant' && last._stream) {
          last.h = mdToHtml(block.text);
          last._stream = false;
        } else {
          this.items.push({ i: this.nextId('a'), k: 'assistant', h: mdToHtml(block.text) });
        }
      } else if (block.type === 'tool_use') {
        this.items.push({
          i: block.id || this.nextId('t'),
          k: 'tool',
          t: toolSummary(block.name, block.input),
          f: toolFile(block.name, block.input),
        });
        if (block.name === 'AskUserQuestion') {
          const q = normalizeAskUserQuestion(block.input);
          if (q) this.pendingQuestions = { tool_use_id: block.id, questions: q, via: 'tool' };
        }
      }
    }
    this.pushChat();
  }

  handleStream(msg) {
    const ev = msg.event || {};
    if (ev.type === 'message_start') {
      this.busy = true;
      const id = this.nextId('a');
      this.liveAssistant = { i: id, k: 'assistant', h: '', _stream: true, _text: '' };
      this.items.push(this.liveAssistant);
      this.pushChat();
      return;
    }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      if (!this.liveAssistant) {
        const id = this.nextId('a');
        this.liveAssistant = { i: id, k: 'assistant', h: '', _stream: true, _text: '' };
        this.items.push(this.liveAssistant);
      }
      this.liveAssistant._text += ev.delta.text || '';
      this.liveAssistant.h = mdToHtml(this.liveAssistant._text);
      this.pushChat(true);
      return;
    }
    if (ev.type === 'message_stop' || ev.type === 'message_delta') {
      if (this.liveAssistant) this.liveAssistant._stream = false;
    }
  }

  handleResult(msg) {
    this.busy = false;
    this.liveAssistant = null;
    if (msg.session_id) this.sessionId = msg.session_id;
    if (msg.is_error && msg.result) {
      this.items.push({ i: this.nextId('e'), k: 'other', t: `错误：${String(msg.result).slice(0, 300)}` });
    }
    // Refresh workspace diff count in background.
    this.refreshDiff().catch(() => {});
    this.pushChat();
    this.onEvent({ type: 'result', subtype: msg.subtype, result: msg.result });
  }

  pushChat(throttle) {
    if (throttle) {
      if (this._throttle) return;
      this._throttle = setTimeout(() => {
        this._throttle = null;
        this.onUpdate(this.snapshot());
      }, 120);
      return;
    }
    if (this._throttle) {
      clearTimeout(this._throttle);
      this._throttle = null;
    }
    this.onUpdate(this.snapshot());
  }

  snapshot() {
    const global = [];
    if (this.pendingPerms.length) global.push('允许', '拒绝');
    const items = this.items.map(({ _stream, _text, _perm, ...rest }) => rest);
    return {
      rect: null,
      items,
      global,
      busy: this.busy || this.pendingPerms.length > 0,
      queued: this.queued.map(q => ({ id: q.id, text: q.text })),
      subagents: [],
      changed: this.changed,
      questions: this.pendingQuestions?.questions || null,
      readonly: false,
      mode: MODE_LABEL[this.permissionMode] || this.permissionMode,
      model: this.modelLabel || this.model || 'Claude',
    };
  }

  windowInfo() {
    const name = path.basename(this.cwd) || this.cwd;
    return {
      id: 'claude',
      title: `Claude Code — ${name}`,
      kind: 'claude',
      sshHost: '',
    };
  }

  async sendMessage(text, { images = [], submit = true } = {}) {
    if (!submit) {
      // Draft-only not supported by CLI stream mode; ignore.
      return false;
    }
    const content = [];
    for (const img of images) {
      if (!img?.data || !img?.type) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.type, data: img.data },
      });
    }
    const body = String(text || '').trim();
    if (body) content.push({ type: 'text', text: body });
    if (!content.length) throw new Error('内容不能为空');

    if (this.busy && !this.pendingPerms.length) {
      // Queue locally; flush after result.
      const id = this.nextId('q');
      this.queued.push({ id, text: body, images });
      this.pushChat();
      return true;
    }

    this.items.push({
      i: this.nextId('h'),
      k: 'human',
      t: body || (images.length ? '（图片）' : ''),
      imgs: images.map((img, n) => img.path || `claude-img-${Date.now()}-${n}`).filter(Boolean),
    });
    this.busy = true;
    this.pushChat();
    this.write({ type: 'user', message: { role: 'user', content } });
    return false;
  }

  async flushQueue() {
    if (this.busy || !this.queued.length) return;
    const next = this.queued.shift();
    this.pushChat();
    await this.sendMessage(next.text, { images: next.images || [], submit: true });
  }

  async interrupt() {
    await this.control('interrupt');
    this.busy = false;
    this.liveAssistant = null;
    this.pushChat();
  }

  async answerPermission(allow) {
    const entry = this.pendingPerms.shift();
    if (!entry) throw new Error('当前没有待批准的操作');
    // Remove the permission tool card buttons.
    const card = this.items.find(it => it.i === entry.itemId);
    if (card) {
      delete card.b;
      card.t = allow
        ? `已允许：${toolSummary(entry.tool_name, entry.input)}`
        : `已拒绝：${toolSummary(entry.tool_name, entry.input)}`;
    }
    const response = allow
      ? { behavior: 'allow', updatedInput: entry.input || {} }
      : { behavior: 'deny', message: '用户在手机上拒绝了此操作' };
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: entry.request_id, response },
    });
    this.pushChat();
  }

  async clickButton(item, n) {
    const labels = item === 'g'
      ? (this.pendingPerms.length ? ['允许', '拒绝'] : [])
      : (this.items.find(it => it.i === String(item))?.b || []);
    const label = labels[Number(n) || 0];
    if (!label) throw new Error('按钮已经不在了，可能状态已变化');
    if (/^(允许|allow|run|accept|approve|yes)/i.test(label)) return this.answerPermission(true);
    if (/^(拒绝|deny|reject|skip|no)/i.test(label)) return this.answerPermission(false);
    throw new Error(`不支持的按钮：${label}`);
  }

  async setPermissionMode(mode) {
    const hit = MODE_OPTIONS.find(m => m.value === mode || m.label === mode);
    const value = hit?.value || mode;
    await this.control('set_permission_mode', { mode: value });
    this.permissionMode = value;
    this.pushChat();
  }

  async setModel(model) {
    const res = await this.control('set_model', { model });
    this.model = res?.model || model;
    this.modelLabel = shortModel(this.model);
    this.pushChat();
  }

  async listModels() {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 60_000) return this.modelsCache.list;
    const base = process.env.CR_MODELS_API_BASE;
    const key = process.env.CR_MODELS_API_KEY;
    const apiModels = await fetchApiModels(base, key);
    let raw;
    if (apiModels.length) {
      raw = apiModels;
    } else {
      const res = await this.control('list_models');
      raw = res?.models || [];
      _modelsCache = { at: Date.now(), list: raw };
    }
    const list = raw.map(m => ({
      label: m.displayName || m.value,
      value: m.value,
      checked: (this.model && (m.resolvedModel === this.model || m.value === this.model))
        || (!this.model && m.value === 'default'),
      params: !!(m.supportsEffort || m.supportedEffortLevels?.length),
      effort: m.supportedEffortLevels || [],
      id: m.value,
      group: m.group || null,
    }));
    this.modelsCache = { at: Date.now(), list };
    return list;
  }

  modeMenu() {
    return MODE_OPTIONS.map(m => ({
      label: m.label,
      checked: this.permissionMode === m.value,
    }));
  }

  historyMenu() {
    return listSessionFiles(this.cwd).slice(0, 30).map(s => ({
      label: s.title,
      id: s.id,
      checked: s.id === this.sessionId,
    }));
  }

  async openMenu(kind) {
    if (kind === 'mode') return this.modeMenu();
    if (kind === 'model') return this.listModels();
    if (kind === 'history') return this.historyMenu();
    return [];
  }

  async pickMenu(kind, label) {
    if (kind === 'mode') {
      const hit = MODE_OPTIONS.find(m => m.label === label || m.value === label);
      if (!hit) throw new Error('未知模式');
      return this.setPermissionMode(hit.value);
    }
    if (kind === 'model') {
      const models = await this.listModels();
      const hit = models.find(m => m.label === label || m.value === label);
      if (!hit) throw new Error('未知模型');
      return this.setModel(hit.value);
    }
    if (kind === 'history') {
      const rows = this.historyMenu();
      const hit = rows.find(r => r.label === label) || rows.find(r => r.id === label);
      if (!hit) throw new Error('找不到这段历史对话');
      await this.restart({ resume: hit.id });
      this.items.push({
        i: this.nextId('o'),
        k: 'other',
        t: `已恢复会话：${hit.label}`,
      });
      this.pushChat();
      return;
    }
    throw new Error(`未知菜单：${kind}`);
  }

  async newChat() {
    await this.restart({ resume: null });
    this.items.push({ i: this.nextId('o'), k: 'other', t: '已新建对话' });
    this.pushChat();
  }

  async refreshDiff() {
    try {
      const res = await this.control('get_workspace_diff');
      const stats = res?.diff?.stats || res?.stats;
      this.changed = Number(stats?.filesCount || res?.diff?.perFileStats?.length || 0);
      this.diffCache = res?.diff || res || null;
      this.pushChat();
    } catch {
      // older CLI / non-git cwd
    }
  }

  async listChanges() {
    await this.refreshDiff();
    const files = (this.diffCache?.perFileStats || []).map((f, i) => ({
      i,
      name: f.path,
      added: f.added || 0,
      removed: f.removed || 0,
    }));
    return { files, actions: [] };
  }

  async changeAction() {
    throw new Error('Claude 模式下请在电脑上用 git 处理改动（手机暂不支持 Keep / Undo）');
  }

  async answerQuestion(qi, oi, part, text) {
    const pending = this.pendingQuestions;
    if (!pending) throw new Error('这个问题已经不在了');
    if (part === 'skip') {
      if (pending.request_id) {
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: pending.request_id,
            response: { behavior: 'deny', message: '用户跳过了问题' },
          },
        });
      }
      this.pendingQuestions = null;
      this.pushChat();
      return;
    }
    // For AskUserQuestion tool path: send a follow-up user message with the answer.
    if (pending.via === 'tool' || !pending.request_id) {
      const q = pending.questions?.[Number(qi) || 0];
      const opt = q?.options?.[Number(oi) || 0];
      const answer = (typeof text === 'string' && text) || opt?.label || '';
      this.pendingQuestions = null;
      this.pushChat();
      if (answer) await this.sendMessage(`回答：${answer}`, { submit: true });
      return;
    }
    // Dialog control response — best-effort shape.
    const q = pending.questions?.[Number(qi) || 0];
    const opt = q?.options?.[Number(oi) || 0];
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.request_id,
        response: {
          selected: opt?.label || text || '',
          answers: [{ index: Number(qi) || 0, value: opt?.label || text || '' }],
        },
      },
    });
    this.pendingQuestions = null;
    this.pushChat();
  }

  async removeQueued(id) {
    this.queued = this.queued.filter(q => q.id !== id);
    this.pushChat();
  }

  async editQueued(id, text) {
    const q = this.queued.find(x => x.id === id);
    if (!q) throw new Error('这条排队消息已经不在了');
    if (!String(text || '').trim()) throw new Error('内容不能为空；不想要这条就点「删除」');
    q.text = String(text);
    this.pushChat();
  }

  async sendQueuedNow(id) {
    const idx = this.queued.findIndex(x => x.id === id);
    if (idx < 0) throw new Error('这条排队消息已经不在了');
    const [q] = this.queued.splice(idx, 1);
    this.pushChat();
    if (this.busy) await this.interrupt().catch(() => {});
    await this.sendMessage(q.text, { images: q.images || [], submit: true });
  }

  // Hook result → flush queue
  wireQueueFlush() {
    const prev = this.onEvent;
    this.onEvent = (ev) => {
      prev(ev);
      if (ev.type === 'result') this.flushQueue().catch(() => {});
    };
  }
}

function shortModel(id) {
  if (!id) return null;
  const s = String(id);
  if (/opus/i.test(s)) return 'Opus';
  if (/sonnet/i.test(s)) return 'Sonnet';
  if (/haiku/i.test(s)) return 'Haiku';
  if (/fable/i.test(s)) return 'Fable';
  return s.replace(/^claude-/, '').slice(0, 18);
}

function normalizeAskUserQuestion(input) {
  const questions = input?.questions || (input?.question ? [input] : null);
  if (!Array.isArray(questions) || !questions.length) return null;
  return questions.map(q => ({
    text: q.question || q.prompt || q.text || '',
    options: (q.options || q.choices || []).map((o, i) => ({
      i,
      label: typeof o === 'string' ? o : (o.label || o.text || String(o)),
      sel: false,
      free: false,
    })),
  }));
}

function normalizeDialog(req) {
  if (Array.isArray(req.questions)) {
    return req.questions.map(q => ({
      text: q.text || q.prompt || q.question || '',
      options: (q.options || []).map((o, i) => ({
        i,
        label: typeof o === 'string' ? o : (o.label || o.text || ''),
        sel: false,
        free: !!o.free,
      })),
    }));
  }
  if (req.prompt || req.message) {
    return [{
      text: req.prompt || req.message,
      options: (req.options || ['确定', '取消']).map((o, i) => ({
        i,
        label: typeof o === 'string' ? o : (o.label || ''),
        sel: false,
        free: false,
      })),
    }];
  }
  return null;
}

export function isClaudeBackend(config = {}) {
  const v = String(process.env.CR_BACKEND || config.backend || '').toLowerCase();
  return v === 'claude' || v === 'claude-code' || v === 'claude_code';
}

export function claudeCwd(config = {}) {
  return path.resolve(process.env.CLAUDE_CWD || config.claudeCwd || process.cwd());
}

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readSessionFiles() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(SESSIONS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8'));
      if (meta && meta.pid && meta.sessionId) out.push(meta);
    } catch {}
  }
  return out;
}

function projectKey(cwd) {
  return String(cwd || '').replace(/[\\/]/g, '-');
}

export function transcriptPath(cwd, sessionId) {
  return path.join(os.homedir(), '.claude', 'projects', projectKey(cwd), `${sessionId}.jsonl`);
}

// The Cursor windows on this machine. Each window's Claude Code extension writes a lock file in
// ~/.claude/ide/<port>.lock naming the folder that window has open, so one lock is one window. The port
// is the extension's own websocket; a lock whose port is gone belongs to a window that has closed.
const IDE_DIR = path.join(os.homedir(), '.claude', 'ide');

// A Cursor window opened over SSH runs its Claude Code extension on the remote host, so its lock file and
// transcripts live there, not here. These two run one ssh command on that host and parse its output;
// ControlMaster keeps the connection warm, so a list costs well under a second after the first call.
const SSH_MASTER = path.join(os.tmpdir(), 'cursor-remote-ssh-%r');

function sshControlOptions() {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', `ControlMaster=auto`,
    '-o', `ControlPath=${SSH_MASTER}`, '-o', 'ControlPersist=600'];
}

// Runs one command on a remote host and returns its stdout. Never rejects: a host that is asleep or has
// no such folder simply contributes nothing, the same way a closed window contributes nothing locally.
export function sshRun(host, command, { timeout = 12_000 } = {}) {
  return new Promise(resolve => {
    if (!/^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/.test(String(host || ''))) return resolve('');
    const child = spawn('ssh', [...sshControlOptions(), host, command], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(out); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(); }, timeout);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => {
      out += d;
      // A transcript is capped here so one large conversation cannot stall the phone's list.
      if (out.length > 8_000_000) { try { child.kill(); } catch {} done(); }
    });
    child.on('error', done);
    child.on('close', done);
  });
}

// Single-quote a string for a POSIX shell, so a message with quotes or $ in it arrives intact.
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Writes base64-decoded bytes to a remote path. The payload goes over stdin, not the command line.
function sshWrite(host, base64, remotePath) {
  return new Promise(resolve => {
    if (!/^[A-Za-z0-9+/=]+$/.test(String(base64 || ''))) return resolve(false);
    const cmd = `mkdir -p ${shellQuote(path.posix.dirname(remotePath))} && base64 -d > ${shellQuote(remotePath)}`;
    const child = spawn('ssh', [...sshControlOptions(), host, cmd], { stdio: ['pipe', 'ignore', 'ignore'] });
    let settled = false;
    const done = ok => { if (settled) return; settled = true; clearTimeout(timer); resolve(ok); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(false); }, 30_000);
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(String(base64));
  });
}

// The Cursor windows open on a remote host (where a Cursor SSH window's extension lives).
export async function listRemoteCursorWindows(host) {
  const out = await sshRun(host, 'for f in ~/.claude/ide/*.lock; do echo "@@$f"; cat "$f"; echo; done');
  const rows = [];
  for (const chunk of out.split('@@').slice(1)) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const file = chunk.slice(0, nl).trim();
    let lock;
    try { lock = JSON.parse(chunk.slice(nl + 1).trim()); } catch { continue; }
    if (!lock || lock.ideName !== 'Cursor') continue;
    const folders = Array.isArray(lock.workspaceFolders) ? lock.workspaceFolders.filter(Boolean) : [];
    if (!folders.length) continue;
    const port = Number(path.basename(file).replace(/\.lock$/, ''));
    rows.push({
      id: `ssh:${host}:${port}`,
      port,
      host,
      pid: lock.pid || 0,
      folders,
      cwd: folders[0],
      name: path.basename(folders[0]) || folders[0],
      remote: true,
    });
  }
  // A reopened folder can leave two locks behind; the same folder is one window.
  const byFolder = new Map();
  for (const row of rows) byFolder.set(row.cwd, row);
  return [...byFolder.values()];
}

// The conversations a remote window's folder has: live ones from ~/.claude/sessions, then the transcripts
// on disk. The shape matches listClaudeClients/ listClaudeHistory so the phone cannot tell them apart.
export async function listRemoteClaudeHistory(host, cwd) {
  const dirKey = String(cwd || '').replace(/[\\/]/g, '-');
  const cmd = [
    'echo "@@SESSIONS"',
    'for f in ~/.claude/sessions/*.json; do [ -f "$f" ] && cat "$f" && echo; done 2>/dev/null',
    'echo "@@TRANSCRIPTS"',
    `for f in ~/.claude/projects/${dirKey}/*.jsonl; do [ -f "$f" ] && stat -c '%n %s %Y' "$f"; done 2>/dev/null`,
    'echo "@@KEYS"',
    'for f in ~/.claude/sessions/*.key; do [ -f "$f" ] && echo "$f $(cat "$f")" && echo; done 2>/dev/null',
    // The topic is the first thing the person typed; only the head of each transcript is read for it.
    'echo "@@TOPICS"',
    `for f in ~/.claude/projects/${dirKey}/*.jsonl; do [ -f "$f" ] && echo "$f" && head -c 4000 "$f" | grep -a '"type":"user"' | head -1; done 2>/dev/null`,
  ].join('; ');
  const out = await sshRun(host, cmd);
  const part = name => {
    const start = out.indexOf(`@@${name}`);
    if (start < 0) return '';
    const end = out.indexOf('@@', start + 2);
    return out.slice(start + name.length + 2, end < 0 ? undefined : end).trim();
  };
  const alive = new Set();
  const waiting = new Map();
  for (const line of part('SESSIONS').split('\n')) {
    if (!line.trim()) continue;
    let meta;
    try { meta = JSON.parse(line); } catch { continue; }
    if (!meta?.sessionId) continue;
    // The remote lock is the only liveness signal worth trusting; a pid there means nothing here.
    alive.add(meta.sessionId);
    waiting.set(meta.sessionId, { meta });
  }
  const rows = [];
  const seen = new Set();
  const sockets = new Map();
  for (const line of part('KEYS').split('\n')) {
    const m = /^(\S+)\s+(\{.*\})$/.exec(line.trim());
    if (!m) continue;
    try {
      const d = JSON.parse(m[2]);
      const pid = Number(path.basename(m[1]).split('.')[0]);
      sockets.set(pid, { keyFile: m[1], peerToken: d.peerToken || '' });
    } catch {}
  }
  for (const [id, { meta }] of waiting) {
    if (meta.cwd && cwd && meta.cwd !== cwd) continue;
    if (meta.entrypoint === 'claude-remote-lite') continue;
    seen.add(id);
    const sock = meta.messagingSocketPath || '';
    const token = sockets.get(meta.pid)?.peerToken || '';
    rows.push({
      id,
      pid: meta.pid || 0,
      host,
      cwd: meta.cwd || cwd,
      base: path.basename(meta.cwd || cwd) || host,
      // The topic comes from the remote transcript, which costs a round trip; the caller fills it in only
      // when it needs names (the history list), and the cache keeps repeat reads from paying twice.
      name: '',
      status: meta.status || 'idle',
      waitingFor: meta.waitingFor || '',
      socket: sock,
      peerToken: token,
      startedAt: meta.startedAt || 0,
      source: meta.entrypoint || '',
      live: true,
      remote: true,
      inCursor: meta.entrypoint === 'claude-vscode',
      // Absolute path on the remote host, used to fetch the transcript over the same ssh connection.
      file: `${dirKey}/${id}.jsonl`,
    });
  }
  // Topics are keyed by transcript path; apply them to both live and closed rows.
  const topicOf = new Map();
  {
    const raw = part('TOPICS');
    for (const chunk of raw.split(/(?=^\/[^\n]*\.jsonl$)/m)) {
      const nl = chunk.indexOf('\n');
      if (nl < 0) continue;
      const file = chunk.slice(0, nl).trim();
      if (!/\.jsonl$/.test(file)) continue;
      const id = path.basename(file).replace(/\.jsonl$/, '');
      let topic = '';
      try {
        const row = JSON.parse(chunk.slice(nl + 1).trim());
        const content = row?.message?.content;
        const text = typeof content === 'string' ? content
          : Array.isArray(content) ? (content.find(c => c?.type === 'text')?.text || '') : '';
        const clean = String(text || '').trim().replace(/\s+/g, ' ');
        if (clean && !clean.startsWith('<') && !clean.startsWith('[Request interrupted')) {
          topic = clean.replace(/\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}/g, '[密钥已隐藏]').slice(0, 60);
        }
      } catch {}
      topicOf.set(id, topic);
    }
  }
  for (const row of rows) {
    const topic = topicOf.get(row.id) || '';
    row.name = topic || row.id.slice(0, 8);
    row.title = `${row.cwd || row.name} — ${row.base || ''} · ${row.name}`;
  }
  for (const line of part('TRANSCRIPTS').split('\n')) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)$/.exec(line.trim());
    if (!m) continue;
    const file = m[1];
    const mtime = Number(m[3]) * 1000;
    const id = path.basename(file).replace(/\.jsonl$/, '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id, pid: 0, host, cwd, base: path.basename(cwd) || host,
      name: '', status: 'closed', waitingFor: '', socket: '', peerToken: '',
      startedAt: mtime, source: '', live: false, remote: true, inCursor: false,
      file,
    });
  }
  return rows;
}

// Cursor's own record of the windows that are open right now, updated as windows are opened and closed.
// This is the source for the phone's window list: it knows about SSH windows too, whose files live on the
// remote host and whose IDE lock is never written here.
const CURSOR_STORAGE = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'storage.json')
  : process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'storage.json')
    : path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'storage.json');

function cursorStorage() {
  try { return JSON.parse(fs.readFileSync(CURSOR_STORAGE, 'utf8')); } catch { return null; }
}

// "file:///Users/me/p" → { host: null, root }, "vscode-remote://ssh-remote+<hex>/home/x" → { host, root }.
function parseWindowFolder(uri) {
  try {
    const u = new URL(uri);
    const root = decodeURIComponent(u.pathname).replace(/\/$/, '') || '/';
    if (u.protocol === 'file:') return { host: null, root };
    if (u.protocol !== 'vscode-remote:') return null;
    const auth = decodeURIComponent(u.host);
    const m = /^ssh-remote\+(.+)$/.exec(auth);
    if (!m) return null;
    let host = m[1];
    if (/^[0-9a-f]+$/i.test(host) && host.length % 2 === 0) {
      try { host = JSON.parse(Buffer.from(host, 'hex').toString('utf8')).hostName || host; } catch {}
    }
    return { host, root };
  } catch { return null; }
}

// Cursor writes its open windows to storage.json, but only when it gets around to it: right after a
// restart the list can still be empty while windows are plainly open. The Claude Code extension's IDE
// lock in each window is written as soon as that window loads, so both are merged. A lock only exists
// for windows with the extension's panel open, and storage.json is the only source for SSH windows, so
// neither alone is enough.
function localWindowLocks() {
  let names = [];
  try { names = fs.readdirSync(IDE_DIR).filter(n => n.endsWith('.lock')); } catch { return []; }
  const rows = [];
  for (const name of names) {
    let lock;
    try { lock = JSON.parse(fs.readFileSync(path.join(IDE_DIR, name), 'utf8')); } catch { continue; }
    // A lock left behind by Cursor before a restart names a pid that is gone.
    if (!lock || lock.ideName !== 'Cursor') continue;
    if (lock.pid && !pidAlive(lock.pid)) continue;
    const folders = Array.isArray(lock.workspaceFolders) ? lock.workspaceFolders.filter(Boolean) : [];
    if (!folders.length) continue;
    rows.push({ cwd: folders[0], pid: lock.pid || 0 });
  }
  return rows;
}

export function listCursorWindows() {
  const store = cursorStorage();
  const open = Array.isArray(store?.windowsState?.openedWindows) ? store.windowsState.openedWindows : [];
  const active = store?.windowsState?.lastActiveWindow?.folder || '';
  const rows = [];
  const seen = new Set();
  const add = (uri, extra = {}) => {
    const parsed = parseWindowFolder(uri);
    if (!parsed || !parsed.root) return;
    const key = `${parsed.host || ''}\0${parsed.root}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: parsed.host ? `ssh:${parsed.host}:${parsed.root}` : `local:${parsed.root}`,
      host: parsed.host || '',
      cwd: parsed.root,
      name: path.basename(parsed.root) || parsed.root,
      remote: Boolean(parsed.host),
      active: uri === active,
      ...extra,
    });
  };
  for (const w of open) add(String(w?.folder || ''));
  for (const lock of localWindowLocks()) add(`file://${lock.cwd}`);
  // A window whose folder is open but that Cursor has not recorded is still a window; it goes first only
  // when nothing is marked active, so the sheet keeps a stable order.
  return rows.sort((a, b) => (b.active - a.active) || (a.name || '').localeCompare(b.name || ''));
}

// A transcript's folder name is the cwd with every / turned into -, which cannot be reversed (a project
// folder can itself contain a dash), so the cwd comes from a row that carries one. The entrypoint says how
// the conversation was driven: a Cursor window's Claude Code panel (claude-vscode), a terminal CLI (cli),
// a script (sdk-cli), or a process this relay started (claude-remote-lite, never listed). A conversation
// resumed elsewhere keeps its old rows, so the head is read first and only fallen back to for the rest.
// Both are cached per file until it changes.
const transcriptHeads = new Map(); // file -> { stamp, size, cwd, source }
function transcriptMeta(file, st) {
  const stamp = st?.mtimeMs || 0;
  const size = st?.size || 0;
  const hit = transcriptHeads.get(file);
  if (hit && hit.stamp === stamp && hit.size === size) return hit;
  let cwd = '';
  let source = '';
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = raw ? raw.split('\n') : [];
  const blocks = [lines.slice(0, 200).join('\n')];
  // A resumed conversation can be long; look near the end too, but never the whole file.
  if (lines.length > 200) blocks.push(lines.slice(Math.max(200, lines.length - 200)).join('\n'));
  for (const block of blocks) {
    if (!cwd && block.includes('"cwd"')) {
      for (const line of block.split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row?.cwd) { cwd = String(row.cwd); break; }
        } catch {}
      }
    }
    if (!source) {
      const found = [...block.matchAll(/"entrypoint":"([^"]+)"/g)].map(m => m[1]);
      if (found.length) source = found[found.length - 1];
    }
  }
  const meta = { stamp, size, cwd, source };
  transcriptHeads.set(file, meta);
  // The map holds one entry per conversation; trim it when a long-lived relay accumulates many.
  if (transcriptHeads.size > 500) {
    for (const key of [...transcriptHeads.keys()].slice(0, 200)) transcriptHeads.delete(key);
  }
  return meta;
}

function sourceOfTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return ''; }
  return transcriptMeta(file, st).source;
}

function peerTokenFor(pid, socketPath) {
  if (!socketPath) return '';
  const hash = crypto.createHash('sha256').update(socketPath).digest('hex');
  const file = path.join(SESSIONS_DIR, `${pid}.${hash}.key`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).peerToken || ''; } catch { return ''; }
}

function postInbox(socketPath, token, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('发给这个 Claude 超时'));
    }, 5000);
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const lines = [];
    if (token) lines.push(JSON.stringify({ type: 'auth', token }));
    lines.push(JSON.stringify({
      msgV: 1,
      msg_id: `cc-msg-${crypto.randomBytes(16).toString('hex')}`,
      type: 'user',
      message: { role: 'user', content: text },
      priority: 'now',
    }));
    sock.on('connect', () => sock.end(lines.join('\n') + '\n'));
    sock.on('error', e => done(new Error(`连不上这个 Claude：${e.message}`)));
    sock.on('close', () => done());
  });
}

// Every conversation this machine has a transcript for, live or closed, newest first. A folder is taken
// from the transcript's own `cwd`; transcripts a relay started are left out because they are not the
// person's own windows. Closed ones are read-only: the phone can read them, and asking Cursor to reopen
// one puts it back in the panel it came from.
export function listClaudeSessions({ limit = 60 } = {}) {
  const projects = path.join(os.homedir(), '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return []; }
  const rows = [];
  for (const dir of dirs) {
    const full = path.join(projects, dir);
    let names = [];
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      names = fs.readdirSync(full).filter(n => n.endsWith('.jsonl'));
    } catch { continue; }
    for (const name of names) {
      const file = path.join(full, name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size < 32) continue;
      const id = name.replace(/\.jsonl$/, '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
      const meta = transcriptMeta(file, st);
      // A relay of its own started this one; it is not a window the person opened.
      if (meta.source === 'claude-remote-lite') continue;
      rows.push({ id, cwd: meta.cwd, source: meta.source, mtime: st.mtimeMs, file });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

// Live Claude Code processes on this machine, one row per terminal / client.
export function listClaudeClients() {
  const rows = [];
  for (const meta of readSessionFiles()) {
    if (meta.entrypoint === 'claude-remote-lite') continue;
    if (!pidAlive(meta.pid)) continue;
    if (meta.messagingSocketPath && !fs.existsSync(meta.messagingSocketPath)) continue;
    const cwd = meta.cwd || '';
    const base = path.basename(cwd) || meta.name || `claude-${meta.pid}`;
    const file = transcriptPath(cwd, meta.sessionId);
    const topic = pinnedTopic(meta.sessionId, file);
    rows.push({
      id: meta.sessionId,
      pid: meta.pid,
      cwd,
      base,
      name: topic || (meta.nameSource === 'derived' ? '' : meta.name) || base,
      status: meta.status || 'idle',
      waitingFor: meta.waitingFor || '',
      socket: meta.messagingSocketPath || '',
      startedAt: meta.startedAt || 0,
      source: meta.entrypoint || sourceOfTranscript(file),
      live: true,
      inCursor: meta.entrypoint === 'claude-vscode',
    });
  }
  // One conversation can have two live processes (an old one left running and a newer resume). Show it
  // once, as the newest, so the list never marks two rows as the current one.
  const newest = new Map();
  for (const row of rows) {
    const seen = newest.get(row.id);
    if (!seen || row.startedAt > seen.startedAt) newest.set(row.id, row);
  }
  rows.splice(0, rows.length, ...newest.values());
  const bases = new Map();
  for (const row of rows) bases.set(row.base, (bases.get(row.base) || 0) + 1);
  for (const row of rows) {
    const label = bases.get(row.base) > 1 ? `${row.base} · ${row.name}` : row.base;
    // "path — folder" so the phone shows the folder name, with the path underneath.
    row.title = `${row.cwd || row.name} — ${label}`;
    row.kind = 'claude';
  }
  rows.sort((a, b) => a.base.localeCompare(b.base) || b.startedAt - a.startedAt);
  return rows;
}

// A remote host costs a slow round trip per call, so a window's conversations are cached briefly. The
// list is what the 历史 button asks for, not a live feed, so a few seconds stale is fine and keeps the
// button feeling instant; a miss or an expired entry re-reads the host.
const remoteHistoryCache = new Map(); // "host\0cwd" -> { at, rows }
const REMOTE_HISTORY_TTL = 5000;

export async function remoteClaudeHistory(host, cwd) {
  const key = `${host}\0${cwd}`;
  const hit = remoteHistoryCache.get(key);
  if (hit && Date.now() - hit.at < REMOTE_HISTORY_TTL) return hit.rows;
  // A fetch that overlaps another keeps the older answer instead of piling up ssh sessions.
  const rows = await listRemoteClaudeHistory(host, cwd).catch(() => hit?.rows || []);
  remoteHistoryCache.set(key, { at: Date.now(), rows });
  return rows;
}

// The conversations of one Cursor window: every live process there, then the ones that are no longer
// running, newest first. Passing no window lists the whole machine, which only the relay's own health
// line uses; the phone always asks for one window at a time.
export function listClaudeHistory({ cwd = '', onlyCursor = false } = {}) {
  const live = listClaudeClients().filter(r => !cwd || !r.cwd || r.cwd === cwd);
  const seen = new Set(live.map(r => r.id));
  const closed = [];
  for (const s of listClaudeSessions({ limit: 200 })) {
    if (seen.has(s.id)) continue;
    if (cwd && s.cwd !== cwd) continue;
    if (onlyCursor && s.source !== 'claude-vscode') continue;
    const base = path.basename(s.cwd) || 'claude';
    const topic = pinnedTopic(s.id, s.file) || s.id.slice(0, 8);
    closed.push({
      id: s.id,
      pid: 0,
      cwd: s.cwd,
      base,
      name: topic,
      status: 'closed',
      waitingFor: '',
      socket: '',
      startedAt: s.mtime,
      source: s.source,
      live: false,
      inCursor: s.source === 'claude-vscode',
      file: s.file,
      kind: 'claude',
      title: `${s.cwd || topic} — ${base} · ${topic}`,
    });
  }
  const rows = [...live, ...closed];
  return labelHistory(rows);
}

// Kept separate so the remote list goes through exactly the same naming rules.
export function labelHistory(rows) {
  // Two conversations often start with the same words ("hi"); the history list shows only the topic, so
  // repeated names get a time suffix that tells them apart.
  const counts = new Map();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) || 0) + 1);
  const when = t => {
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  for (const r of rows) {
    r.when = when(r.startedAt);
    if ((counts.get(r.name) || 0) > 1 && r.when) r.name = `${r.name} · ${r.when}`;
  }
  return rows;
}

export function stopRelayOwnedSessions() {
  for (const meta of readSessionFiles()) {
    if (meta.entrypoint !== 'claude-remote-lite') continue;
    if (!pidAlive(meta.pid)) continue;
    try { process.kill(meta.pid, 'SIGTERM'); } catch {}
  }
}

const inboxes = new Map();

export function inboxFor(client, onUpdate) {
  let box = inboxes.get(client.id);
  // The closed reader and a live process share a conversation id but not a channel: when the process
  // appears, it replaces the closed one rather than borrowing its empty socket and pid.
  const stale = box && (box.closed !== (client.live === false));
  if (box && !stale) {
    box.onUpdate = onUpdate || box.onUpdate;
    box.meta = { ...box.meta, ...client };
    return box;
  }
  if (stale) dropInbox(client.id);
  box = new ClaudeInbox(client, onUpdate);
  inboxes.set(client.id, box);
  box.start();
  return box;
}

export function dropInbox(id) {
  const box = inboxes.get(id);
  if (!box) return;
  box.stop();
  inboxes.delete(id);
}

const PERM_LABEL = {
  default: 'Default',
  auto: 'Auto',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass',
  dontAsk: "Don't ask",
};

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

// Follows a running Claude Code client: reads its transcript and injects messages into its terminal.
export class ClaudeInbox {
  constructor(meta, onUpdate) {
    this.meta = meta;
    this.onUpdate = onUpdate || (() => {});
    this.items = [];
    this.permissionMode = 'default';
    this.model = null;
    this.busy = false;
    this.waitingFor = '';
    this.alive = true;
    // A conversation with no live process is still readable from its transcript; it just cannot be typed into.
    this.closed = !meta.pid || meta.live === false;
    // The Agent's pending question, read from the Cursor panel's own DOM (the transcript does not carry it).
    this.question = null;
    this.lastRaw = null;
    this.lastStamp = 0;
    this.lastSnap = '';
    this.timer = null;
  }

  // The relay fills this in after reading the panel; it is what makes the question card show on the phone.
  setQuestion(q) {
    this.question = q || null;
    this.publish();
  }

  // A distinctive line from this conversation, used to check that a Cursor panel is really showing it
  // before the relay types there. The first human turn is used rather than the last: a panel can keep an
  // older conversation's tail in the DOM, but a conversation's opening request is what its own page shows
  // from the top, and short pings ("hi", "OK") appear in many conversations and would match the wrong one.
  confirmText() {
    for (const it of this.items) {
      if (it.k !== 'human') continue;
      const t = String(it.t || '').replace(/\s+/g, ' ').trim();
      if (t.length >= 12) return t.slice(0, 80);
    }
    // A conversation whose every turn is a short ping can only be checked loosely.
    for (const it of this.items) {
      if (it.k === 'human' && it.t) return String(it.t).replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    return '';
  }

  get cwd() { return this.meta.cwd || process.cwd(); }

  // A Cursor window's Claude panel is a conversation of its own: it is driven through its peer socket,
  // never by resuming it in a second process.
  get inCursor() { return this.meta.inCursor === true || this.meta.source === 'claude-vscode'; }

  // The transcript for this conversation: the one the list found, or the usual place by folder + id.
  get file() { return this.meta.file || transcriptPath(this.meta.cwd, this.meta.id); }

  // A conversation whose Claude Code runs on a remote host (an SSH window). Its transcript and peer
  // socket are there, so both reading and posting go over ssh instead of the local filesystem.
  get remote() { return Boolean(this.meta.remote && this.meta.host); }

  start() {
    this.load();
    // A remote conversation is not polled: one read on attach, and a fresh one when the phone asks for it.
    if (this.remote) return;
    this.timer = setInterval(() => this.load(), 800);
  }

  // Re-reads a remote transcript after a message was sent, or when the phone pulls to refresh.
  refresh() {
    if (this.remote) { this.lastStamp = 0; return this.loadRemote({ force: true }); }
    this.lastStamp = 0;
    return this.load();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // load() reads the conversation twice a second; the mtime check keeps a big transcript from being
  // re-read and re-parsed when nothing has been appended.
  mtime() {
    try { return fs.statSync(this.file).mtimeMs; } catch { return 0; }
  }

  refreshMeta() {
    if (this.closed) {
      // No process to watch: it is closed until Cursor (or a terminal) opens it again.
      this.alive = false;
      this.busy = false;
      return;
    }
    const file = path.join(SESSIONS_DIR, `${this.meta.pid}.json`);
    try {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (meta.sessionId && meta.sessionId !== this.meta.id) throw new Error('pid reused');
      this.alive = pidAlive(meta.pid);
      this.meta = {
        ...this.meta,
        cwd: meta.cwd || this.meta.cwd,
        socket: meta.messagingSocketPath || this.meta.socket,
        status: meta.status || 'idle',
      };
      this.waitingFor = meta.waitingFor || '';
      this.busy = this.alive && meta.status && meta.status !== 'idle';
    } catch {
      this.alive = pidAlive(this.meta.pid);
      if (!this.alive) this.busy = false;
    }
  }

  load() {
    if (this.remote) return this.loadRemote();
    if (this.closed) this.alive = false;
    else this.refreshMeta();
    const stamp = this.mtime();
    if (stamp && stamp === this.lastStamp) { this.publish(); return; }
    this.lastStamp = stamp;
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { raw = ''; }
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.items = parseTranscript(raw, this.cwd);
      if (parseTranscript.mode) this.permissionMode = parseTranscript.mode;
      if (parseTranscript.model) this.model = parseTranscript.model;
    }
    this.publish();
  }

  // A remote transcript is read once and then only when the phone asks again. The link to an SSH host can
  // be slow (tens of KB/s on a bad day), so polling it on a timer would spend the whole connection
  // transferring the same tail; the transcript on that host only changes while its Claude is running, and
  // a running turn is visible from the session's status without reading the file.
  loadRemote({ force = false } = {}) {
    if (this.loading) return;
    if (!force && this.lastStamp) return;
    this.loading = true;
    const dirKey = String(this.cwd || '').replace(/[\\/]/g, '-');
    const rel = `~/.claude/projects/${dirKey}/${this.meta.id}.jsonl`;
    // Last 60 KB is a few hundred turns; `tail` can cut the first line, which the parser skips.
    const cmd = `stat -c %Y ${rel} 2>/dev/null; echo '@@'; tail -c 60000 ${rel} 2>/dev/null`;
    sshRun(this.meta.host, cmd, { timeout: 45_000 }).then(out => {
      this.loading = false;
      const cut = out.indexOf('@@');
      const stamp = Number(out.slice(0, Math.max(0, cut)).trim()) * 1000 || 0;
      const raw = cut < 0 ? '' : out.slice(cut + 2);
      this.alive = Boolean(this.meta.live);
      this.busy = this.alive && this.meta.status && this.meta.status !== 'idle';
      this.waitingFor = this.meta.waitingFor || '';
      if (stamp && stamp === this.lastStamp) { this.publish(); return; }
      this.lastStamp = stamp;
      if (raw && raw !== this.lastRaw) {
        this.lastRaw = raw;
        this.items = parseTranscript(raw, this.cwd);
        if (parseTranscript.mode) this.permissionMode = parseTranscript.mode;
        if (parseTranscript.model) this.model = parseTranscript.model;
      }
      this.publish();
    }).catch(() => { this.loading = false; this.publish(); });
  }

  publish() {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json === this.lastSnap) return;
    this.lastSnap = json;
    this.onUpdate(snap);
  }

  snapshot() {
    const items = this.items.slice(-200);
    const where = this.inCursor ? 'Cursor 窗口' : '终端';
    if (this.closed) items.push({ i: 'gone', k: 'other', t: `这段会话已经关闭，正在看它的历史。点「在 Cursor 里打开」可以让它继续。` });
    else if (!this.alive) items.push({ i: 'gone', k: 'other', t: `这个 Claude 已经退出（原来的${where}）` });
    else if (this.waitingFor) items.push({ i: 'wait', k: 'other', t: `终端正在等待：${this.waitingFor}` });
    // A question the Agent is asking is put in the shape the phone's question card already understands,
    // so it can be answered from the phone instead of only at the computer.
    const asked = this.question;
    return {
      rect: null,
      items,
      global: [],
      busy: this.busy,
      queued: [],
      subagents: [],
      changed: 0,
      questions: asked ? {
        list: [{
          text: asked.text || 'Agent 在问你',
          options: (asked.options || []).map(o => ({ label: o.label, sel: Boolean(o.selected), free: false })),
        }],
        canSubmit: Boolean(asked.canSubmit),
      } : null,
      // A closed conversation is read-only until it is reopened; a live one takes keys as usual.
      readonly: this.closed || !this.alive,
      // The phone tells the two read-only cases apart without matching on the notice text.
      closed: this.closed,
      where,
      mode: PERM_LABEL[this.permissionMode] || this.permissionMode || 'Claude',
      model: this.model || 'Claude',
    };
  }

  async sendMessage(text, { images = [], submit = true } = {}) {
    if (!submit) return false;
    if (this.remote) return this.sendRemote(String(text || '').trim(), images);
    if (this.closed) throw new Error('这个会话已经关闭。点上面的「在 Cursor 里打开」，等它跑起来再发');
    if (!this.alive) throw new Error('这个 Claude 已经退出，请重新打开列表');
    const socket = this.meta.socket;
    if (!socket || !fs.existsSync(socket)) throw new Error('这个 Claude 的终端已经不在了');
    let body = String(text || '').trim();
    const notes = [];
    for (const img of images) {
      if (!img?.data || !img?.type) continue;
      const dir = path.join(this.cwd, 'temp');
      fs.mkdirSync(dir, { recursive: true });
      const ext = img.type === 'image/png' ? 'png' : img.type === 'image/gif' ? 'gif' : img.type === 'image/webp' ? 'webp' : 'jpg';
      const file = path.join(dir, `phone-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.${ext}`);
      fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
      notes.push(path.relative(this.cwd, file));
    }
    if (notes.length) body = `${notes.join('\n')}${body ? `\n${body}` : ''}`;
    if (!body) throw new Error('内容不能为空');
    const token = peerTokenFor(this.meta.pid, socket);
    await postInbox(socket, token, body);
    setTimeout(() => this.load(), 400);
    return false;
  }

  // A remote conversation takes its message through its own peer socket on that host. Images are written
  // to the remote project's temp/ first, so the path in the message means something there.
  async sendRemote(text, images = []) {
    if (this.closed) throw new Error('这个会话已经关闭。先在 Cursor 窗口里打开它');
    if (!this.alive) throw new Error('这个 Claude 已经退出，请重新打开列表');
    const socket = this.meta.socket;
    if (!socket) throw new Error('这个 Claude 没有可用的消息通道');
    let body = text;
    const notes = [];
    for (const img of images) {
      if (!img?.data || !img?.type) continue;
      const ext = img.type === 'image/png' ? 'png' : img.type === 'image/gif' ? 'gif' : img.type === 'image/webp' ? 'webp' : 'jpg';
      const rel = `temp/phone-${Date.now()}-${crypto.randomBytes(2).toString('hex')}.${ext}`;
      // base64 through ssh's stdin keeps the payload off the command line, where it would be too long.
      const wrote = await sshWrite(this.meta.host, img.data, `${this.cwd}/${rel}`);
      if (wrote) notes.push(rel);
    }
    if (notes.length) body = `${notes.join('\n')}${body ? `\n${body}` : ''}`;
    if (!body) throw new Error('内容不能为空');
    const line = JSON.stringify({
      type: 'auth',
      token: this.meta.peerToken || '',
    });
    const msg = JSON.stringify({
      msgV: 1,
      msg_id: `cc-msg-${crypto.randomBytes(16).toString('hex')}`,
      type: 'user',
      message: { role: 'user', content: body },
      priority: 'now',
    });
    // Sending is one round trip: feed both lines to the socket on the host, then close it.
    const cmd = `printf '%s\\n%s\\n' ${shellQuote(line)} ${shellQuote(msg)} | nc -U -w5 ${shellQuote(socket)}`;
    const out = await sshRun(this.meta.host, cmd, { timeout: 15_000 });
    if (out === null) throw new Error('发到远程电脑失败');
    setTimeout(() => this.refresh(), 1200);
    return false;
  }

  async openMenu(kind) {
    if (kind === 'mode') {
      return Object.entries(PERM_LABEL).map(([value, label]) => ({
        label,
        checked: (PERM_LABEL[this.permissionMode] || this.permissionMode) === label || this.permissionMode === value,
      }));
    }
    if (kind === 'model') {
      const base = process.env.CR_MODELS_API_BASE;
      const key = process.env.CR_MODELS_API_KEY;
      const apiModels = await fetchApiModels(base, key);
      const raw = apiModels.length ? apiModels : await fetchModelList();
      if (!raw.length) return [{ label: this.model || '当前模型', checked: true }];
      return raw.map(m => ({
        label: m.displayName || m.value,
        value: m.value,
        checked: !!(this.model && (m.resolvedModel === this.model || m.value === this.model))
          || (!this.model && m.value === 'default'),
        params: false,
        id: m.value,
        group: m.group || null,
      }));
    }
    if (kind === 'history') return [];
    return [];
  }

  async pickMenu(kind, label) {
    if (kind === 'mode') throw new Error('这个会话在终端里。换模式请在那个终端用对应的命令');
    if (kind === 'model') {
      const socket = this.meta.socket;
      if (!socket) throw new Error('这个会话在终端里，没有可用的消息通道');
      const models = await fetchApiModels(process.env.CR_MODELS_API_BASE, process.env.CR_MODELS_API_KEY);
      const hit = models.find(m => m.value === label || m.displayName === label);
      if (!hit) throw new Error('未知模型');
      const token = peerTokenFor(this.meta.pid, socket);
      await postInbox(socket, token, `/model ${hit.value}`);
      setTimeout(() => this.load(), 600);
      return;
    }
    throw new Error('这个会话在终端里，不支持此操作');
  }

  async newChat() {
    throw new Error('在项目目录新开一个 claude，它会自动出现在切换列表里');
  }

  async interrupt() {
    throw new Error('请在那个终端里按 Esc 停止当前这一轮');
  }

  async clickButton() {
    throw new Error('批准和提问请在对应的终端里操作，手机会同步显示结果');
  }

  async editQueued() { throw new Error('这条消息在终端自己的队列里'); }
  async removeQueued() { throw new Error('这条消息在终端自己的队列里'); }
  async sendQueuedNow() { throw new Error('这条消息在终端自己的队列里'); }
  async answerQuestion() { throw new Error('请在对应的终端里回答'); }
  async listChanges() { return { files: [], actions: [] }; }
  async changeAction() { throw new Error('改动请在终端里处理'); }
}

const PEER_HEADER = /^Another Claude session sent a message:\n/;
const PEER_FOOTER = /\n\nThis came from another Claude session[\s\S]*$/;

function peerUserText(text) {
  if (!PEER_HEADER.test(text)) return null;
  return text.replace(PEER_HEADER, '').replace(PEER_FOOTER, '').trim();
}

function parseTranscript(raw, cwd = '') {
  const items = [];
  let seq = 0;
  let mode = 'default';
  let model = null;
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain) continue;
    if (row.type === 'permission-mode' && row.permissionMode) mode = row.permissionMode;
    if (row.type === 'attachment' && row.attachment?.type === 'model') {
      const idn = row.attachment.identity || {};
      model = idn.marketingName || idn.modelId || model;
    }
    if (row.type === 'user') {
      const blocks = asBlocks(row.message?.content);
      // Tool results are role=user with tool_result blocks — not human chat.
      if (blocks.length && blocks.every(b => b.type === 'tool_result')) continue;
      let text = blocks.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
      if (!text && typeof row.message?.content === 'string') text = row.message.content.trim();
      if (!text) continue;
      if (row.isMeta) {
        const peer = peerUserText(text);
        if (peer == null) continue; // slash-command caveats and other harness noise
        text = peer;
      }
      if (text.includes('<local-command-stdout') || text.startsWith('<command-') || text.includes('<local-command-caveat')) continue;
      const id = row.uuid || `u${seq++}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const imgs = [];
      const lines = text.split('\n');
      const kept = [];
      for (const l of lines) {
        const s = l.trim();
        if (/^(temp\/)?phone-\d+-[0-9a-f]+\.(jpe?g|png|gif|webp)$/i.test(s)) {
          imgs.push(path.isAbsolute(s) ? s : path.resolve(cwd || process.cwd(), s));
        } else kept.push(l);
      }
      const item = { i: id, k: 'human', t: kept.join('\n').trim().slice(0, 8000) };
      if (imgs.length) item.imgs = imgs;
      if (!item.t && !item.imgs?.length) continue;
      items.push(item);
    } else if (row.type === 'assistant') {
      if (row.isMeta) continue;
      const blocks = asBlocks(row.message?.content);
      if (row.message?.model && !model) model = shortModel(row.message.model);
      else if (row.message?.model && model && !String(model).includes(' ')) model = shortModel(row.message.model);
      for (const block of blocks) {
        if (block.type === 'text' && block.text?.trim()) {
          const id = `${row.uuid || 'a'}-t${seq++}`;
          items.push({ i: id, k: 'assistant', h: mdToHtml(block.text) });
        } else if (block.type === 'tool_use') {
          const q = block.name === 'AskUserQuestion' ? normalizeAskUserQuestion(block.input) : null;
          if (q) {
            const text = q.map(x => [x.text, ...x.options.map(o => `- ${o.label}`)].filter(Boolean).join('\n')).join('\n\n');
            items.push({ i: block.id || `t${seq++}`, k: 'assistant', h: mdToHtml(text) });
            continue;
          }
          items.push({
            i: block.id || `t${seq++}`,
            k: 'tool',
            t: toolSummary(block.name, block.input),
            f: toolFile(block.name, block.input),
          });
        }
      }
    }
  }
  parseTranscript.mode = mode;
  parseTranscript.model = model;
  return items;
}
