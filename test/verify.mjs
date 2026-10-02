// dsh-quote-to-chat — 自测。
//
// 在 mock 出来的最小 DOM 上加载**真实的** lib/client.js（走真实的
// `window.__ModuleLoader__.load` 注册路径），覆盖：
//   · 模块形状（id 必须等于包名、平铺导出 apply/inject、import 期间零副作用）
//   · apply() 的世界可见副作用（样式表打标、工具条 DOM、调试句柄、唯一的会话桥插槽）
//   · 文本还原与引用格式化：块级换行、blockquote / fenced / plain、来源行、尾随空行
//   · 定位：上方优先、贴顶落下方、横向居中并夹进视口
//   · 显示判定：折叠选区 / 太短 / composer 内 / 工具条自身 / 对话正文之外 一律不弹
//   · 会话归属：多会话并存时按最近的共同容器选中正确输入框；无法唯一确定时拒绝而不是写错
//   · 动作：添加到对话（captureInsertion + insertText 的真实参数）、忙碌时明确提示、
//           复制走剪贴板、Escape 与滚动收起、结果提示期间不被 selectionchange 打断
//   · dispose() 清干净（样式表、工具条、五类监听器、调试句柄）
//
// 运行：node --test test/verify.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', 'lib', 'client.js');
const SOURCE = readFileSync(BUNDLE, 'utf8');

// ---------------------------------------------------------------------------
// 最小 DOM
// ---------------------------------------------------------------------------

/** 跨 vm realm 比较用：把插件返回的值变成当前 realm 的普通值。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 只支持 `tag`、`.class`、`[attr]`、`[attr="v"]` 及其串联——本插件只用这几种选择器。 */
function matches(node, selector) {
  if (!node || typeof node.getAttribute !== 'function') return false;
  const trimmed = String(selector).trim();
  const cls = /^\.([a-z0-9_-]+)$/i.exec(trimmed);
  if (cls) return String(node.className || '').split(/\s+/).indexOf(cls[1]) !== -1;
  const m = /^([a-z]*)((?:\s*\[[a-z-]+(?:="[^"]*")?\])*)$/.exec(trimmed);
  if (!m || (!m[1] && !m[2])) return false;
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  const clauses = m[2].match(/\[[^\]]+\]/g) || [];
  return clauses.every((clause) => {
    const inner = clause.slice(1, -1);
    const eq = /^([a-z-]+)="([^"]*)"$/.exec(inner);
    if (eq) return node.getAttribute(eq[1]) === eq[2];
    return node.getAttribute(inner) !== null;
  });
}

function createTextNode(text) {
  return { nodeType: 3, nodeName: '#text', nodeValue: String(text), childNodes: [] };
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue || '';
  return node.childNodes.map(textOf).join('');
}

