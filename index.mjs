// dsh-quote-to-chat — host half.
//
// Intentionally inert. Every behaviour of this plugin (the floating toolbar
// over a text selection, the 「添加到对话」 action and its write into the
// composer draft) lives in the browser half, lib/client.js.
//
// Why a host half exists at all: the DSH client-modules scanner only publishes
// a browser bundle for packages that are *enabled Loader entries*
// (cordis.patch.yml below). There is no host-only-free client plugin.
//
// Persistence note: this version stores its small config in the browser's
// localStorage (`dsh.quote-to-chat.v1`), matching the official sidebar-right /
// conversation view-state precedent. To make the config survive a browser
// switch, give the entry below a `Config` with one `.volatile()` JSON string and
// read it from the browser half through `ctx.configForms.get('quote-to-chat')`;
// the client half funnels every read/write through `readConfig`/`writeConfig`,
// so that swap stays local to lib/client.js.

const name = 'quote-to-chat'
const inject = []

/**
 * Report that the host half is composed; the browser half does the work.
 * @param ctx Host plugin context.
 */
function apply(ctx) {
  ctx.logger.info(
    'dsh-quote-to-chat: host half is inert; lib/client.js renders the selection toolbar'
  )
}

export { apply, inject, name }
