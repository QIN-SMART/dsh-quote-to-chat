# dsh-quote-to-chat

Select text in a DSH reply and a **floating toolbar** appears: quote the fragment into your composer draft, open a side chat about it, or just copy it. The kind of action bar Codex and the ChatGPT desktop app show on selection.

![The toolbar on selection](docs/verify-light.png)

[中文说明](README.md) · no runtime dependencies · the self test needs nothing but Node

![verify](https://github.com/QIN-SMART/dsh-quote-to-chat/actions/workflows/verify.yml/badge.svg)

## Install

```sh
# from GitHub (recommended)
dsh plugin --profile web add github:QIN-SMART/dsh-quote-to-chat

# from npm, once published
dsh plugin --profile web add dsh-quote-to-chat
```

Then reload the browser page.

**Optional dependency**: [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) provides side-chat threads. Without it the "ask in a side chat" action is hidden entirely and everything else keeps working.

## Usage

| Action | Result |
|---|---|
| Select text in a reply | `Add to chat \| Ask in a side chat \| Copy` appears above the selection |
| **Add to chat** | Inserts `> selected text` plus a blank line into the draft, returns focus to the composer, confirms with "added" |
| **Ask in a side chat** | Expands the right sidebar with a side-chat thread (inheriting the session context) and pre-fills the quote there, cursor at the end |
| **Copy** | Copies the selection |
| Escape / click away / scroll | Toolbar closes |
| Selecting inside the composer | **Nothing appears** (the toolbar never fights itself) |
| Selection is a code block | Quoted as a ` ```lang ` fence instead of a blockquote |
| Selection is prose | `> line` blockquote; multi-paragraph selections keep block breaks |
| `dsh-better-sidebar` missing | The action is **hidden entirely**, never a dead button |

The toolbar uses the native DSH menu material (`--dsw-specific-menu`, `--dsw-menu-backdrop-filter`, `--dsw-elevation-prominent`) and follows the light/dark theme:

After **Add to chat** the draft holds the quote and focus is back in the composer:

![Quote inserted into the draft](docs/verify-composer.png)

![Dark theme](docs/verify-dark.png)

## Why not simply the native menu's 58% transparency

The native menu fill (`--dsw-specific-menu`) is only **58% opaque** (light `#f8f9fa94`, dark `#43454a73`). That is designed for a dropdown floating over a flat surface; a selection toolbar floats over **dense body text**, so using it alone lets the two layers bleed into each other. The first version had exactly that bug:

```
v1: background-color = rgba(248, 249, 250, 0.58)   ← glyphs pressed straight through the labels
```

The theme ships a 94% variant (`#f8f9faf0`) but its selector is `html[data-platform=darwin] body`, and this build **never sets `data-platform`** — that rule is dead code the native menu does not benefit from either.

The fix: lay the native fill over one opaque application-layer colour.

```css
background-color: var(--dsw-alias-bg-layer-1, #fff);
background-image: linear-gradient(var(--dsw-specific-menu, …), var(--dsw-specific-menu, …));
backdrop-filter: var(--dsw-menu-backdrop-filter, none);   /* kept, so a future translucent fill degrades gracefully */
```

The hue is still the native menu colour (light ≈ `#fbfbfc`, dark ≈ `#313235`) but nothing shows through, and `elementsFromPoint` reports plugin, then plugin, then transcript.

## How the side chat is wired

DSH itself has no side threads; `dsh-better-sidebar` adds Codex-style side chats, so the action is an **optional dependency**:

1. **Open the thread** through its public service: `ctx.get('betterSidebar').openTab({ type: 'sidechat' }, { sessionId })`. `ctx.get` rather than `inject` is the correct way to read an optional dependency in DSH (missing returns `undefined` instead of throwing). An already-open side chat is reused rather than spawning a new thread per click.
2. **Write the quote** through the DOM: its composer is a plain React-controlled `<textarea>`, so a native value setter plus a bubbling `input` event reaches `onChange` (more reliable than synthesised key events). It exposes no draft API — `sidechat.start/prompt` can only send a message — and sending on the user's behalf would silently burn a turn.
3. **Fallback**: if no composer appears within five seconds, the quote goes to the clipboard with an explicit notice. It never fails silently.

Composer detection excludes xterm's helper `<textarea>` (1×1, off-screen) and elements in hidden tabs, so a terminal input is never mistaken for a side chat.

## Layout

```
package.json        dsh.bundle.patch + dsh.client.platform=web; the ModuleLoader id must equal the package name
cordis.patch.yml    enables one Loader entry (client bundles are only published for enabled entries)
index.mjs           the inert host half
lib/client.js       everything: selection detection, toolbar, composer write-back, side chat
test/verify.mjs     offline assertions (real bundle + mock DOM)
tools/real-ui-check.mjs  real-GUI assertions (CDP + headless Chrome)
docs/               screenshots built from synthetic data
```

The browser half registers exactly **one** slot: an invisible anchor `span` in `conversation.input.overlay`. Its only job is to obtain that session's `inputActions` and to hand the toolbar the DOM subtree that belongs to the session; the overlay itself is plain DOM attached to `document.body`. Text selected in a session is written back to that session's composer, and when the owner cannot be determined uniquely the plugin says so instead of writing into the wrong draft.

## Evidence (all from the real DSH 0.2.0-rc.1 contract)

| Capability | Evidence |
|---|---|
| Reply text is selectable | `user-select:none` appears once in the chat bundle; the transcript is ordinary DOM text |
| No collision | `getSelection` / `selectionchange` appear **0 times** in that bundle — nothing native reacts to selections |
| Official way to write the composer | `ui-conversation` runs `ctx.uiSession.provide({ hooks:['conversation','input'], props:['inputActions'] })`, so every session-scoped slot component receives `inputActions` |
| Insert semantics | `inputActions.captureInsertion()` yields a draft revision; `insertText(text, span)` lands in Lexical; a stale revision or an in-flight submit returns `false` instead of corrupting the draft |
| Session ownership | `data-chat-turn` on message nodes, `[data-slot="conversation.session"]`, `[data-slot="conversation.composer.bar"]`, and Lexical's stable `div[contenteditable="true"][role="textbox"]` — no build-time hashed class names anywhere |
| Overlay portal | the official message-feedback overlay documents that modals and toasts portal to `document.body` |
| Which session a selection belongs to | `data-conversation-session`, the same attribute ui-conversation's own Escape handler reads |
| Right sidebar opens itself | `ctx.sidebarRight.openTab`'s contract: content the user cannot see does not count as open |

## Configuration

There is no settings UI (deliberately restrained). Debug handles:

```js
__dshQuoteToChat.config()                                  // { enabled, format, attribution, minChars }
__dshQuoteToChat.setConfig({ format: 'plain' })            // auto | quote | fenced | plain
__dshQuoteToChat.setConfig({ attribution: true })          // append "（引用自第 N 轮回复）"
__dshQuoteToChat.setConfig({ minChars: 0 })                // do not open below N characters
__dshQuoteToChat.setConfig({ enabled: false })             // disable entirely
__dshQuoteToChat.state()                                   // { open, text, turn, instances, hasActions, sideChat, config }
__dshQuoteToChat.insert('a paragraph')                     // quote without a selection (automation)
__dshQuoteToChat.sideChat()                                // { available, composers, drafts }
```

State lives in `localStorage['dsh.quote-to-chat.v1']`, whitelisted fields only, with defaults on corrupt data.

## Verify

```sh
node --test test/verify.mjs          # module shape, material invariants, quote formatting, placement,
                                     # seven no-show conditions, session ownership, the three actions,
                                     # every side-chat branch, dispose
node tools/real-ui-check.mjs         # CDP against the real GUI: real selection, real write-back
```

The real-GUI pass checks that the client bundle is in the boot graph, that the plugin materialised, that the session bridge has `inputActions`, that a real selection opens the toolbar, that the material's alpha is 1 in both themes, the hit-test stack order, byte-exact drafts, that the side thread really opens with the quote pre-filled, and that any tab it opened is cleaned up again.

## Known limits

- **The side chat depends on `dsh-better-sidebar`**; without it the action hides. Draft writing goes through that plugin's composer DOM (it has no public draft API), so a rewrite of its composer degrades this to the clipboard fallback rather than failing silently.
- **Lists and tables** are reconstructed with block breaks, without adding `- ` or `|` markers (DSH draws list markers in CSS; the characters are not in the DOM).
- **Transcript only**: no toolbar in the sidebar, document previews or the trajectory view.
- **Quotes are plain text**, not DSH reference chips (that needs `ctx.inputTriggers` plus a host `serializeReference`).
- **Web only**: `dsh.client.platform = web`.

## License

MIT — see [LICENSE](LICENSE).