function createNode(doc, tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attributes: {},
    style: {},
    listeners: new Map(),
    parentNode: null,
    className: '',
    offsetWidth: 0,
    offsetHeight: 0,
    ownerDocument: doc,
    isContentEditable: false
  };
  node.nodeName = node.tagName;
  Object.defineProperty(node, 'isConnected', {
    get() {
      let cursor = node;
      while (cursor.parentNode) cursor = cursor.parentNode;
      return cursor === doc.documentElement;
    }
  });
  Object.defineProperty(node, 'textContent', {
    get() { return textOf(node); },
    set(value) {
      node.childNodes = [];
      const text = createTextNode(value);
      text.parentNode = node;
      node.childNodes.push(text);
    }
  });
  Object.defineProperty(node, 'dataset', {
    get() {
      return new Proxy({}, {
        get: (_, key) => node.getAttribute('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())),
        set: (_, key, value) => {
          node.setAttribute('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value);
          return true;
        }
      });
    }
  });
  node.appendChild = (child) => { node.childNodes.push(child); child.parentNode = node; return child; };
  node.remove = () => {
    if (!node.parentNode) return;
    const list = node.parentNode.childNodes;
    const index = list.indexOf(node);
    if (index >= 0) list.splice(index, 1);
    node.parentNode = null;
  };
  node.setAttribute = (key, value) => { node.attributes[key] = String(value); };
  node.getAttribute = (key) => (key in node.attributes ? node.attributes[key] : null);
  node.removeAttribute = (key) => { delete node.attributes[key]; };
  node.contains = (other) => {
    let cursor = other;
    while (cursor) {
      if (cursor === node) return true;
      cursor = cursor.parentNode;
    }
    return false;
  };
  node.closest = (selector) => {
    let cursor = node;
    while (cursor && cursor.nodeType === 1) {
      if (matches(cursor, selector)) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  };
  node.querySelectorAll = (selector) => descendants(node).filter((n) => matches(n, selector));
  node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
  node.focus = () => { doc.focusedEditor = node; };
  node.select = () => {};
  node.setSelectionRange = (start, end) => { node.__caret = [start, end]; };
  node.getBoundingClientRect = () => node.__rect || { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  node.dispatchEvent = (event) => { node.dispatch(event.type, event); return true; };
  node.addEventListener = (type, fn) => {
    if (!node.listeners.has(type)) node.listeners.set(type, []);
    node.listeners.get(type).push(fn);
  };
  node.removeEventListener = (type, fn) => {
    const list = node.listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  node.dispatch = (type, event = {}) => {
    (node.listeners.get(type) || []).slice().forEach((fn) => fn(event));
  };
  return node;
}

function descendants(root) {
  const out = [];
  const walk = (node) => node.childNodes.forEach((child) => { out.push(child); walk(child); });
  walk(root);
  return out;
}

function makeDocument() {
  const doc = {};
  const documentElement = createNode(doc, 'html');
  const head = createNode(doc, 'head');
  const body = createNode(doc, 'body');
  documentElement.appendChild(head);
  documentElement.appendChild(body);
  const listeners = new Map();
  doc.documentElement = documentElement;
  doc.head = head;
  doc.body = body;
  doc.createElement = (tag) => createNode(doc, tag);
  doc.createTextNode = createTextNode;
  doc.querySelectorAll = (selector) => descendants(documentElement).filter((n) => matches(n, selector));
  doc.querySelector = (selector) => doc.querySelectorAll(selector)[0] || null;
  doc.execCommand = () => true;
  doc.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  doc.removeEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  };
  doc.dispatch = (type, event = {}) => { (listeners.get(type) || []).slice().forEach((fn) => fn(event)); };
  doc.listenerCount = (type) => (listeners.get(type) || []).length;
  doc.focusedEditor = null;
  return doc;
}

function makeLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    _map: map
  };
}

/** 加载真实 bundle，返回 { plugin, window, document, storage, clip, ctx }。 */
function loadBundle(options = {}) {
  const document = makeDocument();
  const storage = makeLocalStorage(options.seed || {});
  const winListeners = new Map();
  const rafQueue = [];
  const clip = { written: [], writeText(text) { clip.written.push(text); return Promise.resolve(); } };
  const window = {
    document,
    localStorage: storage,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, event = {}) { (winListeners.get(type) || []).slice().forEach((fn) => fn(event)); },
    windowListenerCount(type) { return (winListeners.get(type) || []).length; },
    requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame(id) { rafQueue[id - 1] = null; },
    flushRaf() { rafQueue.splice(0).forEach((fn) => { if (fn) fn(0); }); },
    getSelection() { return window.__selection; },
    __selection: null
  };
  window.window = window;

  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    navigator: { platform: 'MacIntel', userAgent: 'node', clipboard: clip },
    Event: class MockEvent {
      constructor(type, options) {
        this.type = type;
        this.bubbles = !!(options && options.bubbles);
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const registrations = [];
  window.__ModuleLoader__ = { load(entry) { registrations.push(entry); } };
  vm.runInContext(SOURCE, sandbox, { filename: BUNDLE });

  assert.equal(registrations.length, 1, 'bundle 只应注册一个 ModuleLoader 条目');
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useRef: (init) => ({ current: init }),
    useEffect: () => {}
  };
  const requireStub = (name) => {
    if (name === 'react') return reactStub;
    throw new Error('unexpected require: ' + name);
  };
  const plugin = registrations[0].factory(requireStub);
  return { entry: registrations[0], plugin, window, document, storage, clip, reactStub, flushRaf: window.flushRaf };
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 造一个 DSH 形状的对话面板：正文插槽 + composer 卡片（含插槽锚点与 Lexical 宿主）。 */
function addConversation(document, opts = {}) {
  const root = document.createElement('div');
  root.setAttribute('data-slot', 'main.conversation');
  root.setAttribute('data-conversation-content', '');
  root.setAttribute('data-conversation-session', opts.sessionId || 'session-main-1');
  const transcript = document.createElement('div');
  transcript.setAttribute('data-slot', 'conversation.session');
  const turn = document.createElement('div');
  turn.setAttribute('data-chat-turn', String(opts.turn === undefined ? 3 : opts.turn));
  const paragraph = document.createElement('p');
  paragraph.textContent = opts.text || '所以，你们设备的 Apple ID 不同，和 ChatGPT 的登录状态也不一样。';
  turn.appendChild(paragraph);
  transcript.appendChild(turn);
  const composer = document.createElement('div');
  composer.setAttribute('data-slot', 'conversation.composer.bar');
  const anchor = document.createElement('span');
  anchor.setAttribute('data-dsh-quote-to-chat', 'anchor');
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('role', 'textbox');
  editor.isContentEditable = true;
  composer.appendChild(anchor);
  composer.appendChild(editor);
  root.appendChild(transcript);
  root.appendChild(composer);
  (opts.host || document.body).appendChild(root);
  return { root, transcript, turn, paragraph, composer, anchor, editor };
}

/** 造一段可被 readSelection 消费的选区。 */
function makeSelection(document, node, rectOver = {}) {
  const rect = Object.assign({ top: 200, left: 600, width: 100, height: 20 }, rectOver);
  const box = Object.assign({}, rect, { bottom: rect.top + rect.height });
  return {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => textOf(node),
    getRangeAt: () => ({
      startContainer: node,
      commonAncestorContainer: node,
      cloneContents: () => {
        const fragment = createTextNode('');
        fragment.nodeType = 11;
        fragment.nodeName = '#fragment';
        fragment.childNodes = [node];
        return fragment;
      },
      getClientRects: () => [Object.assign({}, box)],
      getBoundingClientRect: () => Object.assign({}, box)
    })
  };
}

function makeCollapsedSelection() {
  return { rangeCount: 1, isCollapsed: true, toString: () => '', getRangeAt: () => null };
}

/** apply() 用的 ctx 桩：记录插槽注册与 effect，并支持可选服务的 ctx.get。 */
function makeCtx(services = {}) {
  const registered = [];
  const injections = [];
  const effects = [];
  const ctx = {
    get(name) { return name in services ? services[name] : undefined; },
    slots: {
      inject(name, callback) {
        injections.push(name);
        const disposer = callback();
        return () => { if (typeof disposer === 'function') disposer(); };
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      }
    },
    effect(fn, label) {
      const cleanup = fn();
      effects.push({ label, cleanup });
      return () => { if (typeof cleanup === 'function') cleanup(); };
    }
  };
  return { ctx, registered, injections, effects };
}

/** dsh-better-sidebar 的客户端服务桩：只记 openTab。 */
function fakeSideService(onOpenTab) {
  const calls = { openTab: [] };
  return {
    calls,
    openTab(seed, scope) {
      calls.openTab.push({ seed, scope });
      if (typeof onOpenTab === 'function') onOpenTab(seed, scope);
    }
  };
}

/** 右栏容器 + 一个成尺寸的侧边对话输入框。 */
function addSideComposer(document, options = {}) {
  let rightbar = document.querySelector('[data-slot="rightbar.session"]');
  if (!rightbar) {
    rightbar = document.createElement('div');
    rightbar.setAttribute('data-slot', 'rightbar.session');
    document.body.appendChild(rightbar);
  }
  const el = document.createElement('textarea');
  el.value = options.value || '';
  el.__rect = { top: 200, left: 900, width: 240, height: 22, right: 1140, bottom: 222 };
  rightbar.appendChild(el);
  return el;
}

function fakeActions(over = {}) {
  const calls = { capture: 0, insert: [] };
  return {
    calls,
    captureInsertion() { calls.capture += 1; return { start: 0, end: 0, draftRev: 7 }; },
    insertText(text, span) {
      calls.insert.push({ text, span });
      return over.insertReturns === undefined ? true : over.insertReturns;
    },
    setDraft() {},
    addAttachments() { return true; },
    removeAttachment() {},
    pruneAttachments() {},
    submit() {}
  };
}

/** 在工具条上点某个动作（真实 DOM 里 click 冒泡到工具条，mock 里直接派发到条上）。 */
function clickBar(bundle, action) {
  const bar = bundle.document.querySelector('[data-dsh-quote-to-chat="bar"]');
  const button = bar.querySelector('[data-dsh-quote-to-chat="' + action + '"]');
  bar.dispatch('click', { target: button, preventDefault() {} });
  return bar;
}

function flashText(bundle) {
  const node = bundle.document.querySelector('[data-dsh-quote-to-chat="flash"]');
  return node ? node.textContent : null;
}

/** 装上插件、选中一段正文、把 inputActions 绑好；返回全部句柄。 */
function withSelection(options = {}) {
  const bundle = loadBundle(options);
  const { plugin, document, window, flushRaf } = bundle;
  const made = makeCtx(options.services || {});
  plugin.apply(made.ctx);
  const world = addConversation(document, options.world || {});
  const actions = fakeActions(options.actions || {});
  plugin.__internals.bindInstance(world.anchor, actions);
  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  return Object.assign({}, bundle, { world, actions, flushRaf, ctx: made.ctx, registered: made.registered });
}

// ---------------------------------------------------------------------------
// 用例：模块形状与装载
// ---------------------------------------------------------------------------

test('模块形状：id 等于包名、平铺导出 apply/inject、没有 default', () => {
  const { entry, plugin } = loadBundle();
  assert.equal(entry.id, 'dsh-quote-to-chat', 'ModuleLoader id 必须等于 package.json 的 name');
  assert.equal(typeof entry.factory, 'function');
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(plain(plugin.inject), ['slots']);
  assert.equal(plugin.default, undefined, '不能有 default 导出（loader 会用它替换整个命名空间）');
  assert.equal(typeof plugin.__internals, 'object');
});

test('import 期间零副作用：没注入样式、没建工具条、没装监听', () => {
  const { document, window, plugin } = loadBundle();
  assert.equal(document.querySelector('style[data-plugin-css="dsh-quote-to-chat/style"]'), null);
  assert.equal(document.querySelectorAll('[data-dsh-quote-to-chat]').length, 0);
  assert.equal(document.listenerCount('selectionchange'), 0);
  assert.equal(window.windowListenerCount('scroll'), 0);
  assert.equal(window.__dshQuoteToChat, undefined);
  assert.equal(typeof plugin.apply, 'function');
});

test('apply()：注入打标样式表、建工具条、暴露调试句柄、注册唯一的会话桥插槽', () => {
  const { plugin, document, window } = loadBundle();
  const { ctx, registered, injections, effects } = makeCtx();
  plugin.apply(ctx);

  const style = document.querySelector('style[data-plugin-css="dsh-quote-to-chat/style"]');
  assert.ok(style, '样式表必须自己打 data-plugin-css，否则可能被别的插件认领后删掉');
  assert.equal(style.dataset.plugin, 'dsh-quote-to-chat');
  assert.match(style.textContent, /--dsw-specific-menu/, '材质必须用原生菜单 token');
  assert.match(style.textContent, /--dsw-menu-backdrop-filter/);

  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
  assert.ok(bar, '工具条必须挂进 body');
  assert.equal(bar.parentNode, document.body);
  assert.equal(bar.getAttribute('data-open'), '0', '默认不可见');
  assert.equal(bar.getAttribute('role'), 'toolbar');
  assert.deepEqual(
    bar.querySelectorAll('[data-dsh-quote-to-chat]').map((n) => n.getAttribute('data-dsh-quote-to-chat')),
    ['add', 'sep-side', 'side', 'sep-copy', 'copy', 'flash']
  );
  assert.equal(bar.querySelector('[data-dsh-quote-to-chat="add"]').textContent, '添加到对话');
  assert.equal(bar.querySelector('[data-dsh-quote-to-chat="side"]').textContent, '侧边提问');
  assert.equal(bar.querySelector('[data-dsh-quote-to-chat="copy"]').textContent, '复制');

  assert.equal(window.__dshQuoteToChat.version, '0.2.0');
  assert.equal(typeof window.__dshQuoteToChat.setConfig, 'function');

  assert.deepEqual(injections, ['conversation.input.overlay']);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, 'conversation.input.overlay');
  assert.equal(registered[0].options.id, 'dsh-quote-to-chat:bridge');
  assert.equal(registered[0].component, plugin.__internals.OverlayBridge);
  assert.equal(effects.length, 1);

  assert.equal(document.listenerCount('selectionchange'), 1);
  assert.equal(document.listenerCount('mouseup'), 1);
  assert.equal(document.listenerCount('touchend'), 1);
  assert.equal(document.listenerCount('keydown'), 1);
  assert.equal(window.windowListenerCount('scroll'), 1);
  assert.equal(window.windowListenerCount('resize'), 1);
});

test('工具条材质：原生填充必须铺在一层不透明底色上（否则正文会穿透，前后两层都糊）', () => {
  const { plugin } = loadBundle();
  const css = plugin.__internals.CSS;
  assert.match(css, /background-color:var\(--dsw-alias-bg-layer-1/, '要先有一层不透明底');
  assert.match(css, /linear-gradient\(var\(--dsw-specific-menu/, '原生菜单填充作为面层');
  assert.match(css, /backdrop-filter:var\(--dsw-menu-backdrop-filter/, '保留原生毛玻璃声明');
  assert.doesNotMatch(css, /[^-]background:var\(--dsw-specific-menu/, '不能只用 58% 透明的原生填充当底');
  assert.doesNotMatch(css, /background-color:var\(--dsw-specific-menu/, '同上');
});

test('会话桥组件：渲染一个隐藏锚点，不占布局', () => {
  const { plugin } = loadBundle();
  const element = plugin.__internals.OverlayBridge({ inputActions: fakeActions() });
  assert.equal(element.type, 'span');
  assert.equal(element.props['data-dsh-quote-to-chat'], 'anchor');
  assert.equal(element.props['aria-hidden'], 'true');
  assert.equal(element.props.style.display, 'none');
  assert.equal(typeof element.props.ref, 'object');
});

// ---------------------------------------------------------------------------
// 用例：纯函数
// ---------------------------------------------------------------------------

test('normalizeText：CRLF 归一、nbsp 转空格、去零宽字符、去行尾空白与首尾空行，但保留行首缩进', () => {
  const { plugin } = loadBundle();
  const { normalizeText } = plugin.__internals;
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(normalizeText('a\u00a0b'), 'a b');
  assert.equal(normalizeText('a\u200bb\ufeffc'), 'abc');
  assert.equal(normalizeText('  \n 第一行   \n 第二行 \n\n'), ' 第一行\n 第二行');
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText('单行  留内部 空格'), '单行  留内部 空格');
  assert.equal(normalizeText('\tif (a) {\n\t  b()\n\t}'), '\tif (a) {\n\t  b()\n\t}', '代码缩进必须原样保留');
});

test('extractText：块级元素之间补换行、<br> 补换行、顶层不产生多余空行', () => {
  const { plugin, document } = loadBundle();
  const { extractText } = plugin.__internals;

  const fragment = document.createElement('div');
  const p1 = document.createElement('p');
  p1.textContent = '第一段';
  const p2 = document.createElement('p');
  p2.textContent = '第二段';
  const p3 = document.createElement('p');
  p3.appendChild(document.createTextNode('第三'));
  p3.appendChild(document.createElement('br'));
  p3.appendChild(document.createTextNode('段内换行'));
  fragment.appendChild(p1);
  fragment.appendChild(p2);
  fragment.appendChild(p3);

  assert.equal(extractText(fragment), '第一段\n第二段\n第三\n段内换行');
  assert.equal(extractText(document.createElement('div')), '');
});

test('quoteBody / buildPayload：blockquote 逐行加 >、代码块转 fenced、尾随空行、可选来源行', () => {
  const { plugin } = loadBundle();
  const { quoteBody, buildPayload } = plugin.__internals;
  const auto = { enabled: true, format: 'auto', attribution: false, minChars: 2 };

  assert.equal(quoteBody('a\n\nb', 'quote'), '> a\n>\n> b');
  assert.equal(quoteBody('x', 'plain'), 'x');
  assert.equal(quoteBody('const a = 1', 'fenced', 'js'), '```js\nconst a = 1\n```');

  assert.equal(buildPayload('引用这句话', auto, { isCode: false, lang: '', turn: 3 }), '> 引用这句话\n\n');
  assert.equal(
    buildPayload('const a = 1', auto, { isCode: true, lang: 'js', turn: 3 }),
    '```js\nconst a = 1\n```\n\n',
    'auto 模式下代码块应转 fenced，不塞进引用块'
  );
  assert.equal(
    buildPayload('引用这句话', { format: 'quote', attribution: true, minChars: 2 }, { isCode: false, turn: 3 }),
    '> 引用这句话\n\n（引用自第 3 轮回复）\n\n'
  );
  assert.equal(buildPayload('   ', auto, {}), '', '空白选区不产生 payload');
  assert.equal(buildPayload('手动指定纯文本', { format: 'plain', minChars: 2 }, { turn: null }), '手动指定纯文本\n\n');
});

test('placeBar：上方优先、贴顶落下方、横向居中、夹进视口', () => {
  const { plugin } = loadBundle();
  const { placeBar } = plugin.__internals;
  const viewport = { top: 0, left: 0, right: 1280, bottom: 800 };
  const size = { width: 180, height: 30 };

  const above = placeBar([{ top: 200, left: 600, width: 100, bottom: 220 }], size, viewport, 8, 8);
  assert.equal(above.placement, 'above');
  assert.equal(above.top, 162);
  assert.equal(above.left, 560);

  const below = placeBar([{ top: 4, left: 600, width: 100, bottom: 24 }], size, viewport, 8, 8);
  assert.equal(below.placement, 'below');
  assert.equal(below.top, 32);

  const clampedLeft = placeBar([{ top: 400, left: 2, width: 20, bottom: 420 }], size, viewport, 8, 8);
  assert.equal(clampedLeft.left, 8, '左边越界要夹回来');
  const clampedRight = placeBar([{ top: 400, left: 1270, width: 20, bottom: 420 }], size, viewport, 8, 8);
  assert.equal(clampedRight.left, 1280 - 180 - 8, '右边越界要夹回来');

  const multiLine = placeBar(
    [{ top: 700, left: 100, width: 200, bottom: 720 }, { top: 740, left: 100, width: 120, bottom: 760 }],
    size, viewport, 8, 8
  );
  assert.equal(multiLine.placement, 'above', '多行选区贴底时优先待在第一行上方');

  const offscreenAbove = placeBar([{ top: -2883, left: 689, width: 306, bottom: -2863 }], size, viewport, 8, 8);
  assert.equal(offscreenAbove.top, 8, '选区在视口上方时也要把工具条夹回视口内');
  const offscreenBelow = placeBar([{ top: 1200, left: 689, width: 306, bottom: 1220 }], size, viewport, 8, 8);
  assert.equal(offscreenBelow.top, 800 - 8 - 30, '选区在视口下方时同样夹回来');
});

test('shouldShow：七个否决分支与放行分支', () => {
  const { plugin } = loadBundle();
  const { shouldShow } = plugin.__internals;
  const base = {
    enabled: true, hasRange: true, hasRects: true, inViewport: true, text: '一段足够长的文字', minChars: 2,
    insideEditable: false, insideOwnUi: false, insideTranscript: true
  };
  assert.equal(shouldShow(base), true);
  assert.equal(shouldShow(Object.assign({}, base, { enabled: false })), false);
  assert.equal(shouldShow(Object.assign({}, base, { hasRange: false })), false);
  assert.equal(shouldShow(Object.assign({}, base, { hasRects: false })), false);
  assert.equal(shouldShow(Object.assign({}, base, { inViewport: false })), false, '选区整段滚出视口不弹');
  assert.equal(shouldShow(Object.assign({}, base, { text: '好' })), false, '短于 minChars 不弹');
  assert.equal(shouldShow(Object.assign({}, base, { text: '' })), false);
  assert.equal(shouldShow(Object.assign({}, base, { insideEditable: true })), false, '输入框里选中不弹');
  assert.equal(shouldShow(Object.assign({}, base, { insideOwnUi: true })), false, '工具条自身不弹');
  assert.equal(shouldShow(Object.assign({}, base, { insideTranscript: false })), false, '对话正文之外不弹');
});

test('rectsInViewport：整段滚出视口判 false，部分相交判 true', () => {
  const { plugin } = loadBundle();
  const { rectsInViewport } = plugin.__internals;
  const viewport = { top: 0, left: 0, right: 1280, bottom: 800 };
  assert.equal(rectsInViewport([{ top: 100, bottom: 120 }], viewport), true);
  assert.equal(rectsInViewport([{ top: -80, bottom: -20 }], viewport), false, '整段在视口上方');
  assert.equal(rectsInViewport([{ top: 900, bottom: 940 }], viewport), false, '整段在视口下方');
  assert.equal(rectsInViewport([{ top: -10, bottom: 10 }], viewport), true, '压在顶边也算可见');
  assert.equal(rectsInViewport([{ top: -300, bottom: -280 }, { top: 300, bottom: 320 }], viewport), true, '多行里任意一行可见即算');
});

test('parseTurn：只接受非负整数', () => {
  const { plugin } = loadBundle();
  const { parseTurn } = plugin.__internals;
  assert.equal(parseTurn('3'), 3);
  assert.equal(parseTurn('0'), 0);
  assert.equal(parseTurn('abc'), null);
  assert.equal(parseTurn(''), null);
  assert.equal(parseTurn(null), null);
  assert.equal(parseTurn('-1'), null);
  assert.equal(parseTurn('1.5'), null);
});

// ---------------------------------------------------------------------------
// 用例：会话归属
// ---------------------------------------------------------------------------

test('pickInstance：多会话并存时按「最近的共同容器」选中正确输入框', () => {
  const { plugin, document } = loadBundle();
  const { bindInstance, pickInstance } = plugin.__internals;
  const a = addConversation(document, { turn: 3 });
  const sidebar = document.createElement('div');
  sidebar.setAttribute('data-slot', 'sidebar-right');
  document.body.appendChild(sidebar);
  const b = addConversation(document, { turn: 9, host: sidebar });

  const actionsA = fakeActions();
  const actionsB = fakeActions();
  bindInstance(a.anchor, actionsA);
  bindInstance(b.anchor, actionsB);

  assert.equal(pickInstance(a.paragraph).inputActions, actionsA, '主面板的选区写主面板');
  assert.equal(pickInstance(b.paragraph).inputActions, actionsB, '侧边会话的选区写侧边会话');
});

test('pickInstance：只有一个会话时兜底；两个会话都对不上时拒绝而不是写错', () => {
  const { plugin, document } = loadBundle();
  const { bindInstance, pickInstance } = plugin.__internals;
  const a = addConversation(document);
  const actionsA = fakeActions();
  const unbind = bindInstance(a.anchor, actionsA);
  assert.equal(pickInstance(a.paragraph).inputActions, actionsA);

  const stray = document.createElement('p');
  stray.textContent = '别的面板里的文字';
  document.body.appendChild(stray);
  assert.equal(pickInstance(stray).inputActions, actionsA, '唯一实例时兜底');

  const sidebar = document.createElement('div');
  document.body.appendChild(sidebar);
  const b = addConversation(document, { host: sidebar });
  bindInstance(b.anchor, fakeActions());
  assert.equal(pickInstance(stray), null, '两个会话且都对不上：宁可报错也不写错地方');

  unbind();
  assert.equal(plugin.__internals.liveInstances().length, 1);
});

test('bindInstance：解绑后不再计入 live；锚点脱离文档的实例被忽略', () => {
  const { plugin, document } = loadBundle();
  const { bindInstance, liveInstances } = plugin.__internals;
  const a = addConversation(document);
  const unbind = bindInstance(a.anchor, fakeActions());
  assert.equal(liveInstances().length, 1);
  unbind();
  assert.equal(liveInstances().length, 0);

  bindInstance(a.anchor, fakeActions());
  a.anchor.remove();
  assert.equal(liveInstances().length, 0, '脱离文档的锚点不算活实例');
});

// ---------------------------------------------------------------------------
// 用例：选区 → 工具条
// ---------------------------------------------------------------------------

test('选中对话正文 → 工具条出现在选区上方，位置写进 style', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);

  window.__selection = makeSelection(document, world.paragraph, { top: 200, left: 600, width: 100 });
  document.dispatch('selectionchange');
  flushRaf();

  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
  assert.equal(bar.getAttribute('data-open'), '1');
  assert.equal(bar.getAttribute('data-placement'), 'above');
  assert.equal(bar.style.left, '562px', '按兜底宽度 176 居中：600 + 50 - 88');
  assert.equal(bar.style.top, '162px', '200 - 30 - 8');
  assert.equal(plugin.__internals.debugState().text, world.paragraph.textContent);
  assert.equal(plugin.__internals.debugState().turn, 3);
});

test('折叠选区 / 过短文本一律收起', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');

  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '1');

  window.__selection = makeCollapsedSelection();
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0', '折叠选区要收起');

  const short = document.createElement('p');
  short.textContent = '好';
  world.turn.appendChild(short);
  window.__selection = makeSelection(document, short, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0', '太短不弹');
});

test('选区整段滚出视口时不弹（避免工具条悬在空处）', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');

  window.__selection = makeSelection(document, world.paragraph, { top: -2883, left: 689, width: 306 });
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0');

  window.__selection = makeSelection(document, world.paragraph, { top: 300, left: 689, width: 306 });
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '1', '回到视口内立刻可用');
});

test('输入框内选中 / 工具条自身 / 对话正文之外都不弹', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');

  const draft = document.createElement('p');
  draft.textContent = '这是输入框里已经写好的草稿文字';
  const editorInner = document.createElement('span');
  editorInner.appendChild(draft);
  world.editor.appendChild(editorInner);
  window.__selection = makeSelection(document, draft, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0', '在 composer 里选中不弹');

  const outside = document.createElement('p');
  outside.textContent = '侧边栏或文档预览里的文字';
  document.body.appendChild(outside);
  window.__selection = makeSelection(document, outside, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0', '不在对话正文里不弹');

  const own = document.createElement('span');
  own.textContent = '工具条自己的文字';
  own.setAttribute('data-dsh-quote-to-chat', 'flash');
  document.body.appendChild(own);
  window.__selection = makeSelection(document, own, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0', '工具条自身不弹');
});

test('滚动到选区已失效时自动收起', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');

  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '1');

  window.__selection = makeCollapsedSelection();
  window.dispatch('scroll', {});
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '0');
});

