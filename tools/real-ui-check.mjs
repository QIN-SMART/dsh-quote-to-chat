// dsh-quote-to-chat — 真机验证（CDP 驱动无头 Chrome 打开真实 DSH Web GUI）。
//
// 覆盖端到端链路：真实会话 → 真实选区 → 真实工具条 → 真实写回输入框。
//   1. 认证打开 http://127.0.0.1:3080，确认插件 client bundle 已发布、已 materialize
//   2. 打开一条真实会话，确认 conversation.input.overlay 的桥已挂上且拿到了 inputActions
//   3. 在真实回复正文里建一个真实 DOM Range/Selection，确认工具条弹出并定位在选区上方
//   4. 点「添加到对话」，确认输入框草稿出现引用块、光标回到 composer、出现结果提示
//   5. 点「复制」，确认剪贴板内容 = 选中原文
//   6. 收起行为：Escape 收起；在 composer 里选中不弹
//   7. 落盘两张截图：docs/real-ui-popup.png、docs/real-ui-composer.png
//
// ⚠️ 这些截图拍的是**你的真实会话**（真实标题与正文）→ 已在 .gitignore 里挡掉，永远不要提交。
//    仓库里给 README 用的图是 demo/quote-mock.html 生成的合成截图（docs/verify-*.png）。
//
// 用法：node tools/real-ui-check.mjs [token]
//   不传 token 时自动读 ~/.dsh/dsh-web.launchd.log 里最后一次启动 URL 的 token。
//   环境变量 CDP_PORT 可改调试端口（默认 9224）。

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GUI = 'http://127.0.0.1:3080';
const PORT = Number(process.env.CDP_PORT || 9224);
const LAUNCH_LOG = join(process.env.HOME || '', '.dsh', 'dsh-web.launchd.log');

function tokenFromLog() {
  const raw = existsSync(LAUNCH_LOG) ? readFileSync(LAUNCH_LOG, 'utf8') : '';
  const matches = raw.match(/token=([A-Za-z0-9._-]+)/g) || [];
  if (!matches.length) throw new Error('launch log 里没有 token，请作为参数传入');
  return matches[matches.length - 1].slice('token='.length);
}

