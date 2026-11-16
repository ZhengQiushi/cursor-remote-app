// Types into the Claude Code panel inside a Cursor window over the Chrome DevTools Protocol.
//
// Sending a phone message through Claude's peer socket makes it arrive as "another Claude session sent
// a message", which the model then wants to answer as a teammate — the wrong thing for a message the
// person typed. This drives the panel's own composer instead: focus it, insert the text as if typed,
// press Enter. The transcript then records a normal user turn.
//
// The panel lives two frames deep in a Cursor window: page → webview iframe → #active-frame (fake.html).
// Two states block the composer and both are handled here:
//   - the webview has not loaded yet (no #active-frame content),
//   - Cursor shows "This conversation is still open somewhere else" with an "Open here anyway" button,
//     which the panel marks hostUnresponsive_07S1Yg.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const CDP_URL = (process.env.CDP_URL || 'http://127.0.0.1:9222').replace(/\/$/, '');

export async function cdpTargets() {
  const res = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`CDP 返回 ${res.status}`);
  return res.json();
}

// Opens a CDP websocket and returns a tiny client: send(method, params) and evaluate(expression).
function connect(wsUrl, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const open = setTimeout(() => reject(new Error('连不上 Cursor 的调试端口')), timeout);
    ws.on('open', () => {
      clearTimeout(open);
      const send = (method, params = {}, sid = undefined) => new Promise((res, rej) => {
        const id = ++nextId;
        pending.set(id, { res, rej });
        const msg = { id, method, params };
        if (sid) msg.sessionId = sid;
        ws.send(JSON.stringify(msg));
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }, timeout);
      });
      ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg.id || !pending.has(msg.id)) return;
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      });
      const evaluate = async (expression, sid) => {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed');
        return r.result?.value;
      };
      const close = () => { try { ws.close(); } catch {} };
      resolve({ send, evaluate, close });
    });
    ws.on('error', () => { clearTimeout(open); reject(new Error('连不上 Cursor 的调试端口')); });
  });
}

// The window's page target, matched by the folder it has open (the title ends with " — <folder>").
async function pageFor(folder) {
  const targets = await cdpTargets();
  const pages = targets.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('Cursor 没有开调试端口。用 ./start-cursor.sh 启动 Cursor 后再试');
  const base = String(folder || '').split('/').filter(Boolean).pop() || '';
  if (!base) return pages[0];
  const hit = pages.find(t => (t.title || '').includes(base));
  return hit || null;
}

// Cursor keeps one webview per Claude Code tab and only one is on screen; the others stay loaded but
// hidden inside a display:none pane. Typing into a hidden one would put the message into a conversation
// nobody is looking at, so visibility is checked from the page that owns the iframes.
async function visibleWebviewNames(pageClient) {
  try {
    const list = await pageClient.evaluate(`(() => {
      const out = [];
      for (const f of document.querySelectorAll('iframe.webview')) {
        let hidden = false, p = f;
        while (p && p !== document.body) {
          const s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility === 'hidden') { hidden = true; break; }
          p = p.parentElement;
        }
        const r = f.getBoundingClientRect();
        // A webview the sidebar collapsed is on screen but zero-sized; it cannot be typed into either.
        out.push({ name: f.getAttribute('name') || '', visible: !hidden && r.width > 20 && r.height > 20 });
      }
      return out;
    })()`);
    return new Map((list || []).map(x => [x.name, x.visible]));
  } catch {
    return null;
  }
}

// The webview iframes that host a Claude Code panel, in the order Cursor lists them.
async function claudeWebviews() {
  const targets = await cdpTargets();
  return targets.filter(t => t.type === 'iframe' && /vscode-webview/.test(t.url || '')
    && /extensionId=Anthropic\.claude-code/.test(t.url || '') && t.webSocketDebuggerUrl);
}