test('Escape 收起工具条', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');

  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(bar.getAttribute('data-open'), '1');

  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(bar.getAttribute('data-open'), '0');
});

// ---------------------------------------------------------------------------
// 用例：动作
// ---------------------------------------------------------------------------

test('点「添加到对话」：captureInsertion + insertText 收到引用块，工具条切到结果提示', () => {
  const bundle = withSelection();
  const { bar, actions, world, document } = Object.assign({}, bundle, {
    bar: bundle.document.querySelector('[data-dsh-quote-to-chat="bar"]')
  });
  clickBar(bundle, 'add');

  assert.equal(actions.calls.capture, 1, '必须先取一次带 draftRev 的插入位置');
  assert.equal(actions.calls.insert.length, 1);
  assert.equal(actions.calls.insert[0].text, '> ' + world.paragraph.textContent + '\n\n');
  assert.deepEqual(plain(actions.calls.insert[0].span), { start: 0, end: 0, draftRev: 7 });
  assert.equal(bar.getAttribute('data-flash'), '1');
  assert.equal(flashText(bundle), '已添加到对话');
  assert.equal(document.focusedEditor, world.editor, '写回后把光标交回输入框');
});

test('代码块选区在 auto 模式下写成 fenced', () => {
  const bundle = withSelection();
  const { document, window, flushRaf, plugin } = bundle;
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-js';
  code.textContent = 'const a = 1;';
  pre.appendChild(code);
  bundle.world.turn.appendChild(pre);

  window.__selection = makeSelection(document, code, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(plugin.__internals.debugState().text, 'const a = 1;');

  clickBar(bundle, 'add');
  assert.equal(bundle.actions.calls.insert.length, 1);
  assert.equal(bundle.actions.calls.insert[0].text, '```js\nconst a = 1;\n```\n\n');
});

test('输入框忙碌（insertText 返回 false）：明确提示，不静默丢内容', () => {
  const bundle = withSelection({ actions: { insertReturns: false } });
  clickBar(bundle, 'add');
  assert.equal(bundle.actions.calls.insert.length, 1);
  assert.equal(flashText(bundle), '输入框正忙，稍后再试');
});

test('多会话都对不上时：提示「找不到对应的输入框」，一个会话都不写', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const a = addConversation(document);
  const sidebar = document.createElement('div');
  document.body.appendChild(sidebar);
  const b = addConversation(document, { host: sidebar });
  const actionsA = fakeActions();
  const actionsB = fakeActions();
  plugin.__internals.bindInstance(a.anchor, actionsA);
  plugin.__internals.bindInstance(b.anchor, actionsB);

  // 一段孤立的正文插槽：它确实是「对话正文」，但不属于任何一个 composer 所在的会话。
  const orphan = document.createElement('div');
  orphan.setAttribute('data-slot', 'conversation.session');
  const text = document.createElement('p');
  text.textContent = '孤立插槽里的一段选区文本';
  orphan.appendChild(text);
  document.body.appendChild(orphan);

  window.__selection = makeSelection(document, text, {});
  document.dispatch('selectionchange');
  flushRaf();

  const bar = document.querySelector('[data-dsh-quote-to-chat="bar"]');
  assert.equal(bar.getAttribute('data-open'), '1', '正文插槽里应当弹条');

  clickBar({ document }, 'add');
  assert.equal(actionsA.calls.insert.length, 0);
  assert.equal(actionsB.calls.insert.length, 0);
  assert.equal(flashText({ document }), '找不到对应的输入框');
});

