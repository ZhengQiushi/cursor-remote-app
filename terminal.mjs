// A real terminal on this computer: one program (Claude Code by default) under a pseudo-terminal,
// so the phone can answer its prompts exactly as a keyboard at the desk would.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pty-helper.py');
const SCROLLBACK = 400_000; // characters replayed to a phone that attaches later

export class TerminalProcess {
  constructor({ argv, cwd, cols, rows, session = '', onData, onExit }) {
    this.session = session;         // the conversation it resumes, '' for a new one
    this.onData = onData;
    this.onExit = onExit;
    this.backlog = '';
    this.exited = false;
    this.cols = clampSize(cols, 20, 240, 80);
    this.rows = clampSize(rows, 6, 100, 24);
    this.child = spawn('python3', ['-u', HELPER, String(this.cols), String(this.rows), ...argv], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = chunk => {
      const text = chunk.toString('utf8');
      this.backlog = (this.backlog + text).slice(-SCROLLBACK);
      this.onData(text);
    };
    this.child.stdout.on('data', output);
    this.child.stderr.on('data', output);
    this.child.stdin.on('error', () => {});
    this.child.on('error', error => {
      this.exited = true;
      this.onData(`无法启动终端：${error.message}\r\n`);
      this.onExit(127);
    });
    this.child.on('close', (code, signal) => {
      this.exited = true;
      this.onExit(code ?? (signal ? 128 : 1));
    });
  }

  get alive() {
    return !this.exited;
  }

  write(text) {
    if (this.exited) return;
    const body = Buffer.from(text, 'utf8');
    const head = Buffer.alloc(5);
    head.write('I', 0);
    head.writeUInt32BE(body.length, 1);
    this.child.stdin.write(Buffer.concat([head, body]));
  }

  resize(cols, rows) {
    if (this.exited) return;
    this.cols = clampSize(cols, 20, 240, this.cols);
    this.rows = clampSize(rows, 6, 100, this.rows);
    const frame = Buffer.alloc(5);
    frame.write('R', 0);
    frame.writeUInt16BE(this.cols, 1);
    frame.writeUInt16BE(this.rows, 3);
    this.child.stdin.write(frame);
  }

  // Closing the helper's stdin hangs the program up; a program that ignores that is killed.
  close() {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    timer.unref();
  }
}

function clampSize(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
