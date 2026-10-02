// dsh-quote-to-chat — browser half.
//
// 在 DSH Web GUI 里选中回复内容，弹出浮动工具条：「添加到对话」把选中片段
// 作为引用块写进输入框（composer）草稿，另一个动作是「复制」。默认外观完全
// 使用 DSH 原生菜单材质（--dsw-specific-menu / --dsw-menu-backdrop-filter /
// --dsw-elevation-prominent），未选中文本时不存在任何可见 DOM。
//
// 约束与做法（全部来自 DSH 0.2.0-rc.1 的真实契约，见 README「落地依据」）：
//  1. 本文件按 dsh-client-modules 的 lazy-CJS 模型编写：顶层只允许注册 factory，
//     任何副作用都必须留在 factory 闭包内、由 apply() 在 materialization 时触发。
//  2. `id` 必须等于 package.json 的 name，否则浏览器侧永远 materialize 不出来。
//  3. 模块对象用平铺导出（exports.apply / exports.inject），不要 export default：
//     loader 的 unwrapExports 会用 default 整个替换命名空间，写在一起的 inject 会静默丢失。
//  4. 写回输入框只走公开 API：会话 scope 的插槽组件会自动拿到 `inputActions`
//     （ui-conversation 的 `ctx.uiSession.provide({ props: ['inputActions'] })`），
//     `captureInsertion()` 给出带 draftRev 的插入位置，`insertText(text, span)`
//     执行一次原子插入；draftRev 不匹配或输入框处于 adjudicating/submitting 时
//     它返回 false（不会破坏草稿），我们据此提示重试。
//  5. 因此本插件必须注册**一个**会话级插槽条目（conversation.input.overlay）当桥，
//     它只渲染一个 display:none 的锚点 span，用来把 inputActions 和「本会话的
//     DOM 子树的归属」交给工具条；浮层本体是纯 DOM，直接挂 document.body。
//  6. 选区识别不依赖任何构建期哈希类名：消息轮次用 `[data-chat-turn]`，对话正文
//     容器用插槽渲染器固定输出的 `[data-slot="conversation.session"]`。
//  7. 注入样式表必须自己打 `data-plugin` / `data-plugin-css`，否则可能被后一个
//     materialize 的插件「认领」，并在它卸载时被删掉。