test('缺少 inputActions 时给出明确提示，不抛异常', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const world = addConversation(document);
  plugin.__internals.bindInstance(world.anchor, null);
  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  clickBar({ document }, 'add');
  assert.equal(flashText({ document }), '当前界面不支持写入输入框');
});

test('点「复制」把原文写进剪贴板', async () => {
  const bundle = withSelection();
  clickBar(bundle, 'copy');
  await Promise.resolve();
  assert.deepEqual(bundle.clip.written, [bundle.world.paragraph.textContent]);
});

test('结果提示期间 selectionchange 不打断提示', () => {
  const bundle = withSelection();
  const bar = clickBar(bundle, 'add');
  assert.equal(bar.getAttribute('data-flash'), '1');

  // 写回草稿会让光标落进 composer，进而触发一次 selectionchange。
  bundle.window.__selection = makeCollapsedSelection();
  bundle.document.dispatch('selectionchange');
  bundle.flushRaf();
  assert.equal(bar.getAttribute('data-flash'), '1', '提示不该被自己引发的 selectionchange 抹掉');
  assert.equal(flashText(bundle), '已添加到对话');
});

// ---------------------------------------------------------------------------
// 用例：侧边提问（可选依赖 dsh-better-sidebar）
// ---------------------------------------------------------------------------

