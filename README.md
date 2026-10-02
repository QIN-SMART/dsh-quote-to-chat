# dsh-quote-to-chat

在 DSH Web GUI 里**选中回复中的一段文字 → 弹出浮动工具条**：把片段作为引用块写进输入框草稿、就这段内容开一个侧边线程，或直接复制。就像 Codex / ChatGPT 桌面端那种选中文本后的操作条。

![选中后弹出工具条](docs/verify-light.png)

[English](README_EN.md) · 零运行时依赖 · 自测零依赖（`node --test`）

![verify](https://github.com/QIN-SMART/dsh-quote-to-chat/actions/workflows/verify.yml/badge.svg)

## 安装

```sh
# 从 GitHub 装（推荐）
dsh plugin --profile web add github:QIN-SMART/dsh-quote-to-chat

# 从 npm 装（发布后）
dsh plugin --profile web add dsh-quote-to-chat
```

装完刷新一次浏览器页面即可，不需要重启 dsh web。

开发本仓库时用本地链接（路径换成你自己的克隆位置）：

```sh
git clone https://github.com/QIN-SMART/dsh-quote-to-chat
dsh plugin --profile web add "link:$PWD/dsh-quote-to-chat"
```

**可选依赖**：[`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) 提供侧边对话线程。没装它时「侧边提问」整个动作自动隐藏，其余功能不受影响。

## 用法

| 操作 | 结果 |
|---|---|
| 在对话正文里选中一段文字 | 选区上方弹出 `添加到对话 \| 侧边提问 \| 复制` |
| 点**添加到对话** | 草稿插入 `> 选中内容` + 一个空行；光标回到输入框；工具条提示「已添加到对话」 |
| 点**侧边提问** | 右栏展开一个侧边对话线程（继承当前会话上下文），引用预填进它的输入框、光标在末尾，接着写问题回车即可 |
| 点**复制** | 选中原文进剪贴板，提示「已复制」 |
| Escape / 点别处 / 滚动到选区失效 | 工具条收起 |
| 在输入框里选中文字 | **不弹**（避免自己跟自己打架） |
| 选中的是代码块 | 自动写成 ` ```lang ` 围栏，不塞进引用块 |
| 选中的是普通段落 | 写成 `> 每行` 的 blockquote；多段选中按块级换行还原 |
| 没装 `dsh-better-sidebar` | 「侧边提问」这一条**整条隐藏**，不留点了没用的按钮 |

工具条用 DSH 原生菜单材质（`--dsw-specific-menu` + `--dsw-menu-backdrop-filter` + `--dsw-elevation-prominent`），浅色/深色主题自动跟随：

点「添加到对话」后，草稿里出现引用块，光标回到输入框：

![引用块落进草稿](docs/verify-composer.png)

![深色主题](docs/verify-dark.png)

## 为什么不是直接照抄原生菜单的 58% 透明

原生菜单的填充色 `--dsw-specific-menu` 只有 **58% 不透明**（浅色 `#f8f9fa94`、深色 `#43454a73`）。那是给「浮在平面背景上的下拉菜单」设计的；而选区工具条恰恰浮在**密集正文**上，单独用它当底会让前后两层互相穿透 —— 第一版就是这个毛病，实测计算值：

```
第一版：background-color = rgba(248, 249, 250, 0.58)   ← 正文笔画直接压在标签上
```

theme 里其实有一个 94% 的 macOS 版本（`#f8f9faf0`），但它的选择器是 `html[data-platform=darwin] body`，而这个构建**从不设置 `data-platform`**（实测 `html` 与 `body` 上都没有该属性）—— 那条规则是死代码，原生菜单自己也没吃到。

现在的做法：把原生填充铺在**一层不透明的应用层色**上。

```css
background-color: var(--dsw-alias-bg-layer-1, #fff);
background-image: linear-gradient(var(--dsw-specific-menu, …), var(--dsw-specific-menu, …));
backdrop-filter: var(--dsw-menu-backdrop-filter, none);   /* 保留，将来填充变透可自动回落 */
```

色相仍是原生菜单色（浅色合成 ≈ `#fbfbfc`，深色 ≈ `#313235`），但任何内容都不会再透上来。实测计算值变成 `background-color = rgb(255,255,255)`（alpha = 1）+ 一层 58% 的原生填充，命中测试栈顶是插件、下一层才是对话正文 —— 两层都清楚。

## 「侧边提问」是怎么接的

DSH 本体没有侧边线程，`dsh-better-sidebar` 提供 Codex 风格的「侧边对话」。所以这一条做成**可选依赖**：

1. **开线程**走它的公开服务：`ctx.get('betterSidebar').openTab({ type: 'sidechat' }, { sessionId })`。用 `ctx.get` 而不是 `inject`，是 DSH 里读「可选依赖」的正确姿势（缺了返回 `undefined`，不会抛）。右栏已经开着侧边对话时**复用它**，不为每次点击都造新线程。
2. **写引用**走 DOM：它的输入框是标准 React 受控 `<textarea>`，用原生 value setter + 冒泡 `input` 事件让 React 的 `onChange` 收到（比伪造键盘事件可靠）。它没有公开的「存草稿」API（`sidechat.start/prompt` 只能发消息），而自动替用户发一条消息会凭空烧掉一个回合。
3. **兜底**：5 秒内等不到输入框（比如 tab 类型被关掉了），就把引用放进剪贴板 + 明确提示「侧边对话已打开，引用已复制」—— 绝不静默失败。

判定输入框时排除了 xterm 的 helper `<textarea>`（1×1、挪到屏幕外）与隐藏 tab 里的元素，所以不会把终端输入框当成侧边对话。

## 结构

```
package.json        dsh.bundle.patch + dsh.client.platform=web；ModuleLoader id 必须等于包名
cordis.patch.yml    启用一个 Loader 条目（客户端 bundle 只对启用的条目发布）
index.mjs           宿主半边：惰性，只打一行日志
lib/client.js       全部行为：选区识别、工具条、写回 composer、侧边提问
test/verify.mjs     离线断言（真实 bundle + mock DOM）
tools/real-ui-check.mjs  真机断言（CDP + 无头 Chrome + 真实 GUI）
docs/               合成数据的截图
```

浏览器半边只注册**一个**插槽条目：`conversation.input.overlay` 里一个 `display:none` 锚点 `span`。它的唯一作用是拿到该会话的 `inputActions`，并把「哪个 DOM 子树属于这个会话」交给工具条 —— 浮层本体是纯 DOM，直接挂 `document.body`。选中哪个会话的文本就写回哪个会话的输入框（多会话并存时按「最近的共同容器」判定，无法唯一确定时宁可提示「找不到对应的输入框」也不写错地方）。

## 落地依据（全部来自 DSH 0.2.0-rc.1 的真实契约）

| 能力 | 依据 |
|---|---|
| 消息正文可选中 | `dsh-client-ui-chat` bundle 里 `user-select:none` 只出现在一处；正文是普通 DOM 文本 |
| 不与现有功能撞车 | 该 bundle 里 `getSelection` / `selectionchange` 出现 **0 次** —— 原生没有任何选区弹层 |
| 能拿到「写入输入框」的正式 API | `ui-conversation` 装配时 `ctx.uiSession.provide({ hooks:['conversation','input'], props:['inputActions'] })`，每个会话 scope 的插槽组件都会收到 `inputActions` |
| 插入语义 | `inputActions.captureInsertion()` 给出带 `draftRev` 的位置；`insertText(text, span)` 落到 Lexical；`draftRev` 不匹配或正在提交时返回 `false`（不会破坏草稿） |
| 会话归属 | 消息节点带 `data-chat-turn`；正文容器是 `[data-slot="conversation.session"]`；composer 是 `[data-slot="conversation.composer.bar"]`；Lexical 宿主固定输出 `div[contenteditable="true"][role="textbox"]` —— 全程不碰构建期哈希类名 |
| 浮层 portal | 官方 `dsh-client-ui-message-feedback` 的浮层注释写明 Modal 与 Toast 都 portal 到 `document.body` |
| 选区属于哪个会话 | `data-conversation-session`（ui-conversation 自己的 Escape 处理就是这么取的） |
| 右侧栏自动展开 | `ctx.sidebarRight.openTab` 的契约：「内容用户看不见就不算打开」，开 tab 与展开右栏是同一步 |

## 配置

界面里没有设置项（保持克制）。调试句柄：

```js
__dshQuoteToChat.config()                                  // { enabled, format, attribution, minChars }
__dshQuoteToChat.setConfig({ format: 'plain' })            // auto | quote | fenced | plain
__dshQuoteToChat.setConfig({ attribution: true })          // 引用块后补一行「（引用自第 N 轮回复）」
__dshQuoteToChat.setConfig({ minChars: 0 })                // 少于 N 字符不弹
__dshQuoteToChat.setConfig({ enabled: false })             // 整体关掉
__dshQuoteToChat.state()                                   // { open, text, turn, instances, hasActions, sideChat, config }
__dshQuoteToChat.insert('一段话')                           // 绕过选区直接写引用（自动化用）
__dshQuoteToChat.sideChat()                                // { available, composers, drafts }
```

配置存 `localStorage['dsh.quote-to-chat.v1']`，白名单字段，坏数据一律回落默认值。

## 验证

```sh
node --test test/verify.mjs          # 离线断言：模块形状、材质不变量、引用格式化、
                                     # 定位与七类不弹条件、多会话归属、三个动作、侧边对话各分支、dispose
node tools/real-ui-check.mjs         # 真机断言：CDP 驱动真实 GUI（真实选区、真实写回），自动读启动 token
```

真机检查覆盖：client bundle 是否出现在启动图、插件是否 materialize、会话桥是否拿到 `inputActions`、真实选区能否弹出、材质 alpha 是否 = 1（浅色/深色）、命中测试栈顺序、草稿是否逐字节一致、侧边线程是否真的开出且引用已预填、以及脚本自己开出来的 tab 是否被清理干净。

## 已知边界

- **侧边提问依赖 `dsh-better-sidebar`**：没装时该动作自动隐藏。写草稿走它的输入框 DOM（它没有公开的 draft API），它若大改输入框实现，这一条会退化成「剪贴板兜底」而不是静默失败。
- **列表项、表格等非段落结构**：选中后按块级换行还原，不补 `- ` / `|` 之类的结构标记（DSH 用 CSS 画列表符号，DOM 里没有字符）。
- **只覆盖对话正文**：侧边栏、文档预览、轨迹视图里选中不弹（刻意的克制）。
- **引用是纯文本**：不是 DSH 的原子引用 chip（那需要 `ctx.inputTriggers` 注册 source + 宿主侧 `serializeReference`）。
- **只支持 Web**：`dsh.client.platform = web`。

## 后续可以加

1. 把选中片段做成原子引用 chip（`ctx.inputTriggers` + 宿主 `serializeReference`），可点击预览、可整体删除。
2. 侧边提问反过来：右栏已开着某个侧边线程时，给一个「提升为顶层会话」的快捷键。
3. 选区来源标注（`data-chat-turn` 已经有了，只差一个默认开关）。
4. 配置上移到宿主 `Config`（`ctx.configForms.get('quote-to-chat')`），跨浏览器同步。

## 卸载

```sh
dsh plugin --profile web remove dsh-quote-to-chat
```

## License

MIT — 见 [LICENSE](LICENSE)。