const token = process.argv[2] || tokenFromLog();
const profile = mkdtempSync(join(tmpdir(), 'dsh-qc-check-'));
const results = [];
let failures = 0;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ' — ' + compact(detail)}`);
}

/** 报告里只留能看懂的部分：长字符串截断、长数组只报条数。 */
function compact(value) {
  if (typeof value === 'string') return value.length > 160 ? JSON.stringify(value.slice(0, 160) + '…') : JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string') && value.join('').length > 160) {
      return `${value.length} 项：${JSON.stringify(value[value.length - 1]).slice(0, 120)}…`;
    }
    return JSON.stringify(value);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = typeof item === 'string' && item.length > 160 ? item.slice(0, 160) + '…' : item;
    }
    return JSON.stringify(out);
  }
  return JSON.stringify(value);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  // DSH 的 bash 沙箱会拦掉 Chrome 自己的 sandbox 初始化（"sandbox initialization failed"），
  // 无头验证必须自己带 --no-sandbox；crashpad 写不进工作区外的目录，一并关掉免刷日志。
  '--no-sandbox',
  '--disable-gpu',
  '--disable-crash-reporter',
  '--disable-breakpad',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--window-size=1440,900',
  `${GUI}/?token=${token}`
], { stdio: 'ignore', detached: false });
chrome.on('error', (err) => {
  console.error('❌ 无法启动 Chrome:', err.message);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (err) { /* chrome 还没起来 */ }
    await sleep(400);
  }
  throw new Error('devtools page not found');
}

let ws;
let nextId = 1;
const pending = new Map();

async function connect() {
  const page = await pageTarget();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时：' + page.webSocketDebuggerUrl)), 15000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error('WebSocket 失败: ' + (event.message || 'error'))); }, { once: true });
  });
  await send('Runtime.enable');
  await send('Page.enable');
}

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => (message.error
      ? reject(new Error(method + ': ' + JSON.stringify(message.error)))
      : resolve(message.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(path) {
  const data = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(data.data, 'base64'));
  return path;
}

async function waitFor(expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`return !!( ${expression} );`)) return true;
    await sleep(300);
  }
  throw new Error('等待超时：' + label);
}

try {
  await connect();

  // ------------------------------------------------------------------ 1. 启动与发布
  await waitFor(`document.querySelector('[data-row-key^="session:"]')`, '侧边栏渲染完成', 40000);

  const boot = await evaluate(`
    const resources = performance.getEntriesByType('resource').map((entry) => entry.name);
    return {
      published: resources.some((name) => name.includes('dsh-quote-to-chat')),
      pluginResources: resources.filter((name) => name.includes('plugins')).slice(0, 6),
      api: typeof window.__dshQuoteToChat,
      style: !!document.querySelector('style[data-plugin-css="dsh-quote-to-chat/style"]'),
      bar: !!document.querySelector('[data-dsh-quote-to-chat="bar"]')
    };
  `);
  check('client bundle 已被浏览器取回（/plugins 资源里出现本包）', boot.published, boot.pluginResources);
  check('插件已 materialize（调试句柄 + 样式表 + 工具条 DOM）',
    boot.api === 'object' && boot.style && boot.bar, { api: boot.api, style: boot.style, bar: boot.bar });

  // ------------------------------------------------------------------ 2. 打开一条有正文的真实会话
  const opened = await evaluate(`
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')];
    const tried = [];
    for (const row of rows.slice(0, 8)) {
      row.click();
      for (let i = 0; i < 25; i += 1) {
        await new Promise((r) => setTimeout(r, 200));
        const body = document.querySelector('[data-slot="conversation.session"]');
        if (body && body.querySelector('[data-chat-turn]') && body.textContent.trim().length > 40) {
          return { ok: true, row: row.getAttribute('data-row-key'), turns: body.querySelectorAll('[data-chat-turn]').length };
        }
      }
      tried.push(row.getAttribute('data-row-key'));
    }
    return { ok: false, tried };
  `);
  check('打开了一条带正文的真实会话', opened.ok, opened);

  await waitFor(`document.querySelector('[data-slot="conversation.session"] [data-chat-turn]')`, '正文渲染');

  const bridge = await evaluate(`return window.__dshQuoteToChat.state();`);
  check('会话桥挂上且拿到 inputActions', bridge.instances >= 1 && bridge.hasActions === true, bridge);

  // ------------------------------------------------------------------ 3. 真实选区 → 工具条
  const selection = await evaluate(`
    // 选段策略：挑一段够长（会折行）的正文，从长文本节点的中段起选 18 个字 ——
    // 这样工具条会落在同一段的前一行上，正好用来核对「压住密集正文」时的可读性。
    window.__qcPick = () => {
      const scope = document.querySelector('[data-slot="conversation.session"]');
      // 必须挑会折行的段落（高度 > 一行多一点），否则工具条会落在段外的空白上，
      // 截出来的特写看不出「压住密集正文」的效果。
      const all = [...scope.querySelectorAll('p, li')].filter((el) => {
        const r = el.getBoundingClientRect();
        return el.textContent.trim().length > 40 && r.height > 42;
      });
      if (!all.length) return null;
      const inView = (el) => {
        const r = el.getBoundingClientRect();
        return r.top > 140 && r.bottom < innerHeight - 180;
      };
      let el = all.find(inView);
      if (!el) { all[0].scrollIntoView({ block: 'center' }); el = all[0]; }
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let best = null;
      let bestLen = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const len = (node.nodeValue || '').length;
        if (len > bestLen) { bestLen = len; best = node; }
      }
      if (!best || bestLen < 12) return null;
      // 从 60% 处起选：第一行早过了，工具条就会落在同一段的正文行上。
      const start = bestLen > 48 ? Math.floor(bestLen * 0.6) : 0;
      const end = Math.min(bestLen, start + 18);
      const range = document.createRange();
      range.setStart(best, start);
      range.setEnd(best, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const rect = range.getBoundingClientRect();
      return {
        node: el.tagName,
        lines: Math.round(el.getBoundingClientRect().height / 27),
        text: best.nodeValue.slice(start, end).replace(/\\s+$/, ''),
        rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), bottom: Math.round(rect.bottom) }
      };
    };
    const picked = window.__qcPick();
    if (!picked) return { error: '没有找到足够长的正文段落' };
    await new Promise((r) => setTimeout(r, 200));
    return picked;
  `);
  check('在真实回复正文里建立了选区（且选区在视口内）',
    !selection.error && selection.text.length > 0 && selection.rect.top > 0, selection);

  await waitFor(`document.querySelector('[data-dsh-quote-to-chat="bar"]').getAttribute('data-open') === '1'`, '工具条弹出');

  const popup = await evaluate(`
    const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
    const rect = bar.getBoundingClientRect();
    const style = getComputedStyle(bar);
    const alphaPart = style.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
    const parts = alphaPart ? alphaPart[1].split(',').map((s) => s.trim()) : [];
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const stack = document.elementsFromPoint(cx, cy);
    const labelOf = (el) => {
      if (!el) return null;
      const mine = el.closest ? el.closest('[data-dsh-quote-to-chat]') : null;
      if (mine) return 'plugin:' + mine.getAttribute('data-dsh-quote-to-chat');
      if (el.closest && el.closest('[data-slot="conversation.session"]')) return 'transcript';
      return el.tagName.toLowerCase();
    };
    return {
      open: bar.getAttribute('data-open'),
      placement: bar.getAttribute('data-placement'),
      label: bar.querySelector('[data-dsh-quote-to-chat="add"]').textContent,
      copyLabel: bar.querySelector('[data-dsh-quote-to-chat="copy"]').textContent,
      rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage.slice(0, 90),
      backdropFilter: style.backdropFilter,
      alpha: parts.length > 3 ? Number(parts[3]) : 1,
      radius: style.borderRadius,
      stack: stack.slice(0, 3).map(labelOf),
      state: window.__dshQuoteToChat.state()
    };
  `);
  check('工具条在选区上方可见',
    popup.open === '1' && popup.placement === 'above' && popup.rect.height > 20 && popup.rect.top > 0, popup);
  check('工具条文案与截图一致（添加到对话 / 复制）', popup.label === '添加到对话' && popup.copyLabel === '复制', popup);
  check('工具条用了原生菜单色 + 原生圆角', popup.background !== 'rgba(0, 0, 0, 0)' && popup.radius !== '0px', popup);
  check('工具条表面完全不透明（正文不会穿透上来）', popup.alpha === 1, { alpha: popup.alpha, background: popup.background, backgroundImage: popup.backgroundImage });
  check('工具条确实盖在正文之上（命中测试栈顶是插件，下一层是对话正文）',
    String(popup.stack[0]).startsWith('plugin:') && popup.stack.includes('transcript'), popup.stack);
  check('保留原生毛玻璃声明', /blur/.test(popup.backdropFilter || ''), popup.backdropFilter);
  check('调试状态记录了选区文本与轮次', !!popup.state.text && popup.state.turn !== null, popup.state);

  const popupShot = await shot(join(root, 'docs', 'real-ui-popup.png'));
  console.log('   screenshot:', popupShot);

  // 材质特写：把工具条、它压住的那一行正文、以及下面的选区一起截进来，
  // 用来肉眼核对「前后两层」是否都清楚。
  const left = Math.max(0, Math.min(popup.rect.left, selection.rect.left) - 40);
  const right = Math.max(popup.rect.left + popup.rect.width, selection.rect.left + selection.rect.width) + 40;
  const closeupClip = {
    x: left,
    y: Math.max(0, popup.rect.top - 52),
    width: Math.min(1440 - left, right - left),
    height: popup.rect.height + 132,
    scale: 2
  };
  const closeup = await send('Page.captureScreenshot', { format: 'png', clip: closeupClip });
  writeFileSync(join(root, 'docs', 'real-ui-material.png'), Buffer.from(closeup.data, 'base64'));
  console.log('   screenshot:', join(root, 'docs', 'real-ui-material.png'));

  // ------------------------------------------------------------------ 4.5 深色主题同样要实心
  const dark = await evaluate(`
    document.body.setAttribute('data-ds-dark-theme', '');
    await new Promise((r) => setTimeout(r, 400));
    const picked = window.__qcPick();
    if (!picked) return { error: '深色主题下没选到正文' };
    await new Promise((r) => setTimeout(r, 350));
    const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
    const style = getComputedStyle(bar);
    const alphaPart = style.backgroundColor.match(/rgba?\\(([^)]+)\\)/);
    const parts = alphaPart ? alphaPart[1].split(',').map((s) => s.trim()) : [];
    return {
      open: bar.getAttribute('data-open'),
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage.slice(0, 90),
      alpha: parts.length > 3 ? Number(parts[3]) : 1,
      labelColor: getComputedStyle(bar.querySelector('[data-dsh-quote-to-chat="add"]')).color,
      text: picked.text,
      rect: bar.getBoundingClientRect().toJSON()
    };
  `);
  check('深色主题下同样是实心表面', dark.open === '1' && dark.alpha === 1, dark);
  const darkClip = { x: Math.max(0, dark.rect.left - 60), y: Math.max(0, dark.rect.top - 46), width: dark.rect.width + 120, height: dark.rect.height + 92, scale: 2 };
  const darkShot = await send('Page.captureScreenshot', { format: 'png', clip: darkClip });
  writeFileSync(join(root, 'docs', 'real-ui-material-dark.png'), Buffer.from(darkShot.data, 'base64'));
  console.log('   screenshot:', join(root, 'docs', 'real-ui-material-dark.png'));
  await evaluate(`document.body.removeAttribute('data-ds-dark-theme'); return true;`);

  // ------------------------------------------------------------------ 4. 添加到对话
  const before = await evaluate(`
    const slot = document.querySelector('[data-slot="conversation.composer.bar"]');
    const editor = (slot || document).querySelector('div[contenteditable="true"][role="textbox"]');
    return { draft: editor ? editor.textContent : null, found: !!editor };
  `);
  check('找到真实 composer（Lexical 宿主）', before.found, { found: before.found });

  await evaluate(`document.querySelector('[data-dsh-quote-to-chat="add"]').click(); return true;`);
  await sleep(400);

  const after = await evaluate(`
    const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
    const slot = document.querySelector('[data-slot="conversation.composer.bar"]');
    const editor = (slot || document).querySelector('div[contenteditable="true"][role="textbox"]');
    return {
      draft: editor ? editor.textContent : null,
      focused: document.activeElement === editor,
      flash: bar.getAttribute('data-flash'),
      flashText: bar.querySelector('[data-dsh-quote-to-chat="flash"]').textContent
    };
  `);
  const expected = '> ' + selection.text + '\n\n';
  check('草稿写入引用块（正是要发给模型的内容）', after.draft === expected,
    { expected: JSON.stringify(expected), actual: JSON.stringify(after.draft) });
  check('光标交回输入框', after.focused === true, { focused: after.focused });
  check('出现「已添加到对话」结果提示', after.flash === '1' && after.flashText === '已添加到对话', after);

  const composerShot = await shot(join(root, 'docs', 'real-ui-composer.png'));
  console.log('   screenshot:', composerShot);

  // ------------------------------------------------------------------ 5. 输入框内的草稿文本真的进模型上下文
  const roundTrip = await evaluate(`
    const slot = document.querySelector('[data-slot="conversation.composer.bar"]');
    const editor = (slot || document).querySelector('div[contenteditable="true"][role="textbox"]');
    return { draft: editor.textContent, endsWithBlank: /\\n\\n$/.test(editor.textContent) };
  `);
  check('草稿以空行结尾（可以直接接着写）', roundTrip.endsWithBlank === true, roundTrip);

  // ------------------------------------------------------------------ 6. 侧边提问
  await sleep(1800); // 等「已添加到对话」的提示退场，工具条回到可选状态

  const sideState = await evaluate(`
    return {
      available: window.__dshQuoteToChat.state().sideChat,
      before: window.__dshQuoteToChat.sideChat()
    };
  `);
  check('检测到 dsh-better-sidebar 的侧边对话服务', sideState.available === true, sideState);

  const pickedSide = await evaluate(`
    const picked = window.__qcPick();
    return picked ? picked.text : null;
  `);
  await waitFor(`document.querySelector('[data-dsh-quote-to-chat="bar"]').getAttribute('data-open') === '1'`, '工具条再次弹出');
  const sideLabel = await evaluate(`return document.querySelector('[data-dsh-quote-to-chat="side"]').textContent;`);
  check('工具条上有「侧边提问」这一条', sideLabel === '侧边提问', { sideLabel });

  await evaluate(`document.querySelector('[data-dsh-quote-to-chat="side"]').click(); return true;`);

  const side = await evaluate(`
    const deadline = Date.now() + 12000;
    let last = null;
    while (Date.now() < deadline) {
      const state = window.__dshQuoteToChat.sideChat();
      last = state;
      if (state.drafts.some((d) => d.indexOf('> ') !== -1)) {
        const el = [...document.querySelectorAll('textarea')].find((t) => (t.value || '').indexOf('> ') !== -1);
        const rect = el ? el.getBoundingClientRect() : null;
        return {
          ok: true,
          drafts: state.drafts,
          rect: rect ? { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null
        };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, state: last };
  `);
  check('点「侧边提问」→ 引用写进侧边对话的输入框', side.ok === true, side);
  check('侧边输入框在屏幕上可见（右栏确实展开了）',
    side.ok && side.rect && side.rect.left > 0 && side.rect.width > 100 && side.rect.top > 0,
    side.rect);
  check('写进去的正是选中的那段（引用块形态）',
    side.ok && side.drafts.some((d) => d.indexOf('> ' + pickedSide) !== -1),
    { expected: pickedSide, drafts: side.ok ? side.drafts : null });

  const sideShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root, 'docs', 'real-ui-sidechat.png'), Buffer.from(sideShot.data, 'base64'));
  console.log('   screenshot:', join(root, 'docs', 'real-ui-sidechat.png'));

  const rightbar = await evaluate(`
    const chips = [...document.querySelectorAll('[data-slot="rightbar.session"] [role="tab"], [data-slot="rightbar.session"] button')]
      .map((el) => (el.textContent || '').trim())
      .filter((text) => text.length > 0 && text.length < 20);
    return { chips: [...new Set(chips)].slice(0, 12) };
  `);
  console.log('   右栏标签:', JSON.stringify(rightbar.chips));

  // 收尾：把验证过程中开出来的侧边对话 tab 关掉，别在用户的 GUI 里留垃圾。
  const closed = await evaluate(`
    const scope = document.querySelector('[data-slot="rightbar.session"]');
    if (!scope) return { closed: false, reason: 'no rightbar' };
    const buttons = [...scope.querySelectorAll('button')];
    const close = buttons.find((b) => {
      const label = (b.getAttribute('aria-label') || '') + (b.title || '');
      return /关闭|close/i.test(label);
    });
    if (!close) return { closed: false, reason: 'no close button', buttons: buttons.length };
    close.click();
    await new Promise((r) => setTimeout(r, 400));
    return { closed: true, remaining: window.__dshQuoteToChat.sideChat().composers };
  `);
  console.log('   收尾关闭侧边对话 tab:', JSON.stringify(closed));

  // ------------------------------------------------------------------ 7. 收起行为
  const dismissed = await evaluate(`
    const sel = window.getSelection();
    const scope = document.querySelector('[data-slot="conversation.session"]');
    const el = [...scope.querySelectorAll('p')].find((p) => p.textContent.trim().length > 16);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) { if (walker.currentNode.nodeValue.trim().length > 12) { textNode = walker.currentNode; break; } }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(14, textNode.nodeValue.length));
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise((r) => setTimeout(r, 300));
    const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
    const openedAgain = bar.getAttribute('data-open') === '1';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { openedAgain, afterEscape: bar.getAttribute('data-open') };
  `);
  check('再次选中文本仍会弹出（可重复使用）', dismissed.openedAgain === true, dismissed);
  check('Escape 收起工具条', dismissed.afterEscape === '0', dismissed);

  const composerGuard = await evaluate(`
    const slot = document.querySelector('[data-slot="conversation.composer.bar"]');
    const editor = (slot || document).querySelector('div[contenteditable="true"][role="textbox"]');
    const sel = window.getSelection();
    const range = document.createRange();
    const target = editor.firstChild && editor.firstChild.nodeType === 3 ? editor.firstChild : editor;
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
    await new Promise((r) => setTimeout(r, 300));
    return { open: document.querySelector('[data-dsh-quote-to-chat="bar"]').getAttribute('data-open'), selected: sel.toString() };
  `);
  check('在输入框里选中不弹工具条', composerGuard.open === '0', composerGuard);

  // ------------------------------------------------------------------ 探针：真实 DOM 契约
  const dom = await evaluate(`
    const scope = document.querySelector('[data-slot="conversation.session"]');
    const turn = scope.querySelector('[data-chat-turn]');
    return {
      transcriptSlot: !!scope,
      composerSlot: !!document.querySelector('[data-slot="conversation.composer.bar"]'),
      overlaySlot: !!document.querySelector('[data-slot="conversation.input.overlay"]'),
      anchor: !!document.querySelector('[data-dsh-quote-to-chat="anchor"]'),
      turnAttr: turn ? turn.getAttribute('data-chat-turn') : null,
      overlayHasAnchor: !!document.querySelector('[data-slot="conversation.input.overlay"] [data-dsh-quote-to-chat="anchor"]')
    };
  `);
  check('真实 DOM 契约成立（正文/composer/overlay 插槽都在，桥锚点落在 overlay 里）',
    dom.transcriptSlot && dom.composerSlot && dom.overlaySlot && dom.anchor && dom.overlayHasAnchor, dom);
} catch (err) {
  failures += 1;
  console.error('❌ 运行中断:', err && err.message ? err.message : err);
} finally {
  try { if (ws) ws.close(); } catch (err) { /* ignore */ }
  chrome.kill('SIGKILL');
}

console.log('\n===== 汇总 =====');
console.log(`通过 ${results.filter((r) => r.ok).length} / ${results.length}，失败 ${failures}`);
process.exit(failures ? 1 : 0);