test('没装 dsh-better-sidebar：整条动作隐藏，点了也只给明确提示', () => {
  const bundle = withSelection();
  const bar = bundle.document.querySelector('[data-dsh-quote-to-chat="bar"]');
  assert.equal(bar.getAttribute('data-sidechat'), '0', '没有服务就该把这条动作藏掉');
  assert.equal(bundle.plugin.__internals.debugState().sideChat, false);

  clickBar(bundle, 'side');
  assert.equal(flashText(bundle), '未安装 dsh-better-sidebar');
});

test('装了侧边对话且右栏已经开着输入框：直接写进去，不再开新线程', () => {
  const service = fakeSideService();
  const bundle = withSelection({ services: { betterSidebar: service } });
  const bar = bundle.document.querySelector('[data-dsh-quote-to-chat="bar"]');
  assert.equal(bar.getAttribute('data-sidechat'), '1');
  assert.equal(bundle.plugin.__internals.debugState().sideChat, true);

  const composer = addSideComposer(bundle.document, { value: '先写了一半的问题' });
  clickBar(bundle, 'side');

  assert.equal(service.calls.openTab.length, 0, '已有输入框就不该再开一个线程');
  assert.equal(composer.value, '先写了一半的问题\n\n> ' + bundle.world.paragraph.textContent + '\n\n');
  assert.equal(bundle.document.focusedEditor, composer, '光标要落到侧边对话输入框');
  assert.deepEqual(composer.__caret, [composer.value.length, composer.value.length], '光标落在末尾');
  assert.equal(flashText(bundle), '已在侧边对话中引用');
});

