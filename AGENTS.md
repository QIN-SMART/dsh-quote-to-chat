# dsh-quote-to-chat — agent 约定

**DSH 客户端插件**：在对话正文里选中文字 → 浮动工具条（添加到对话 / 侧边提问 / 复制）。
仓库根就是 npm 包根（`package.json` 在第一层），浏览器侧行为全在 `lib/client.js`。
给任何编码 agent（Codex / Claude Code / Cursor / DSH 自身）读；动手前先扫下面的硬约束。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | 清单：`dsh.bundle.patch`、`dsh.client.platform`、`exports["./client"]`、`icon`、`exports["./locale/*.json"]` |
| `cordis.patch.yml` | 一行 `insert`，让本包成为 enabled 的 Loader entry |
| `index.mjs` | 宿主半边，故意惰性（只为让浏览器半边被加载） |
| `lib/client.js` | **全部行为**：选区识别、工具条、写回 composer、侧边提问 |
| `test/verify.mjs` | 离线断言：真实 bundle + mock DOM，零依赖 |
| `tools/real-ui-check.mjs` | CDP 驱动真实 GUI 的端到端断言（**产物是真实界面截图，已 gitignore，别提交**） |
| `tools/publish-to-github.mjs` | 走 GitHub REST API 发布（空仓库自动引导；`--release` 打 tag + 建 Release） |
| `demo/quote-mock.html` | 合成数据的演示页 —— README 里的截图由它生成 |
| `docs/verify-*.png` | 合成数据的截图（可入库）；`docs/real-ui*.png` 是真实界面截图（**禁入**） |

## 关键标识（改名/重构时必须一起改）

| 项 | 值 |
|---|---|
| `ModuleLoader.load({ id })` | `dsh-quote-to-chat`（**必须等于 package.json 的 name**） |
| 调试全局 | `window.__dshQuoteToChat` |
| 持久化 | `localStorage['dsh.quote-to-chat.v1']`（白名单字段，坏数据回落默认） |
| 样式表标记 | `data-plugin` / `data-plugin-css="dsh-quote-to-chat/style"` |
| 用到的插槽 | `conversation.input.overlay`（一个 `display:none` 锚点，只为拿该会话的 `inputActions`） |
| 稳定 DOM 钩子 | `[data-slot="conversation.session"]`、`[data-slot="conversation.composer.bar"]`、`[data-chat-turn]`、`[data-conversation-session]`、`div[contenteditable="true"][role="textbox"]` |

## 硬约束

1. 客户端模块**平铺导出** `exports.apply` / `exports.inject`，**绝不 `export default`**（`inject` 会静默丢失）。
2. 凡读 `ctx.<service>` 必须先写进 `inject`；**可选依赖**（`betterSidebar`）用 `ctx.get('betterSidebar')`。
3. 不碰构建期哈希类名；只用上表里的 `data-*` / role / slot 钩子。
4. 工具条材质必须**铺在不透明应用层色上**（原生 `--dsw-specific-menu` 只有 58% 不透明，浮在密集正文上会互相穿透）——这是本插件最容易被改坏的不变量，`test/verify.mjs` 里有断言。
5. 写 composer 必须走 `inputActions.captureInsertion()` + `insertText()`（带 `draftRev`），不要直接改 DOM；返回 `false` 说明草稿已变，别硬写。
6. 浮层挂 `document.body`，卸载时移除；`ctx.effect` 的 dispose 要清干净（监听、observer、定时器、工具条节点、剪贴板提示、调试全局）。
7. 「侧边提问」等不到输入框时**必须**退回剪贴板 + 明确提示，绝不静默失败；没装依赖时整条动作隐藏。
8. 改完必须 `node --test test/verify.mjs` 全绿；真实界面用 `node tools/real-ui-check.mjs` 验一次。

## 常用命令

```sh
node --test test/verify.mjs                          # 离线断言（零依赖）
node tools/real-ui-check.mjs                         # 真机断言（自动读启动 token；产物已 gitignore）
GH_TOKEN=<PAT> npm run publish:github -- --release   # 推 GitHub + 打 tag + 建 Release
npm publish                                          # 发 npm（已配 bypass-2FA 令牌，无需 OTP）
```

更完整的契约、踩坑库与验收清单见 DSH 的 `dsh-plugin-authoring` skill
（本机 `~/agent-shared/skills/dsh-plugin-authoring/`）。

## 隐私红线

`docs/real-ui*.png` 拍的是**真实会话**（真实标题与正文）—— 永久排除在仓库之外。
README 只使用 `demo/quote-mock.html` 生成的合成截图。提交前扫一遍：
`grep -rn "/Users/\|/home/" --exclude-dir=.git . && ls docs/ | grep real-ui`
