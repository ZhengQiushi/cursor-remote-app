// Resolves file references from Cursor chats and reads them from the local disk or, for SSH windows, over ssh.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TEXT_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };

const STORAGE_DIRS = {
  darwin: '~/Library/Application Support/Cursor/User/workspaceStorage',
  linux: '~/.config/Cursor/User/workspaceStorage',
  win32: `${process.env.APPDATA}/Cursor/User/workspaceStorage`,
};

// vscode-remote://ssh-remote+<host or hex-encoded {"hostName":...}>/path
function parseFolderUri(uri) {
  const u = new URL(uri);
  if (u.protocol === 'file:') return { host: null, root: decodeURIComponent(u.pathname) };
  if (u.protocol !== 'vscode-remote:') return null;
  const authority = decodeURIComponent(u.host);
  const m = /^ssh-remote\+(.+)$/.exec(authority);
  if (!m) return null;
  let host = m[1];
  if (/^[0-9a-f]+$/i.test(host) && host.length % 2 === 0) {
    try { host = JSON.parse(Buffer.from(host, 'hex').toString('utf8')).hostName || host; } catch {}
  }
  return { host, root: decodeURIComponent(u.pathname) };
}

// Every folder Cursor has opened, newest first.
export function workspaces() {
  const dir = (STORAGE_DIRS[process.platform] || STORAGE_DIRS.linux).replace(/^~/, os.homedir());
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    const file = path.join(dir, name, 'workspace.json');
    try {
      const { folder } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ws = folder && parseFolderUri(folder);
      if (ws) out.push({ ...ws, uri: folder, mtime: fs.statSync(file).mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// SSH folders Cursor has actually opened, newest first, one entry per host + directory.
export function sshWorkspaces(limit = 12) {
  const seen = new Set();
  const out = [];
  for (const w of workspaces()) {
    if (!w.host || !w.uri || !w.uri.startsWith('vscode-remote://ssh-remote')) continue;
    const key = `${w.host}\0${w.root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

// Host names shown in Cursor's Remote Explorer → SSH TARGETS. They come from ~/.ssh/config.
export function sshConfigHosts() {
  const file = path.join(os.homedir(), '.ssh', 'config');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  const seen = new Set();
  let names = [];
  let hostname = '';
  let user = '';
  const commit = () => {
    for (const name of names) {
      if (!name || seen.has(name) || /[*?]/.test(name)) continue;
      seen.add(name);
      out.push({ host: name, hostname: hostname || name, user });
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'host') {
      commit();
      names = val.split(/\s+/).filter(Boolean);
      hostname = '';
      user = '';
    } else if (key === 'match') {
      commit();
      names = [];
      hostname = '';
      user = '';
    } else if (names.length && key === 'hostname' && !hostname) hostname = val;
    else if (names.length && key === 'user' && !user) user = val;
  }
  commit();
  return out;
}

// Window titles look like "file.py — Folder [SSH: host]", "Folder", or just "Cursor"
// for an empty remote window (the host is then only on the status bar).
export function workspaceForTitle(title) {
  const host = /\[SSH: ([^\]]+)\]/.exec(title)?.[1] || null;
  const folder = title.replace(/\s*\[SSH: [^\]]+\]\s*$/, '').split(' — ').pop().replace(/^●\s*/, '').trim();
  return workspaces().find(w => w.host === host && path.posix.basename(w.root) === folder) || null;
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Remote paths starting with ~/ must leave the tilde unquoted so the remote shell expands it.
const remotePath = p => p.startsWith('~/') ? `"$HOME"/${shq(p.slice(2))}` : shq(p);

// One shared master connection per host: faster, and avoids sshd's MaxStartups dropping bursts of new connections.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.homedir(), '.cursor-remote-lite', 'ssh-%C')}`, '-o', 'ControlPersist=120'];

async function ssh(host, command, limit) {
  try {
    return await sshOnce(host, command, limit);
  } catch {
    await new Promise(r => setTimeout(r, 500));
    return sshOnce(host, command, limit).catch(e => { throw new Error(`SSH 连接 ${host} 失败：${e.message}`); });
  }
}

function sshOnce(host, command, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0, err = '';
    child.stdout.on('data', c => { if (size < limit) { chunks.push(c); size += c.length; } });
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).subarray(0, limit));
      else reject(new Error(err.trim().split('\n').pop() || `ssh exited with ${code}`));
    });
  });
}