test('右栏没开侧边对话：用它的公开服务开 sidechat tab，并把会话身份带上', () => {
  const service = fakeSideService();
  const bundle = withSelection({ services: { betterSidebar: service }, world: { sessionId: 'session-abc' } });
  clickBar(bundle, 'side');

  assert.equal(service.calls.openTab.length, 1);
  assert.deepEqual(plain(service.calls.openTab[0].seed), { type: 'sidechat' });
  assert.deepEqual(plain(service.calls.openTab[0].scope), { sessionId: 'session-abc' }, '要落在选区所在会话的右栏');
  assert.equal(flashText(bundle), '正在打开侧边对话…');
});

test('输入框稍后才出现：轮询等到它再写入', async () => {
  let document = null;
  const service = fakeSideService(() => { setTimeout(() => addSideComposer(document), 30); });
  const bundle = withSelection({ services: { betterSidebar: service } });
  document = bundle.document;

  clickBar(bundle, 'side');
  assert.equal(flashText(bundle), '正在打开侧边对话…');
  assert.equal(bundle.document.querySelector('textarea'), null, '此刻还没有输入框');

  await new Promise((r) => setTimeout(r, 260));
  const composer = bundle.document.querySelector('textarea');
  assert.ok(composer, '轮询应等到输入框出现');
  assert.equal(composer.value, '> ' + bundle.world.paragraph.textContent + '\n\n');
  assert.equal(flashText(bundle), '已在侧边对话中引用');
});