window.__ModuleLoader__.load({
  id: 'dsh-quote-to-chat',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');

    // ======================================================================
    // 一、常量
    // ======================================================================

    var PKG = 'dsh-quote-to-chat';
    var VERSION = '0.2.0';
    var STYLE_TAG_ID = PKG + '/style';
    var GLOBAL_KEY = '__dshQuoteToChat';
    var STORAGE_KEY = 'dsh.quote-to-chat.v1';

    /** 本插件所有 DOM 都带这个属性；值是它在工具条里的角色（bar / add / side / copy / flash / anchor）。 */
    var MARK = 'data-dsh-quote-to-chat';

    /** 会话级插槽：resident composer card 里的浮层座位，官方 feedback 弹窗也用这一格。 */
    var SLOT_OVERLAY = 'conversation.input.overlay';

    /** 插槽渲染器给每个 outlet 输出的固定锚点（renderer 里 ANCHOR_STYLE 的那层 div）。 */
    var TRANSCRIPT_SLOT = '[data-slot="conversation.session"]';
    var COMPOSER_BAR_SLOT = 'conversation.composer.bar';
    /** 官方自己在用的会话身份钩子（ui-conversation 的 Escape 处理就是这么取 sessionId 的）。 */
    var SESSION_ATTR = 'data-conversation-session';
    /** 右侧栏的插槽 outlet；第三方侧边对话 tab 的输入框落在它里面。 */
    var RIGHTBAR_SLOT = '[data-slot="rightbar.session"]';

    /** Lexical contenteditable 宿主：role/aria-multiline 由 lexical-react 固定输出。 */
    var EDITOR_SELECTOR = 'div[contenteditable="true"][role="textbox"]';
    var EDITOR_FALLBACK = 'div[contenteditable="true"]';

    /** dsh-better-sidebar 的侧边对话 tab 类型与它的客户端服务名（可选依赖，用 ctx.get 读）。 */
    var SIDE_TAB_TYPE = 'sidechat';
    var SIDE_SERVICE = 'betterSidebar';
    var SIDE_WAIT_MS = 5000;
    var SIDE_POLL_MS = 120;

    var GAP = 8;
    var MARGIN = 8;
    var BAR_FALLBACK_WIDTH = 176;
    var BAR_FALLBACK_HEIGHT = 30;

    var DEFAULTS = {
      enabled: true,
      /** auto = 代码块用 fenced、其余用 blockquote；可强制 quote / fenced / plain。 */
      format: 'auto',
      /** 打开后会在引用块后补一行来源（第 N 轮回复）。 */
      attribution: false,
      /** 少于这么多字符不弹（避免点选几个字就冒泡）。 */
      minChars: 2
    };

    /** 块级标签：Range.cloneContents() 的片段按它们补换行。 */
    var BLOCK_TAGS = {
      P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, PRE: 1, BLOCKQUOTE: 1, H1: 1, H2: 1, H3: 1,
      H4: 1, H5: 1, H6: 1, TR: 1, TABLE: 1, SECTION: 1, ARTICLE: 1, FIGURE: 1,
      FIGCAPTION: 1, DETAILS: 1, SUMMARY: 1, DL: 1, DT: 1, DD: 1, HR: 1
    };

    /**
     * 工具条材质：与原生菜单同一组 token（MenuSurface / stat-dialog / panel 都是这套）。
     *
     * 关键一条：原生菜单填充 --dsw-specific-menu 只有 **58% 不透明**（浅色 #f8f9fa94 /
     * 深色 #43454a73），它是给「浮在平面背景上的菜单」设计的；工具条却正好浮在密集正文上，
     * 用它单独做底会让前后两层互相穿透、两边都看不清（实测：正文笔画直接压在标签上）。
     * theme 里确实存在一个 94% 的 macOS 版本（#f8f9faf0），但它的选择器是
     * `html[data-platform=darwin] body`，而这个构建从不设置 data-platform（实测 html 与
     * body 上都没有该属性）——那条规则是死代码。
     *
     * 所以做法是：把原生填充铺在**一层不透明的应用层色**上。色相仍是原生菜单色（浅色下
     * 合成 ≈ #fbfbfc，深色下 ≈ #313235），但任何内容都不会再透上来。backdrop-filter 保留，
     * 既与原生材质声明一致，将来填充若变透也能自动回落到毛玻璃。
     */
    var CSS = [
      '.dshqc-bar{position:fixed;z-index:1140;box-sizing:border-box;display:flex;align-items:center;padding:2px;',
      'border-radius:var(--dsw-radius-lg,10px);',
      'background-color:var(--dsw-alias-bg-layer-1,#fff);',
      'background-image:linear-gradient(var(--dsw-specific-menu,rgba(248,249,250,.94)),var(--dsw-specific-menu,rgba(248,249,250,.94)));',
      'backdrop-filter:var(--dsw-menu-backdrop-filter,none);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);',
      '--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.18));',
      'color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,inherit);',
      'font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));',
      'white-space:nowrap;user-select:none;-webkit-user-select:none;',
      'opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease,visibility .12s ease}',
      '.dshqc-bar[data-open="1"]{opacity:1;visibility:visible;pointer-events:auto}',
      '.dshqc-item{display:inline-flex;align-items:center;box-sizing:border-box;border:0;background:0 0;font:inherit;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;padding:3px 10px;border-radius:var(--dsw-radius-md,6px);',
      'white-space:nowrap;-webkit-user-select:none;user-select:none}',
      '.dshqc-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshqc-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.dshqc-item[data-dsh-quote-to-chat="add"]{color:var(--dsw-alias-label-primary)}',
      '.dshqc-sep{flex:none;width:1px;height:14px;margin:0 2px;background:var(--dsw-alias-border-l1)}',
      '.dshqc-flash{display:none;padding:3px 10px;color:var(--dsw-alias-label-secondary)}',
      '.dshqc-bar[data-flash="1"] .dshqc-item,.dshqc-bar[data-flash="1"] .dshqc-sep{display:none}',
      '.dshqc-bar[data-flash="1"] .dshqc-flash{display:inline-flex}',
      // 没装侧边对话（dsh-better-sidebar）时，整条动作连同它前面的分隔线一起消失。
      '.dshqc-bar[data-sidechat="0"] [data-dsh-quote-to-chat="side"],',
      '.dshqc-bar[data-sidechat="0"] [data-dsh-quote-to-chat="sep-side"]{display:none}'
    ].join('');

    // ======================================================================
    // 二、纯函数区（离线单测直接覆盖）
    // ======================================================================

    /**
     * 归一化选区文本：统一换行、去零宽字符、去行尾空白与首尾空行。
     * @param raw - Selection/Range 的原始文本。
     * @returns 干净的引用文本（可能为空串）。
     */
    function normalizeText(raw) {
      if (typeof raw !== 'string') return '';
      return raw
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+/, '')
        .replace(/\s+$/, '');
    }

    /**
     * 把 Range.cloneContents() 的片段还原成带块级换行的纯文本。
     * 浏览器 Selection.toString() 不保证块级元素之间补换行，多段选中会粘成一行。
     * @param fragment - DocumentFragment 或任意带 childNodes 的节点。
     * @returns 纯文本（未归一化）。
     */
    function extractText(fragment) {
      var out = '';
      var walk = function (node) {
        var kids = node && node.childNodes ? node.childNodes : [];
        for (var i = 0; i < kids.length; i += 1) {
          var child = kids[i];
          if (child.nodeType === 3) { out += child.nodeValue || ''; continue; }
          if (child.nodeType !== 1) continue;
          var name = String(child.nodeName || '').toUpperCase();
          if (name === 'BR') { out += '\n'; continue; }
          var block = !!BLOCK_TAGS[name];
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
          walk(child);
          if (block && out && out.charAt(out.length - 1) !== '\n') out += '\n';
        }
      };
      walk(fragment);
      return out.replace(/^\n+/, '').replace(/\n+$/, '');
    }

    /**
     * 引用正文的三种形态。
     * @param text - 归一化后的文本。
     * @param mode - quote / fenced / plain。
     * @param lang - fenced 模式下的语言标记（可空）。
     * @returns 正文。
     */
    function quoteBody(text, mode, lang) {
      if (mode === 'plain') return text;
      if (mode === 'fenced') return '```' + (lang || '') + '\n' + text + '\n```';
      return String(text).split('\n').map(function (line) {
        return line.length ? '> ' + line : '>';
      }).join('\n');
    }

    /**
     * 最终写进输入框的文本：引用本体 + 尾随一个空行（光标落在这里，接着就能写）。
     * @param text - 原始选区文本。
     * @param cfg - 归一化后的配置。
     * @param meta - { isCode, lang, turn }。
     * @returns 写进草稿的字符串；空选区返回空串。
     */
    function buildPayload(text, cfg, meta) {
      var body = normalizeText(text);
      if (!body) return '';
      var info = meta || {};
      var mode = cfg.format === 'auto' ? (info.isCode ? 'fenced' : 'quote') : cfg.format;
      var out = quoteBody(body, mode, info.lang);
      if (cfg.attribution && info.turn !== null && info.turn !== undefined) {
        out += '\n\n（引用自第 ' + info.turn + ' 轮回复）';
      }
      return out + '\n\n';
    }

    /**
     * 工具条定位：默认贴选区首行上方，上方放不下就落到末行下方，横向居中并夹进视口。
     * @param rects - 选区各行的 {top,left,width,bottom}（顺序即文档顺序）。
     * @param size - 工具条 {width,height}。
     * @param viewport - {top,left,right,bottom}。
     * @param gap - 与选区的间距。
     * @param margin - 与视口边缘的最小距离。
     * @returns {left, top, placement}。
     */
    function placeBar(rects, size, viewport, gap, margin) {
      var head = rects[0];
      var tail = rects[rects.length - 1];
      var w = size.width;
      var h = size.height;
      var above = head.top - h - gap;
      var below = tail.bottom + gap;
      var placement = 'above';
      var top = above;
      if (above < viewport.top + margin) {
        if (below + h <= viewport.bottom - margin) {
          placement = 'below';
          top = below;
        } else {
          top = Math.max(viewport.top + margin, above);
        }
      }
      // 两个方向都要夹进视口：选区本身可能正好跨在边界上。
      top = Math.min(Math.max(top, viewport.top + margin), Math.max(viewport.top + margin, viewport.bottom - margin - h));
      var center = head.left + head.width / 2;
      var left = center - w / 2;
      var minLeft = viewport.left + margin;
      var maxLeft = viewport.right - w - margin;
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = Math.max(minLeft, maxLeft);
      return { left: Math.round(left), top: Math.round(top), placement: placement };
    }

    /**
     * 该不该弹工具条（纯判定，所有否决分支都能离线覆盖）。
     * @param input - { enabled, hasRange, hasRects, inViewport, text, minChars, insideEditable, insideOwnUi, insideTranscript }。
     * @returns 是否显示。
     */
    function shouldShow(input) {
      if (!input.enabled) return false;
      if (!input.hasRange || !input.hasRects) return false;
      if (!input.inViewport) return false;
      if (!input.text || input.text.length < input.minChars) return false;
      if (input.insideEditable) return false;
      if (input.insideOwnUi) return false;
      if (!input.insideTranscript) return false;
      return true;
    }

    /**
     * 选区是否还在视口里：整段滚出屏幕时不该在空处悬一条工具条。
     * @param rects - 选区各行矩形。
     * @param viewport - 视口。
     * @returns 至少有一行与视口相交。
     */
    function rectsInViewport(rects, viewport) {
      for (var i = 0; i < rects.length; i += 1) {
        if (rects[i].bottom > viewport.top && rects[i].top < viewport.bottom) return true;
      }
      return false;
    }

    /**
     * `data-chat-turn` 的值解析成轮次号。
     * @param value - 属性原文。
     * @returns 非负整数或 null。
     */
    function parseTurn(value) {
      if (value === null || value === undefined || value === '') return null;
      var n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }

    /**
     * 从元素往上找第一个「也包含目标节点」的祖先（= 同一个对话面板），body/html 不算。
     * @param fromEl - 起点（通常是某个 composer 的锚点）。
     * @param target - 选区所在的节点。
     * @returns 共同容器或 null。
     */
    function commonContainer(fromEl, target) {
      var node = fromEl;
      while (node) {
        if (node === document.body || node === document.documentElement) return null;
        if (typeof node.contains === 'function' && target && node.contains(target)) return node;
        node = node.parentNode;
      }
      return null;
    }

    /** 节点深度，用于在多个候选里挑最近的那个共同容器。 */
    function depthOf(node) {
      var depth = 0;
      var cursor = node;
      while (cursor) { depth += 1; cursor = cursor.parentNode; }
      return depth;
    }

    // ======================================================================
    // 三、运行态
    // ======================================================================

    var config = defaultConfig();
    var installed = false;
    var barEl = null;
    var flashEl = null;
    var flashTimer = null;
    var rafId = null;
    var sideChatPoll = null;
    /** 客户端根上下文：只用来 ctx.get 那个可选服务（inject-free，缺了不抛）。 */
    var rootContext = null;
    var state = { snapshot: null, flashing: false };

    /** 每个会话一个桥实例：锚点 DOM + 该会话的 inputActions。 */
    var instances = [];
    var instanceSeq = 0;

    function defaultConfig() {
      var cfg = {};
      for (var key in DEFAULTS) cfg[key] = DEFAULTS[key];
      return cfg;
    }

    /**
     * 读配置（localStorage 坏数据一律回落到默认值）。
     * @returns 归一化配置。
     */
    function readConfig() {
      var cfg = defaultConfig();
      var raw = null;
      try {
        raw = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null;
      } catch (err) { raw = null; }
      if (!raw) return cfg;
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (err) { return cfg; }
      if (!parsed || typeof parsed !== 'object') return cfg;
      if (typeof parsed.enabled === 'boolean') cfg.enabled = parsed.enabled;
      if (parsed.format === 'auto' || parsed.format === 'quote' || parsed.format === 'fenced' || parsed.format === 'plain') {
        cfg.format = parsed.format;
      }
      if (typeof parsed.attribution === 'boolean') cfg.attribution = parsed.attribution;
      if (typeof parsed.minChars === 'number' && isFinite(parsed.minChars) && parsed.minChars >= 0) {
        cfg.minChars = Math.floor(parsed.minChars);
      }
      return cfg;
    }

    /**
     * 写配置（只接受白名单字段）。
     * @param patch - 部分配置。
     * @returns 归一化后的新配置。
     */
    function writeConfig(patch) {
      var next = defaultConfig();
      for (var key in config) next[key] = config[key];
      if (patch && typeof patch === 'object') {
        if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
        if (patch.format === 'auto' || patch.format === 'quote' || patch.format === 'fenced' || patch.format === 'plain') {
          next.format = patch.format;
        }
        if (typeof patch.attribution === 'boolean') next.attribution = patch.attribution;
        if (typeof patch.minChars === 'number' && isFinite(patch.minChars) && patch.minChars >= 0) {
          next.minChars = Math.floor(patch.minChars);
        }
      }
      config = next;
      try {
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      } catch (err) { /* 隐私模式等：内存态照常生效 */ }
      return config;
    }

    // ======================================================================
    // 四、DOM：样式、工具条
    // ======================================================================

    function installStyle() {
      if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]')) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = PKG;
      tag.dataset.pluginCss = STYLE_TAG_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyle() {
      var tag = document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]');
      if (tag && tag.parentNode) tag.remove();
    }

    function buildBar() {
      if (barEl) return;
      var bar = document.createElement('div');
      bar.className = 'dshqc-bar';
      bar.setAttribute(MARK, 'bar');
      bar.setAttribute('data-open', '0');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '选中文本操作');

      var add = document.createElement('button');
      add.className = 'dshqc-item';
      add.setAttribute(MARK, 'add');
      add.setAttribute('type', 'button');
      add.setAttribute('aria-label', '添加到对话');
      add.textContent = '添加到对话';

      var sep = document.createElement('span');
      sep.className = 'dshqc-sep';
      sep.setAttribute(MARK, 'sep-side');
      sep.setAttribute('aria-hidden', 'true');

      var side = document.createElement('button');
      side.className = 'dshqc-item';
      side.setAttribute(MARK, 'side');
      side.setAttribute('type', 'button');
      side.setAttribute('aria-label', '在侧边对话中提问');
      side.textContent = '侧边提问';

      var sep2 = document.createElement('span');
      sep2.className = 'dshqc-sep';
      sep2.setAttribute(MARK, 'sep-copy');
      sep2.setAttribute('aria-hidden', 'true');

      var copy = document.createElement('button');
      copy.className = 'dshqc-item';
      copy.setAttribute(MARK, 'copy');
      copy.setAttribute('type', 'button');
      copy.setAttribute('aria-label', '复制');
      copy.textContent = '复制';

      var flash = document.createElement('span');
      flash.className = 'dshqc-flash';
      flash.setAttribute(MARK, 'flash');
      flash.setAttribute('role', 'status');

      bar.appendChild(add);
      bar.appendChild(sep);
      bar.appendChild(side);
      bar.appendChild(sep2);
      bar.appendChild(copy);
      bar.appendChild(flash);

      // 保住选区：点工具条不能把 DOM 选区清掉。
      bar.addEventListener('mousedown', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
      });
      bar.addEventListener('click', onBarClick);

      document.body.appendChild(bar);
      barEl = bar;
      flashEl = flash;
    }

    function onBarClick(event) {
      var target = event ? event.target : null;
      var hit = target && typeof target.closest === 'function' ? target.closest('[' + MARK + ']') : null;
      if (!hit || typeof hit.getAttribute !== 'function') return;
      var action = hit.getAttribute(MARK);
      if (action === 'add') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        addToConversation();
      } else if (action === 'side') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        openSideChat();
      } else if (action === 'copy') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        copySelection();
      }
    }

    /**
     * 把一个会话的 inputActions 绑到它的锚点上。
     * @param anchorEl - 该会话 composer 卡片内的锚点元素。
     * @param inputActions - 会话公开输入动作面（可能缺失，缺失时动作会明确报错而不是静默）。
     * @returns 解绑函数。
     */
    function bindInstance(anchorEl, inputActions) {
      if (!anchorEl) return function () {};
      var instance = { id: (instanceSeq += 1), anchor: anchorEl, inputActions: inputActions || null };
      instances.push(instance);
      return function () {
        var index = instances.indexOf(instance);
        if (index >= 0) instances.splice(index, 1);
      };
    }

    function liveInstances() {
      return instances.filter(function (instance) {
        return instance.anchor && instance.anchor.isConnected !== false;
      });
    }

    /**
     * 选中哪条对话的文本，就写回那条对话的输入框。
     * @param selEl - 选区所在元素。
     * @returns 目标实例；无法唯一确定时返回 null（宁可报错也不写错地方）。
     */
    function pickInstance(selEl) {
      var live = liveInstances();
      if (!live.length) return null;
      var best = null;
      var bestDepth = -1;
      for (var i = 0; i < live.length; i += 1) {
        var container = commonContainer(live[i].anchor, selEl);
        if (!container) continue;
        var depth = depthOf(container);
        if (depth > bestDepth) { best = live[i]; bestDepth = depth; }
      }
      if (best) return best;
      return live.length === 1 ? live[0] : null;
    }

    /** 找到某个会话 composer 的 Lexical 宿主（先缩到该会话的 composer 卡片，避免抓到别的会话）。 */
    function composerEditorOf(instance) {
      var host = null;
      var node = instance && instance.anchor;
      while (node) {
        if (typeof node.getAttribute === 'function' && node.getAttribute('data-slot') === COMPOSER_BAR_SLOT) {
          host = node;
          break;
        }
        node = node.parentNode;
      }
      if (!host) host = document;
      return host.querySelector(EDITOR_SELECTOR) || host.querySelector(EDITOR_FALLBACK) || null;
    }

    // ======================================================================
    // 五、选区 → 工具条
    // ======================================================================

    function elementOf(node) {
      if (!node) return null;
      if (node.nodeType === 1) return node;
      return node.parentElement || node.parentNode || null;
    }

    function elementInEditable(el) {
      var node = el;
      while (node) {
        if (node.isContentEditable === true) return true;
        if (typeof node.getAttribute === 'function' && node.getAttribute('contenteditable') === 'true') return true;
        node = node.parentNode;
      }
      return false;
    }

    function rectToPlain(rect) {
      return {
        top: rect.top,
        left: rect.left,
        width: rect.width || 0,
        bottom: rect.bottom !== undefined ? rect.bottom : rect.top + (rect.height || 0)
      };
    }

    /**
     * 读取当前 DOM 选区，组装成快照。
     * @returns 快照或 null（折叠/空文本/没有几何信息）。
     */
    function readSelection() {
      var selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
      var range = null;
      try { range = selection.getRangeAt(0); } catch (err) { return null; }
      if (!range) return null;

      var raw = '';
      try {
        raw = typeof range.cloneContents === 'function'
          ? extractText(range.cloneContents())
          : (selection.toString ? selection.toString() : range.toString());
      } catch (err) {
        raw = selection.toString ? selection.toString() : '';
      }
      var text = normalizeText(raw);
      if (!text) return null;

      var rects = [];
      if (typeof range.getClientRects === 'function') {
        var list = range.getClientRects();
        for (var i = 0; i < (list ? list.length : 0); i += 1) {
          var rect = list[i];
          if (rect && (rect.width || rect.bottom - rect.top)) rects.push(rectToPlain(rect));
        }
      }
      if (!rects.length && typeof range.getBoundingClientRect === 'function') {
        var box = range.getBoundingClientRect();
        if (box && (box.width || box.height)) rects.push(rectToPlain(box));
      }
      if (!rects.length) return null;

      var el = elementOf(range.commonAncestorContainer || range.startContainer);
      // 只有块级 <pre> 才算代码：行内 <code> 保持引用块，避免一个词被包成围栏。
      var preEl = el && el.closest ? el.closest('pre') : null;
      var lang = '';
      if (preEl) {
        var langSources = [];
        if (typeof preEl.querySelector === 'function') {
          var codeChild = preEl.querySelector('code');
          if (codeChild) langSources.push(codeChild);
        }
        langSources.push(preEl);
        for (var s = 0; s < langSources.length && !lang; s += 1) {
          var source = langSources[s];
          var named = String(source.className || '').match(/language-([\w+#.-]+)/);
          if (named) lang = named[1];
          else if (typeof source.getAttribute === 'function') lang = source.getAttribute('data-language') || '';
        }
      }
      var turnEl = el && el.closest ? el.closest('[data-chat-turn]') : null;
      var turn = turnEl && typeof turnEl.getAttribute === 'function'
        ? parseTurn(turnEl.getAttribute('data-chat-turn'))
        : null;

      return {
        text: text,
        rects: rects,
        el: el,
        meta: { isCode: !!preEl, lang: lang || '', turn: turn }
      };
    }

    function schedule(fn) {
      if (rafId !== null) return;
      var run = function () { rafId = null; fn(); };
      if (typeof window.requestAnimationFrame === 'function') rafId = window.requestAnimationFrame(run);
      else rafId = setTimeout(run, 0);
    }

    function evaluate() {
      if (!installed) return;
      // 结果提示期间不改动工具条：写回草稿会让光标落进 composer，
      // 那次 selectionchange 不该把「已添加到对话」当场抹掉。
      if (state.flashing) return;
      if (!config.enabled) { hideBar(); return; }
      var snapshot = readSelection();
      if (!snapshot) { hideBar(); return; }
      var el = snapshot.el;
      var insideOwnUi = !!(el && el.closest && el.closest('[' + MARK + ']'));
      var insideTranscript = !!(el && el.closest && el.closest(TRANSCRIPT_SLOT));
      var ok = shouldShow({
        enabled: config.enabled,
        hasRange: true,
        hasRects: snapshot.rects.length > 0,
        inViewport: rectsInViewport(snapshot.rects, viewportBox()),
        text: snapshot.text,
        minChars: config.minChars,
        insideEditable: elementInEditable(el),
        insideOwnUi: insideOwnUi,
        insideTranscript: insideTranscript
      });
      if (!ok) { hideBar(); return; }
      state.snapshot = snapshot;
      showBar(snapshot);
    }

    function viewportBox() {
      var width = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
      var height = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
      return { top: 0, left: 0, right: width, bottom: height };
    }

    function showBar(snapshot) {
      if (!barEl) return;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      barEl.removeAttribute('data-flash');
      // 没装侧边对话就把那条动作藏掉——不留一个点了没用的按钮。
      barEl.setAttribute('data-sidechat', sideService() ? '1' : '0');
      var size = {
        width: barEl.offsetWidth || BAR_FALLBACK_WIDTH,
        height: barEl.offsetHeight || BAR_FALLBACK_HEIGHT
      };
      var spot = placeBar(snapshot.rects, size, viewportBox(), GAP, MARGIN);
      barEl.style.left = spot.left + 'px';
      barEl.style.top = spot.top + 'px';
      barEl.setAttribute('data-placement', spot.placement);
      barEl.setAttribute('data-open', '1');
    }

    function hideBar() {
      state.snapshot = null;
      state.flashing = false;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (!barEl) return;
      barEl.removeAttribute('data-flash');
      barEl.setAttribute('data-open', '0');
    }

    function flash(message, ms) {
      if (!barEl || !flashEl) return;
      state.flashing = true;
      flashEl.textContent = message;
      barEl.setAttribute('data-flash', '1');
      barEl.setAttribute('data-open', '1');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        flashTimer = null;
        hideBar();
      }, typeof ms === 'number' && ms > 0 ? ms : 1600);
    }

    /** 滚动/缩放时若选区还在就跟着挪，选区没了就收起。 */
    function reposition() {
      if (state.flashing) return;
      if (!barEl || barEl.getAttribute('data-open') !== '1') return;
      var snapshot = readSelection();
      if (!snapshot) { hideBar(); return; }
      state.snapshot = snapshot;
      showBar(snapshot);
    }

    // ======================================================================
    // 六、动作：添加到对话 / 复制
    // ======================================================================

    function focusComposer(instance) {
      var editor = composerEditorOf(instance);
      if (!editor || typeof editor.focus !== 'function') return;
      try { editor.focus({ preventScroll: true }); } catch (err) {
        try { editor.focus(); } catch (err2) { /* 拿不到焦点不影响已写入的草稿 */ }
      }
    }

    function addToConversation() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      var payload = buildPayload(snapshot.text, config, snapshot.meta);
      if (!payload) { flash('没有可引用的内容'); return; }
      var instance = pickInstance(snapshot.el);
      if (!instance) { flash('找不到对应的输入框'); return; }
      var actions = instance.inputActions;
      if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
        flash('当前界面不支持写入输入框');
        return;
      }
      var applied = false;
      try {
        var span = actions.captureInsertion();
        applied = actions.insertText(payload, span) === true;
      } catch (err) {
        applied = false;
      }
      if (!applied) { flash('输入框正忙，稍后再试'); return; }
      flash('已添加到对话');
      focusComposer(instance);
    }

    function legacyCopy(text) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        if (area.remove) area.remove();
        flash(ok ? '已复制' : '复制失败');
      } catch (err) {
        flash('复制失败');
      }
    }

    function copySelection() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      var text = snapshot.text;
      var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      if (clipboard && typeof clipboard.writeText === 'function') {
        clipboard.writeText(text).then(
          function () { flash('已复制'); },
          function () { legacyCopy(text); }
        );
        return;
      }
      legacyCopy(text);
    }

    // ----------------------------------------------------------------------
    // 侧边提问：交给 dsh-better-sidebar 的侧边对话（可选依赖）
    //
    // 为什么是「可选依赖 + ctx.get」：侧边线程的宿主能力（继承主会话上下文、独立
    // 运行、可提升为顶层会话）由 dsh-better-sidebar 提供，本插件只做两件事——
    //   ① 用它的公开服务开一个 sidechat tab：ctx.betterSidebar.openTab({type:'sidechat'}, {sessionId})
    //      （官方 openTab 会连带把右栏展开，内容不可见就不算打开）；
    //   ② 把引用块写进那个线程的输入框。
    // 第 ② 步它没有公开 API（sidechat.start/prompt 只能「发」不能「存草稿」），
    // 所以走 DOM：它的输入框是一个标准 React 受控 <textarea>，用原生 value setter +
    // 冒泡 input 事件即可让 React 的 onChange 收到，这比伪造键盘事件可靠得多。
    // 找不到输入框时兜底：把引用放进剪贴板并明确告知，绝不让操作静默失败。
    // ----------------------------------------------------------------------

    /** 取可选服务：ctx.get 是 inject-free 读法，缺了返回 undefined 而不是抛错。 */
    function sideService() {
      if (!rootContext || typeof rootContext.get !== 'function') return null;
      var service = null;
      try { service = rootContext.get(SIDE_SERVICE); } catch (err) { service = null; }
      return service && typeof service.openTab === 'function' ? service : null;
    }

    /** 选区所属会话的 id（沿用官方自己的 data-conversation-session 读法）。 */
    function sessionIdOf(el) {
      var node = el;
      while (node && node.nodeType === 1) {
        if (typeof node.getAttribute === 'function') {
          var id = node.getAttribute(SESSION_ATTR);
          if (id) return id;
        }
        node = node.parentNode;
      }
      return null;
    }

    /** 元素是否真的可见（display:none / hidden / 零尺寸都不算）。 */
    function isElementVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.hidden) return false;
        if (node.style && (node.style.display === 'none' || node.style.visibility === 'hidden')) return false;
        node = node.parentNode;
      }
      var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      return !!(rect && (rect.width || rect.height));
    }

    /**
     * 侧边对话的输入框判定：右栏里成尺寸的 textarea。
     * 排除 xterm 的隐藏 helper textarea —— 它是 1×1 且被挪到屏幕外。
     */
    function isSideChatComposer(el) {
      if (!el || String(el.tagName || '').toUpperCase() !== 'TEXTAREA') return false;
      if (typeof el.closest === 'function' && el.closest('.xterm')) return false;
      var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (!rect || rect.width < 80 || rect.height < 14) return false;
      return isElementVisible(el);
    }

    /**
     * 找一个可用的侧边对话输入框。
     * @param before - 点开之前就存在的 textarea 列表；新出现的那个优先（那就是我们刚开的 tab）。
     * @returns textarea 或 null。
     */
    function findSideChatComposer(before) {
      var all = document.querySelectorAll('textarea');
      var fallback = null;
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i];
        if (!isSideChatComposer(el)) continue;
        if (before && before.indexOf(el) === -1) return el;
        if (!fallback && typeof el.closest === 'function' && el.closest(RIGHTBAR_SLOT)) fallback = el;
      }
      return fallback;
    }

    function sideChatSnapshotNow() {
      var all = document.querySelectorAll('textarea');
      var out = [];
      for (var i = 0; i < all.length; i += 1) out.push(all[i]);
      return out;
    }

    /** React 受控组件吃「原生 setter + input 事件」这一套；拿不到原型描述符就退回直接赋值。 */
    function setNativeValue(el, value) {
      var proto = typeof window.HTMLTextAreaElement === 'function' ? window.HTMLTextAreaElement.prototype : null;
      var descriptor = proto && typeof Object.getOwnPropertyDescriptor === 'function'
        ? Object.getOwnPropertyDescriptor(proto, 'value')
        : null;
      if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(el, value);
      else el.value = value;
    }

    /** 把引用块写进侧边对话输入框：追加在已有草稿后面，光标落到末尾。 */
    function commitSideQuote(el, payload) {
      var current = typeof el.value === 'string' ? el.value : '';
      var head = current.replace(/\s+$/, '');
      var next = head ? head + '\n\n' + payload : payload;
      setNativeValue(el, next);
      try {
        if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) { /* 事件构造失败不影响已经写进去的值 */ }
      try { if (typeof el.focus === 'function') el.focus(); } catch (err) { /* ignore */ }
      try { if (typeof el.setSelectionRange === 'function') el.setSelectionRange(next.length, next.length); } catch (err) { /* ignore */ }
      flash('已在侧边对话中引用');
    }

    function waitForSideChat(before, payload, raw, deadline) {
      if (!installed) return;
      var composer = findSideChatComposer(before);
      if (composer) { sideChatPoll = null; commitSideQuote(composer, payload); return; }
      if (Date.now() >= deadline) {
        sideChatPoll = null;
        // 兜底：引用进剪贴板，绝不静默失败。
        var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
        if (clipboard && typeof clipboard.writeText === 'function') {
          try {
            clipboard.writeText(raw).then(null, function () {
              legacyCopy(raw);
              flash('侧边对话已打开，引用已复制');
            });
          } catch (err) {
            legacyCopy(raw);
          }
        } else {
          legacyCopy(raw);
        }
        flash('侧边对话已打开，引用已复制');
        return;
      }
      sideChatPoll = setTimeout(function () {
        waitForSideChat(before, payload, raw, deadline);
      }, SIDE_POLL_MS);
    }

    function openSideChat() {
      var snapshot = state.snapshot;
      if (!snapshot) return;
      var payload = buildPayload(snapshot.text, config, snapshot.meta);
      if (!payload) { flash('没有可引用的内容'); return; }
      var service = sideService();
      if (!service) { flash('未安装 dsh-better-sidebar'); return; }

      // 右栏已经开着侧边对话就直接用，不再造一个新线程。
      var existing = findSideChatComposer(null);
      if (existing) { commitSideQuote(existing, payload); return; }

      var sessionId = sessionIdOf(snapshot.el);
      var before = sideChatSnapshotNow();
      try {
        service.openTab({ type: SIDE_TAB_TYPE }, sessionId ? { sessionId: sessionId } : undefined);
      } catch (err) {
        flash('打开侧边对话失败');
        return;
      }
      flash('正在打开侧边对话…', SIDE_WAIT_MS + 800);
      waitForSideChat(before, payload, snapshot.text, Date.now() + SIDE_WAIT_MS);
    }

    // ======================================================================
    // 七、监听器
    // ======================================================================

    function onSelectionChange() { schedule(evaluate); }

    function onMouseUp(event) {
      var target = event ? event.target : null;
      if (target && typeof target.closest === 'function' && target.closest('[' + MARK + ']')) return;
      schedule(evaluate);
    }

    function onKeyDown(event) {
      if (event && event.key === 'Escape' && barEl && barEl.getAttribute('data-open') === '1') {
        hideBar();
      }
    }

    function onViewportChange() { schedule(reposition); }

    function attachListeners() {
      document.addEventListener('selectionchange', onSelectionChange, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('touchend', onMouseUp, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', onViewportChange, true);
      window.addEventListener('resize', onViewportChange, true);
    }

    function detachListeners() {
      document.removeEventListener('selectionchange', onSelectionChange, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('touchend', onMouseUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange, true);
    }

    // ======================================================================
    // 八、会话桥：唯一一个插槽条目，只为拿 inputActions
    // ======================================================================

    /**
     * conversation.input.overlay 的常驻条目。渲染一个 display:none 的锚点，
     * 把本会话的 inputActions 和「哪个 DOM 子树是这个会话」交给工具条。
     * @param props - 会话标准工具包（含 inputActions）。
     * @returns 隐藏锚点。
     */
    function OverlayBridge(props) {
      var ref = React.useRef(null);
      var actions = props ? props.inputActions : null;
      React.useEffect(function () {
        return bindInstance(ref.current, actions);
      }, [actions]);
      return React.createElement('span', {
        ref: ref,
        'data-dsh-quote-to-chat': 'anchor',
        'aria-hidden': 'true',
        style: { display: 'none' }
      });
    }

    // ======================================================================
    // 九、生命周期
    // ======================================================================

    function install() {
      if (installed) return;
      installed = true;
      config = readConfig();
      installStyle();
      buildBar();
      attachListeners();
      exposeApi();
    }

    function dispose() {
      if (!installed) return;
      installed = false;
      detachListeners();
      if (barEl) {
        barEl.removeEventListener('click', onBarClick);
        if (barEl.parentNode) barEl.remove();
      }
      barEl = null;
      flashEl = null;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      if (sideChatPoll) { clearTimeout(sideChatPoll); sideChatPoll = null; }
      if (rafId !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      state.snapshot = null;
      removeStyle();
      if (window[GLOBAL_KEY] && window[GLOBAL_KEY].__installed) delete window[GLOBAL_KEY];
    }

    function debugState() {
      var live = liveInstances();
      return {
        open: !!(barEl && barEl.getAttribute('data-open') === '1'),
        text: state.snapshot ? state.snapshot.text : null,
        turn: state.snapshot ? state.snapshot.meta.turn : null,
        instances: live.length,
        hasActions: live.some(function (instance) { return !!instance.inputActions; }),
        sideChat: !!sideService(),
        config: { enabled: config.enabled, format: config.format, attribution: config.attribution, minChars: config.minChars }
      };
    }

    /** 调试/自动化句柄；也给 CDP 验证脚本一条不依赖真实选区的路径。 */
    function exposeApi() {
      var api = {
        __installed: true,
        version: VERSION,
        config: function () { return debugState().config; },
        setConfig: function (patch) { return writeConfig(patch); },
        state: debugState,
        show: function () { evaluate(); },
        hide: hideBar,
        instances: function () { return liveInstances().length; },
        /**
         * 绕过选区直接把文本写进当前会话草稿（自动化/排查用）。
         * @param text - 原文，按当前配置转成引用块。
         * @returns 是否写入成功。
         */
        insert: function (text) {
          var instance = liveInstances()[0];
          if (!instance || !instance.inputActions) return false;
          var payload = buildPayload(text, config, { isCode: false, lang: '', turn: null });
          if (!payload) return false;
          var span = instance.inputActions.captureInsertion();
          return instance.inputActions.insertText(payload, span) === true;
        },
        /** 侧边对话现状（真机验证与排查用）。 */
        sideChat: function () {
          var all = sideChatSnapshotNow();
          var composers = [];
          for (var i = 0; i < all.length; i += 1) if (isSideChatComposer(all[i])) composers.push(all[i]);
          return {
            available: !!sideService(),
            composers: composers.length,
            drafts: composers.map(function (el) { return el.value || ''; })
          };
        },
        __internals: {
          normalizeText: normalizeText,
          extractText: extractText,
          buildPayload: buildPayload,
          placeBar: placeBar,
          shouldShow: shouldShow,
          parseTurn: parseTurn,
          bindInstance: bindInstance,
          liveInstances: liveInstances,
          pickInstance: pickInstance,
          readSelection: readSelection,
          evaluate: evaluate,
          install: install,
          dispose: dispose
        }
      };
      window[GLOBAL_KEY] = api;
    }

    /**
     * 装载浏览器侧行为：注入样式、建工具条、装监听、注册会话桥。
     * @param ctx 客户端 root context（`inject: ['slots']` 保证 ctx.slots 存在）。
     */
    function apply(ctx) {
      rootContext = ctx || null;
      install();
      ctx.effect(function () { return dispose; }, 'quote-to-chat: toolbar, listeners, session bridge');
      ctx.slots.inject(SLOT_OVERLAY, function () {
        return ctx.slots.register(
          { name: SLOT_OVERLAY, id: PKG + ':bridge', order: 40 },
          OverlayBridge
        );
      });
    }

    exports.apply = apply;
    exports.inject = ['slots'];

    exports.__internals = {
      PKG: PKG,
      VERSION: VERSION,
      MARK: MARK,
      STYLE_TAG_ID: STYLE_TAG_ID,
      GLOBAL_KEY: GLOBAL_KEY,
      STORAGE_KEY: STORAGE_KEY,
      SLOT_OVERLAY: SLOT_OVERLAY,
      TRANSCRIPT_SLOT: TRANSCRIPT_SLOT,
      SESSION_ATTR: SESSION_ATTR,
      RIGHTBAR_SLOT: RIGHTBAR_SLOT,
      SIDE_TAB_TYPE: SIDE_TAB_TYPE,
      SIDE_SERVICE: SIDE_SERVICE,
      SIDE_WAIT_MS: SIDE_WAIT_MS,
      SIDE_POLL_MS: SIDE_POLL_MS,
      DEFAULT_CONFIG: DEFAULTS,
      CSS: CSS,
      OverlayBridge: OverlayBridge,
      normalizeText: normalizeText,
      extractText: extractText,
      quoteBody: quoteBody,
      buildPayload: buildPayload,
      placeBar: placeBar,
      shouldShow: shouldShow,
      rectsInViewport: rectsInViewport,
      parseTurn: parseTurn,
      commonContainer: commonContainer,
      bindInstance: bindInstance,
      liveInstances: liveInstances,
      pickInstance: pickInstance,
      readSelection: readSelection,
      evaluate: evaluate,
      addToConversation: addToConversation,
      openSideChat: openSideChat,
      waitForSideChat: waitForSideChat,
      commitSideQuote: commitSideQuote,
      findSideChatComposer: findSideChatComposer,
      isSideChatComposer: isSideChatComposer,
      isElementVisible: isElementVisible,
      sessionIdOf: sessionIdOf,
      sideService: sideService,
      install: install,
      dispose: dispose,
      debugState: debugState,
      readConfig: readConfig,
      writeConfig: writeConfig
    };

    return module.exports;
  }
});