export function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[/\\]/g, '');
  const cleaned = base.replace(/[^\w.\- ()\u4e00-\u9fff]+/g, '_').replace(/^\.+/, '').slice(0, 80);
  return cleaned || 'file';
}

function expandHome(p) {
  return String(p || '').replace(/^~(?=\/)/, os.homedir());
}

function uniqueLocal(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem}-${i}${ext}`;
  return path.join(dir, candidate);
}

function pipeToRemote(host, remoteFile, localFile) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, host, `mkdir -p ${remotePath(path.posix.dirname(remoteFile))} && cat > ${remotePath(remoteFile)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', c => { err += c; });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    fs.createReadStream(localFile).pipe(child.stdin);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim().split('\n').pop() || `ssh exited with ${code}`));
    });
  });
}

// Copy a local file into <workspace>/temp and return the workspace-relative path.
export async function saveToWorkspaceTemp(host, root, localFile, name) {
  if (!root) throw new Error('找不到当前项目目录，先在电脑上打开一个文件夹');
  const safe = safeFileName(name);
  if (!host) {
    const dir = path.join(expandHome(root), 'temp');
    fs.mkdirSync(dir, { recursive: true });
    const dest = uniqueLocal(dir, safe);
    fs.copyFileSync(localFile, dest);
    return `temp/${path.basename(dest)}`;
  }
  const dir = String(root).replace(/\/$/, '') + '/temp';
  await ssh(host, `mkdir -p ${remotePath(dir)}`, 4096);
  const ext = path.posix.extname(safe);
  const stem = path.posix.basename(safe, ext);
  let destName = safe;
  const exists = await ssh(host, `test -e ${remotePath(dir + '/' + destName)} && echo yes || true`, 16);
  if (String(exists).includes('yes')) destName = `${stem}-${Date.now().toString(36)}${ext}`;
  await pipeToRemote(host, `${dir}/${destName}`, localFile);
  return `temp/${destName}`;
}

// Returns the size of a regular file, or null if it doesn't exist.
export async function fileSize(host, p) {
  if (!host) {
    try {
      const st = fs.statSync(p.replace(/^~(?=\/)/, os.homedir()));
      return st.isFile() ? st.size : null;
    } catch { return null; }
  }
  // Exits 0 whether or not the file exists, so a rejection here always means the connection failed.
  const out = await ssh(host, `test -f ${remotePath(p)} && stat -c %s -- ${remotePath(p)} || true`, 64);
  const n = parseInt(out.toString(), 10);
  return Number.isFinite(n) ? n : null;
}

async function readHead(host, p, limit) {
  if (!host) {
    const fd = fs.openSync(p.replace(/^~(?=\/)/, os.homedir()), 'r');
    try {
      const buf = Buffer.alloc(limit);
      const n = fs.readSync(fd, buf, 0, limit, 0);
      return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  }
  return ssh(host, `head -c ${limit} -- ${remotePath(p)}`, limit);
}

export async function readFile(host, p, size) {
  const name = path.posix.basename(p);
  const image = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (image) {
    if (size > IMAGE_LIMIT) throw new Error(`图片太大（${(size / 1048576).toFixed(1)} MB），请在电脑上看`);
    const buf = await readHead(host, p, size);
    return { image: `data:${image};base64,${buf.toString('base64')}` };
  }
  const buf = await readHead(host, p, Math.min(size, TEXT_LIMIT));
  if (buf.subarray(0, 8192).includes(0)) throw new Error('二进制文件，不能预览');
  return { text: buf.toString('utf8'), truncated: size > TEXT_LIMIT };
}

// "src/a.py:12", "a.py#L12-20", "a.py (lines 3-9)" → path + first line.
export function parseRef(text) {
  let s = String(text).trim().replace(/^[`'"]+|[`'",;:.)]+$/g, '');
  let line = null;
  const m = /(?::(\d+)(?::\d+)?(?:-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(s);
  if (m) { line = Number(m[1] || m[2]); s = s.slice(0, m.index); }
  return { p: s, line };
}