test('等不到输入框：兜底把引用放进剪贴板，并明确告知', () => {
  const service = fakeSideService();
  const bundle = withSelection({ services: { betterSidebar: service } });
  const payload = '> ' + bundle.world.paragraph.textContent + '\n\n';
  bundle.plugin.__internals.waitForSideChat([], payload, bundle.world.paragraph.textContent, Date.now() - 1);
  assert.deepEqual(bundle.clip.written, [bundle.world.paragraph.textContent]);
  assert.equal(flashText(bundle), '侧边对话已打开，引用已复制');
});

test('isSideChatComposer：排除 xterm 隐藏输入框、零尺寸与不可见元素', () => {
  const { plugin, document } = loadBundle();
  const { isSideChatComposer } = plugin.__internals;

  const real = document.createElement('textarea');
  real.__rect = { width: 240, height: 22 };
  assert.equal(isSideChatComposer(real), true);

  const tiny = document.createElement('textarea');
  tiny.__rect = { width: 1, height: 1 };
  assert.equal(isSideChatComposer(tiny), false, 'xterm 的 helper textarea 是 1×1');

  const hidden = document.createElement('textarea');
  hidden.__rect = { width: 240, height: 22 };
  hidden.style.display = 'none';
  assert.equal(isSideChatComposer(hidden), false, '隐藏 tab 里的输入框不算');

  const xterm = document.createElement('div');
  xterm.className = 'xterm';
  const helper = document.createElement('textarea');
  helper.className = 'xterm-helper-textarea';
  helper.__rect = { width: 240, height: 22 };
  xterm.appendChild(helper);
  document.body.appendChild(xterm);
  assert.equal(isSideChatComposer(helper), false, '终端输入框不算侧边对话');

  assert.equal(isSideChatComposer(document.createElement('div')), false);
  assert.equal(isSideChatComposer(null), false);
});