// The Claude Code panel that is on screen in this window, or null when none is. Only a panel of this
// window counts: every Cursor window has its own webviews, and Cursor lists them all together. Only the
// visible panel is a valid place to type — the hidden ones belong to other tabs, and typing there
// reaches a conversation nobody is looking at.
async function panelSession(pageClient) {
  const visible = await visibleWebviewNames(pageClient);
  if (!visible) return null;
  const webviews = await claudeWebviews();
  for (const w of webviews) {
    const wid = new URL(w.url).searchParams.get('id') || '';
    if (!visible.get(wid)) continue;
    try {
      const sub = await connect(w.webSocketDebuggerUrl);
      const has = await sub.evaluate(`(() => {
        const f = document.getElementById('active-frame');
        if (!f) return false;
        const d = f.contentDocument;
        return Boolean(d && d.querySelector('.inputContainer_07S1Yg, .messageInput_cKsPxg'));
      })()`).catch(() => false);
      if (has) return sub;
      sub.close();
    } catch {}
  }
  return null;
}

// Every step of preparing the composer, in one expression, so a slow frame cannot be caught halfway.
const PREPARE = `(() => {
  const frame = document.getElementById('active-frame');
  if (!frame) return { ok: false, why: 'no-frame' };
  const d = frame.contentDocument;
  if (!d) return { ok: false, why: 'no-doc' };
  const clear = () => {
    const btn = [...d.querySelectorAll('button')].find(b => (b.innerText || '').includes('Open here anyway'));
    if (btn) { btn.click(); return true; }
    return false;
  };
  const clicked = clear();
  const box = d.querySelector('.inputContainer_07S1Yg');
  if (!box) return { ok: false, why: 'no-composer', clicked };
  const ed = d.querySelector('.messageInput_cKsPxg');
  if (!ed) return { ok: false, why: 'no-editor', clicked };
  const r = ed.getBoundingClientRect();
  const dead = String(box.className || '').includes('hostUnresponsive');
  return {
    ok: !dead && r.width > 10 && r.height > 5,
    clicked,
    dead,
    editable: ed.getAttribute('contenteditable'),
    rect: [r.x, r.y, r.width, r.height],
    text: (ed.innerText || '').slice(0, 200),
  };
})()`;

// The send button turns into a Stop button while a turn runs, so the same element answers both questions.
const STATE = `(() => {
  const d = document.getElementById('active-frame')?.contentDocument;
  if (!d) return null;
  const send = d.querySelector('[aria-label="Send message"]');
  const stop = d.querySelector('[aria-label="Stop"]');
  const ed = d.querySelector('.messageInput_cKsPxg');
  return {
    busy: Boolean(stop),
    canSend: Boolean(send) && !send.disabled,
    text: ed ? (ed.innerText || '').slice(0, 400) : '',
  };
})()`;

// Brings the composer to a usable state, clearing the "open somewhere else" gate if Cursor raised it.
async function prepare(client) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await client.evaluate(PREPARE);
    if (last?.ok) return last;
    if (last?.clicked) await new Promise(r => setTimeout(r, 1200)); // the gate closes and the panel re-renders
    else await new Promise(r => setTimeout(r, 300));
  }
  // Cursor shows "still open somewhere else" when the same session runs twice (usually a terminal and
  // this panel). It blocks typing until one of them lets go, so say what to close rather than just fail.
  if (last?.dead) throw new Error('同一个会话正开着两份（比如终端里还有一份）。先把终端里那个关掉，再在这里发');
  if (last?.why === 'no-frame' || last?.why === 'no-doc') throw new Error('这个窗口里没有找到 Claude Code 面板，先在 Cursor 里打开它');
  throw new Error('没有找到输入框，Cursor 版本可能不一样');
}

// Focuses the composer and puts the text in it the way a paste would, leaving the caret at the end.
async function typeInto(client, rect, text) {
  const cx = rect[0] + rect[2] / 2;
  const cy = rect[1] + rect[3] / 2;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 120));
  // Clear whatever the person had half-typed on the computer, then insert the phone's text.
  const sel = await client.evaluate(`(() => {
    const d = document.getElementById('active-frame').contentDocument;
    const ed = d.querySelector('.messageInput_cKsPxg');
    if (!ed) return null;
    const range = d.createRange();
    range.selectNodeContents(ed);
    const s = d.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    return ed.innerText || '';
  })()`);
  if (sel) {
    for (const type of ['keyDown', 'keyUp']) {
      await client.send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
    }
  }
  await client.send('Input.insertText', { text });
  await new Promise(r => setTimeout(r, 200));
}

// Enter sends. Shift+Enter would add a line, so shift stays off.
async function pressEnter(client) {
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
    });
  }
}

// Asks Cursor to open a conversation in its Claude panel. The extension registers this URI itself, so it
// lands in the window that owns the conversation rather than a new one.
function requestSession(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return Promise.resolve(false);
  return new Promise(resolve => {
    const bin = process.platform === 'darwin'
      ? '/Applications/Cursor.app/Contents/Resources/app/bin/cursor'
      : 'cursor';
    const url = `cursor://Anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
    const child = spawn(bin, ['--open-url', url], { detached: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.unref();
    setTimeout(() => resolve(true), 300);
  });
}

// What the visible panel is showing, and whether it is showing the conversation the phone asked for.
// The panel's own transcript path is not in the DOM, so the check is against what it renders: the newest
// messages of the target conversation must be there. Matching on the folder is not enough, because one
// Cursor window can show a conversation from any project.
async function showingConversation(target, expectText) {
  if (!expectText) return true;
  try {
    const body = await target.evaluate(`(() => {
      const d = document.getElementById('active-frame')?.contentDocument;
      return d ? (d.body.innerText || '') : '';
    })()`);
    if (!body) return false;
    // The phone sends the last few things that were said; the panel must be showing them.
    const want = String(expectText).replace(/\s+/g, ' ').trim().slice(0, 80);
    return body.replace(/\s+/g, ' ').includes(want);
  } catch {
    return false;
  }
}

// Sends one message to the panel in that window, as the person would have typed it.
// `expect` is what the conversation should already show (its last message); when the visible panel is
// showing something else, the send is refused rather than dropped into the wrong conversation.
export async function sendToComposer(folder, text, { submit = true, expect = '', sessionId = '' } = {}) {
  const page = await pageFor(folder);
  if (!page) throw new Error('没有找到这个 Cursor 窗口');
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    let panel = await panelSession(client);
    // The panel's own frame is a separate target; the page cannot reach its document, so both are used.
    if (!panel) throw new Error('这个窗口里没有正在显示 Claude Code 面板。先在 Cursor 里打开要发的那个会话');
    let target = panel;
    if (!(await showingConversation(target, expect))) {
      // The window has the right folder but another conversation on screen. Ask Cursor to bring the
      // wanted one forward, then look again; only if it still is not there does the send stop.
      panel.close();
      if (!sessionId) {
        throw new Error('Cursor 的面板现在显示的不是这个会话，没有发送。先在电脑上把这个会话切到前面');
      }
      await requestSession(sessionId);
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 500));
        const again = await panelSession(client);
        if (again && await showingConversation(again, expect)) { target = again; break; }
        again?.close();
      }
      if (target === panel) {
        throw new Error('没有把 Cursor 切到这个会话，消息没有发送。可以稍后再试，或先在电脑上点一下这个会话');
      }
    }
    const prep = await prepare(target);
    if (!submit) {
      await typeInto(target, prep.rect, text);
      return { typed: true, sent: false };
    }
    await typeInto(target, prep.rect, text);
    const typed = await target.evaluate(STATE);
    if (!typed?.canSend) throw new Error('输入框没有接受这段文字');
    await pressEnter(target);
    // A sent turn clears the box within a moment; if it is still full, Enter did not take.
    let state = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 250));
      state = await target.evaluate(STATE);
      if (!state?.text) break;
    }
    if (state?.text) throw new Error('消息没有发出去，输入框里还有内容');
    return { typed: true, sent: true, busy: Boolean(state?.busy) };
  } finally {
    client.close();
  }
}

// Stops the turn that is running in that window. The send button becomes Stop while a turn runs, and
// pressing it aborts the turn the way Esc does.
export async function stopTurn(folder) {
  const page = await pageFor(folder);
  if (!page) throw new Error('没有找到这个 Cursor 窗口');
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    const panel = await panelSession(client);
    const target = panel || client;
    const before = await target.evaluate(STATE).catch(() => null);
    if (!before?.busy) return { stopped: false, why: '没有正在运行的一轮' };
    const rect = await target.evaluate(`(() => {
      const d = document.getElementById('active-frame')?.contentDocument;
      const b = d?.querySelector('[aria-label="Stop"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    if (!rect) throw new Error('找不到停止按钮');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await client.send('Input.dispatchMouseEvent', { type, x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
    }
    // The button returns to Send once the turn is really over.
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 250));
      const now = await target.evaluate(STATE).catch(() => null);
      if (now && !now.busy) return { stopped: true };
    }
    return { stopped: true, slow: true };
  } finally {
    client.close();
  }
}