test('sessionIdOf：沿用官方 data-conversation-session 读取会话身份', () => {
  const { plugin, document } = loadBundle();
  const world = addConversation(document, { sessionId: 'session-xyz' });
  assert.equal(plugin.__internals.sessionIdOf(world.paragraph), 'session-xyz');
  assert.equal(plugin.__internals.sessionIdOf(document.body), null);
});

test('侧边提问后再点「添加到对话」互不干扰：草稿与侧边线程各写各的', () => {
  const service = fakeSideService();
  const bundle = withSelection({ services: { betterSidebar: service } });
  const composer = addSideComposer(bundle.document);

  clickBar(bundle, 'side');
  assert.equal(bundle.actions.calls.insert.length, 0, '侧边提问不该动主会话草稿');
  assert.match(composer.value, /^> /);

  bundle.window.__selection = makeSelection(bundle.document, bundle.world.paragraph, {});
  bundle.document.dispatch('selectionchange');
  bundle.flushRaf();
  clickBar(bundle, 'add');
  assert.equal(bundle.actions.calls.insert.length, 1, '添加到对话仍然写主会话草稿');
});

// ---------------------------------------------------------------------------
// 用例：调试句柄与回收
// ---------------------------------------------------------------------------

test('调试句柄：config 白名单读写、坏数据回落默认值、insert() 可绕过真实选区', () => {
  const { plugin, document, window, storage } = loadBundle();
  plugin.apply(makeCtx().ctx);
  const api = window.__dshQuoteToChat;
  assert.deepEqual(plain(api.config()), { enabled: true, format: 'auto', attribution: false, minChars: 2 });

  api.setConfig({ format: 'plain', minChars: 0, bogus: 123 });
  assert.deepEqual(plain(api.config()), { enabled: true, format: 'plain', attribution: false, minChars: 0 });
  assert.equal(JSON.parse(storage.getItem('dsh.quote-to-chat.v1')).bogus, undefined, '白名单外的字段不落盘');

  api.setConfig({ format: 'nonsense', minChars: -5, enabled: 'yes' });
  assert.deepEqual(plain(api.config()), { enabled: true, format: 'plain', attribution: false, minChars: 0 }, '非法值被忽略');

  const world = addConversation(document);
  const actions = fakeActions();
  plugin.__internals.bindInstance(world.anchor, actions);
  api.setConfig({ format: 'auto' });
  assert.equal(api.insert('借用调试句柄写入的一段话'), true);
  assert.equal(actions.calls.insert.length, 1);
  assert.equal(actions.calls.insert[0].text, '> 借用调试句柄写入的一段话\n\n');

  const bad = loadBundle({ seed: { 'dsh.quote-to-chat.v1': '{ not json' } });
  bad.plugin.apply(makeCtx().ctx);
  assert.deepEqual(
    plain(bad.window.__dshQuoteToChat.config()),
    { enabled: true, format: 'auto', attribution: false, minChars: 2 }
  );
});

test('dispose()：样式表、工具条、监听器、调试句柄全部清干净', () => {
  const { plugin, document, window } = loadBundle();
  const { ctx, effects } = makeCtx();
  plugin.apply(ctx);
  const world = addConversation(document);
  plugin.__internals.bindInstance(world.anchor, fakeActions());

  effects[0].cleanup();

  assert.equal(document.querySelector('style[data-plugin-css="dsh-quote-to-chat/style"]'), null);
  assert.equal(document.querySelector('[data-dsh-quote-to-chat="bar"]'), null);
  assert.equal(document.listenerCount('selectionchange'), 0);
  assert.equal(document.listenerCount('mouseup'), 0);
  assert.equal(document.listenerCount('touchend'), 0);
  assert.equal(document.listenerCount('keydown'), 0);
  assert.equal(window.windowListenerCount('scroll'), 0);
  assert.equal(window.windowListenerCount('resize'), 0);
  assert.equal(window.__dshQuoteToChat, undefined);
});

test('dispose() 之后选区变化不再建工具条（幂等且不复活）', () => {
  const { plugin, document, window, flushRaf } = loadBundle();
  const { ctx, effects } = makeCtx();
  plugin.apply(ctx);
  const world = addConversation(document);
  effects[0].cleanup();

  window.__selection = makeSelection(document, world.paragraph, {});
  document.dispatch('selectionchange');
  flushRaf();
  assert.equal(document.querySelector('[data-dsh-quote-to-chat="bar"]'), null);
  assert.equal(document.querySelector('style[data-plugin-css="dsh-quote-to-chat/style"]'), null);
});