// What the panel currently shows: whether a turn is running and what is in the box. Used by the relay to
// report state after a phone action, and to tell the 新增 flow that a fresh conversation is ready.
export async function composerState(folder) {
  const page = await pageFor(folder);
  if (!page) return null;
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    const panel = await panelSession(client);
    return await (panel || client).evaluate(STATE).catch(() => null);
  } finally {
    client.close();
  }
}

// A question the Agent is waiting on. The panel renders AskUserQuestion as a list of role="radio"
// options; while it waits, the composer is taken over, so the phone has to answer here.
const PENDING = `(() => {
  const d = document.getElementById('active-frame')?.contentDocument;
  if (!d) return null;
  const H = d.documentElement.clientHeight;
  const inView = el => { const r = el.getBoundingClientRect(); return r.width > 10 && r.y > -5 && r.y < H; };
  const opts = [...d.querySelectorAll('[role="radio"], [role="checkbox"]')].filter(inView);
  if (!opts.length) return null;
  const groups = [...d.querySelectorAll('.optionsContainer_hONcXw')].filter(inView);
  const questionText = (groups[0]?.parentElement?.innerText || '').split('\\n')[0].slice(0, 300);
  return {
    text: questionText,
    options: opts.map((el, i) => ({
      i,
      label: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      selected: el.getAttribute('aria-checked') === 'true' || /selected|checked/i.test(String(el.className)),
      multi: el.getAttribute('role') === 'checkbox',
    })),
    // The submit control the panel shows under a question list.
    canSubmit: [...d.querySelectorAll('button')].some(b => inView(b) && /^(Submit|提交)/i.test((b.innerText || '').trim())),
  };
})()`;

// The question the Agent is waiting on, or null when it is not asking anything.
export async function pendingQuestion(folder) {
  const page = await pageFor(folder);
  if (!page) return null;
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    const panel = await panelSession(client);
    return await (panel || client).evaluate(PENDING).catch(() => null);
  } finally {
    client.close();
  }
}

// Answers by clicking the option the phone picked, and the submit button when the panel shows one.
// Answers are given by index because the option text is what the panel already shows on the phone.
export async function answerQuestion(folder, { option = -1, submit = true } = {}) {
  const page = await pageFor(folder);
  if (!page) throw new Error('没有找到这个 Cursor 窗口');
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    const panel = await panelSession(client);
    const target = panel || client;
    if (option >= 0) {
      const point = await target.evaluate(`(() => {
        const d = document.getElementById('active-frame').contentDocument;
        const H = d.documentElement.clientHeight;
        const opts = [...d.querySelectorAll('[role="radio"], [role="checkbox"]')].filter(el => {
          const r = el.getBoundingClientRect(); return r.width > 10 && r.y > -5 && r.y < H;
        });
        const el = opts[${option}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.x + Math.min(24, r.width / 2), r.y + r.height / 2];
      })()`);
      if (!point) throw new Error('这个选项在电脑上已经找不到了');
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', { type, x: point[0], y: point[1], button: 'left', clickCount: 1 });
      }
      await new Promise(r => setTimeout(r, 300));
    }
    if (submit) {
      const point = await target.evaluate(`(() => {
        const d = document.getElementById('active-frame').contentDocument;
        const H = d.documentElement.clientHeight;
        const b = [...d.querySelectorAll('button')].find(el => {
          const r = el.getBoundingClientRect();
          return r.width > 10 && r.y > -5 && r.y < H && /^(Submit|提交)/i.test((el.innerText || '').trim());
        });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      })()`);
      if (point) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await client.send('Input.dispatchMouseEvent', { type, x: point[0], y: point[1], button: 'left', clickCount: 1 });
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
    return { ok: true };
  } finally {
    client.close();
  }
}
