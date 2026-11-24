# omp-pix-sudo

Port of the upstream `pix-sudo` stack to omp. **The port is complete** — `src/`
contains the working extension, and `omp plugin link` loads it with `sudo_run`
registered.

Port version: **0.3.31-omp.2**

## Origin

Sources were obtained with `npm pack` and extracted unmodified. They are
vendored verbatim under `git-src/` so the port can be diffed against upstream.

| Package | Version | tarball | sha256 |
| --- | --- | --- | --- |
| `@xynogen/pix-sudo` | 0.3.31 | `xynogen-pix-sudo-0.3.31.tgz` | `483c8bc3c5bf35d67c179e37beb685d391cceca4de7558c8eb69f8c70884f7e8` |
| `@xynogen/pix-runtime` | 0.12.2 | `xynogen-pix-runtime-0.12.2.tgz` | `b8791eab460ab871dc22924fa2c6108c2d6d30e09214c64ccba4baa6fce9266e` |
| `@xynogen/pix-pretty` | 1.29.0 | `xynogen-pix-pretty-1.29.0.tgz` | `39020586deca1b81b54be7e6f107d16d4acf2e6494b0f9ae001c3908c8ced3ad` |

**Single source of truth**: this table is a projection of `upstream.json` — change
versions only there, then `scripts/sync-upstream && scripts/port --check`.
`scripts/port --check` in CI proves `src/` is exactly what the generator derives
from `git-src/` (import rewrite + deletion/replacement lists), so hand-edits to
`src/` will not survive.

`pix-pretty` was resolved from pix-sudo's `^1.19.0` range; npm picked **1.29.0**,
the current latest at vendoring time. `pix-runtime` was pinned explicitly to
0.12.2 (pix-sudo asks for `^0.12.0`).

Upstream is ahead in git but not on npm: `xynogen/pix-mono` on `main` is at pix-sudo 0.3.32 / pix-pretty 1.30.0 and 0.3.32 is not published yet, so this port deliberately tracks the npm line (0.3.31 / 1.29.0) that the sha256 column above pins — moving to 0.3.32 is a separate port.

Upstream declaration:

- pix-sudo `dependencies`: `@xynogen/pix-pretty@^1.19.0`, `@xynogen/pix-runtime@^0.12.0`
- pix-sudo `peerDependencies`: `typebox`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`
- pix-sudo manifest key: `pi` → `{ "extensions": ["src/index.ts"] }`
- pix-runtime manifest key: `pi` → `{ "extensions": ["src/extension.ts"] }`
- pix-pretty: no extension manifest key

## Licence

All three packages are **MIT**, identical text, same holder:

```
MIT License

Copyright (c) 2026 xynogen
```

`package.json#license` is `"MIT"` in all three, and the two packages that ship
their own copy also carry it verbatim in-tree: `git-src/pix-pretty/LICENSE`
and `git-src/pix-runtime/LICENSE`, byte-identical to the root `LICENSE`.
MIT permits forking, modifying and redistributing provided the copyright
and licence notice travel with the copies — which they do. Nothing in the
tree is proprietary or restricted.

## The bug being fixed

`omp plugin install npm:@xynogen/pix-sudo@0.3.31` fails with, verbatim:

```
Extension validation failed: <agent-dir>/plugins/node_modules/@xynogen/pix-sudo/src/index.ts: Failed to load extension: Export named 'createLocalBashOperations' not found in module 'omp-legacy-pi-bundled:@oh-my-pi/pi-coding-agent'.
```

Root cause: `pix-runtime@0.12.2` `src/extension.ts:1-6` (symbols on lines
3-4) imports
`createLocalBashOperations` and `createLocalPowerShellOperations` as **values**
from `@earendil-works/pi-coding-agent`. omp re-maps that specifier to its own
bundled `@oh-my-pi/pi-coding-agent`, which has never exported them. The
older `pix-runtime@0.8.4` (pinned by pix-sudo 0.3.28) imported types only and
loaded fine.

Note the reported file is `pix-sudo/src/index.ts` while the offending import
lives in `pix-runtime/src/extension.ts`; the loader surfaces the top-level
extension entry, not the module that actually failed to resolve.

## Compatibility inventory (verified against omp 18.4.10; re-proven by the 19.1.1 type gate — see Tested in)

**Broken value imports — symbol absent from omp:**

| Symbol | Imported at | omp status |
| --- | --- | --- |
| `createLocalBashOperations` | `pix-runtime/src/extension.ts:3` | absent (0 hits in omp binary, 0 in `@oh-my-pi` src) |
| `createLocalPowerShellOperations` | `pix-runtime/src/extension.ts:4` | absent (same) |
| `decodeKittyPrintable` | `pix-pretty/src/provider-picker.ts:12` | absent from omp's pi-tui barrel *when resolved directly* (exists module-private at `@oh-my-pi/pi-tui/src/keys.ts:391`, no `export`) — but see "not reachable" below |

**`decodeKittyPrintable` is not actually a blocker**, on two independent
grounds. First, `pix-pretty/src/provider-picker.ts` is **not in the import
graph** of the extension entry: walking the 72 upstream files with the real
export maps from `npm view @xynogen/pix-runtime@0.12.2 exports` and
`@xynogen/pix-pretty@1.29.0 exports` reaches 47 files, and `provider-picker.ts`
is only reachable via the `@xynogen/pix-pretty/provider-picker` subpath, which
`pix-sudo` never imports. Second, omp ships a legacy pi-tui compatibility shim
(`legacy-pi-tui-shim.ts`) that re-exports the function as
`decodePrintableKey as decodeKittyPrintable`; a runtime import under the
installed shim returns `function`. Both paths are clear.

**Value imports that resolve fine in omp:** `DEFAULT_MAX_BYTES`,
`DEFAULT_MAX_LINES`, `truncateHead` (all from pi-coding-agent);
`CURSOR_MARKER`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi`,
`SelectList`, `Input`, `Key`, `matchesKey` (pi-tui).

`CustomEditor` is **not** exported from omp's pi-coding-agent root barrel (0
hits in `src/index.ts`, and `modes/index.ts` re-exports `composer.ts`, which
does not re-export `components/`). `pix-pretty/src/chips.ts` imports it as a
value, but `chips.ts` is not in the extension's import graph either, so it never
resolves.

Type-only imports are portable and need no action: `ExtensionAPI`,
`BashOperations`, `EventBus`, `ExtensionCommandContext`, `ExtensionContext`,
`AgentToolUpdateCallback`, `AgentToolResult`, the `*ToolInput` family,
`ImageContent`/`TextContent` from `pi-ai`.

## Port status

What changed relative to `git-src/`, and why. `src/` is the port; the three
upstream trees are vendored flat (`pix-sudo` → `src/`, the other two →
`src/pix-runtime/` and `src/pix-pretty/`) and their 24 `@xynogen/*` subpath
imports were rewritten to local relative paths, so the plugin installs and
loads without pulling the upstream packages over the network.

### 1. `user_bash` block removed — `src/pix-runtime/extension.ts:25-60`

Upstream registered a `user_bash` handler so `!`-commands run in the user's own
shell (PowerShell on Windows, `$SHELL` on POSIX, zsh with rc + aliases). It is
deliberately not ported, for two independent reasons:

1. `createLocalBashOperations` / `createLocalPowerShellOperations` have no omp
   value — 0 hits in the `@oh-my-pi/pi-coding-agent` sources and 0 in the
   18.4.10 binary. The import alone is a hard loader failure.
2. Even with the factories present, the block would be a silent no-op. omp's
   `UserBashEventResult` carries only `result?: BashResult`
   (`extensibility/extensions/types.ts:1128-1131`). The
   `operations?: BashOperations` field that pi 0.84.4 evaluated when building
   its shell tool (`bash.js:230-231`) is gone, so returning `{ operations }`
   leaves `result === undefined` and omp falls back to its own default shell.

The omp authoring doc names the contract directly — `user_bash` is documented
as "override with `{ result }`" — and warns: *"Let TypeScript enforce the exact
return shape rather than returning fields intended for a different event."*
`pi.on("user_bash", () => ({ operations }))` is exactly that error.

Rebuilding the runner locally (own `child_process.spawn`) is not a valid
substitute: the handler runs on the TUI thread with a 30 s budget
(`runner.ts:86`), and on timeout omp runs the command a second time itself.

`src/pix-runtime/user-shell.ts` became unreachable and was deleted.

### 2. Tool schema moved to `pi.zod` — `src/index.ts:223`, `250`

Upstream built the `sudo_run` parameters with `import { Type } from "typebox"`.
The omp authoring doc says: *"Use pi.zod or pi.arktype for new tool schemas.
pi.typebox exists for compatibility with older extensions."*

`pi.zod` was chosen over `pi.arktype` because it is the documented default for
tool parameters, and because a runtime grep of the host sources shows
`arktype` only in the custom-tools loader and type declarations — not as an
`ExtensionAPI` member carrying the full builder surface.

The schema is built **inside the factory** (`src/index.ts:250`), not at module
level, because the builder only exists on the injected `pi` object. A
module-level constant would have to be built before the factory runs, which is
exactly what the injected-builder design rules out. `typebox` was dropped from
`peerDependencies` along with the import.

### 3. Renderers rewritten to omp's render contract — `src/index.ts:541`, `562`

This is a fourth break that the upstream bug report does not mention, found in
the ported code.

omp calls `renderCall(callArgs, renderState, theme)` and
`renderResult(result, options, theme, args)` — the options bag is the **second**
argument (`types.ts:659` and `types.ts:662`). Upstream's port declared
`(args, theme, renderCtx)`, i.e. options in the wrong position.

Worse, omp's `ToolRenderResultOptions` (`types.ts:584`) carries only
`expanded`, `isPartial` and `spinnerFrame` — there is **no `state`, no
`invalidate`, and no tool-call id**. Upstream read all three off the render
context. Since the `collapse` section defaults to `enabled: true`
(`src/pix-runtime/sections/collapse.ts:13`), that would have thrown on every
single `sudo_run` render.

The port keys a per-card `CollapseState` by the `toolCallId` observed in
`execute` (`src/index.ts:169`, `265`) and reads the flags from `options`.

### 4. Timers moved onto the managed `ctx` surface

`src/pix-pretty/gate-overlay.ts:126,283,346` — the overlay's dead-man's-switch
countdown is a managed `setInterval` now. `showOverlay` takes a third
`OverlayTimers` argument, and both call sites pass `ctx` through.

`src/pix-runtime/collapse.ts:33,54,63` — the collapse delay is a managed
`setTimeout` driven by `tickCollapse(..., timers)`.

Reason: *"Self-scheduled callbacks run in-process with no isolation. A raw
`setInterval`/`setTimeout`/detached-promise callback that throws escapes the
handler-dispatch try/catch and crashes the whole session."* Both of these fire
from UI paths, so a throw would take the session down.

The collapse timer is scheduled from a render callback, which the host invokes
outside handler dispatch and without a `ctx`. `RENDER_TIMERS`
(`src/index.ts:189`) wraps the one unavoidable raw timer in `try/catch` — the
isolation the same doc requires for raw timers used outside a handler. The
remaining raw timers in the tree are child-process kill timers and fetch
timeouts, not UI callbacks, and are left as-is.

### 5. Non-interactive guard — `src/index.ts:290`

Upstream blocked on `!ctx.hasUI` only. The port requires
`ctx.mode === "tui" && ctx.hasUI`, because the approval step is a custom
terminal overlay (`ui.custom` with a `SelectList` and a masked password input).
Both checks are needed because they fail differently: an ACP session reports
`mode === "rpc"` **with** `hasUI === true`, while print/RPC `--no-ui` reports
`hasUI === false`. The non-interactive path returns a structured result with
`isError: true` and `errorKind: "no-ui"` without drawing anything.

## Feature loss

**`!`-commands no longer use the user's own shell.** They run in omp's default
shell. Upstream's `user_shell` feature — PowerShell on Windows, `$SHELL` on
POSIX, zsh with rc and aliases — is not available, and cannot be recovered from
an extension: no omp event rewrites which shell executes a `!`-command, and
`user_bash` only accepts a finished `BashResult`.

This is the one intentional feature loss in the port. Everything else in
`sudo_run` — approval overlay, password validation, PAM ticket reuse, output
truncation, collapsed rendering — is preserved.

## Tested in

**omp 19.1.1** (2026-11-24, `0.3.31-omp.4`):

- Type gate: `bunx tsc --noEmit` against the pinned `@oh-my-pi/*@19.1.1`
  declarations → **0 errors**. This is the API contract, not a claim — three
  fields that exist only in `@earendil-works/*` (`promptSnippet`, `exposure`,
  `renderShell`) and one dead read (`options.isError`) were found and removed
  by exactly this gate (see 0.3.31-omp.2→omp.3 notes below).
- Registration: `bun test` loads `src/index.ts` through a stub host and asserts
  the `sudo_run` contract (name, `{ command, reason? }` schema, renderer hooks).
- Store-path load: `omp -p --no-session --plugin-dir <store> --tools=nope x`
  lists `sudo_run` in the registered-tools line; machine-checked in nixos_data's
  `checks.omp-pix-sudo-load` (paired: control run must NOT list it).
- Print mode → the tool returns `isError: true` with `errorKind: "no-ui"`,
  confirming the non-interactive guard.
- **TUI overlay pass** (real terminal, same day, `0.3.31-omp.3`): Allow/Deny
  modal renders, masked password input accepts keystrokes and validates, first
  `sudo_run id` returns `uid=0(root)`, an immediate repeat still shows Allow but
  skips the password, and after `sudo -K` the password prompt comes back. The
  60-second dead-man's switch and the collapsed result row were present too.
- **Session grant** (`0.3.31-omp.4`): unit-tested window/expiry/revoke
  (`test/grant.test.ts`); the three-choice overlay and the "grant skips confirm,
  password still governed by the sudo ticket" path need the same manual TUI
  pass — pick "Allow for 15 min" once, confirm the following `sudo_run` calls
  show no modal, then `sudo -K` and confirm the password prompt returns.

Earlier: verified 2026-10-02 against omp 18.4.10 (`omp plugin link` exit 0, no
loader error) and 2026-10-03 against omp 18.4.11 (**0.3.31-omp.2** below).

Ticket reset needs uppercase **`sudo -K`**: with `timestamp_type=ppid` (what
nixos_data pins) the credential cache is keyed by `u.ppid`
(`sudoers_timestamp(5)`), and lowercase `-k` only resets "the current session"
— the calling shell's own record — leaving the omp process's ticket intact.
Observed: `-k` in a terminal did not make the next `sudo_run` ask for a
password; `-K` removes every cached credential for the user regardless of
ppid (`man sudo`) and does.

## 0.3.31-omp.4 — session grant for root approval

Operating a machine means dozens of root commands in a row; one click per
command is not usable. The Allow overlay now offers three scopes:

| Choice | Effect |
| --- | --- |
| Allow once | runs this command only (previous behavior) |
| Allow for 15 min | auto-approves `sudo_run` for a **rolling** 15-minute window |
| Deny | blocks the command |

The grant is deliberately narrow (`src/grant.ts`):

- **in-memory only**, scoped to the omp process, revoked on `session_shutdown`;
- each command executed under the grant extends the window (rolling, matching
  sudo's default `timestamp_timeout` semantics);
- **it never widens authentication** — `hasValidTicket()` still runs on every
  call, so `sudo -K` or ticket expiry brings the password prompt back while the
  grant is live. The grant only removes the per-command *confirmation*;
- nothing is written to disk and there is no config switch: a human picks it
  per session, in the overlay;
- when the grant is live and the ticket is still valid, the command runs
  without any modal; when the ticket is gone, only the password stage shows.

Overlay plumbing: `OverlayResult.choice` + `approveValues` let one approval
carry a scope, so "Allow once" and "Allow for 15 min" stay distinguishable.

## 0.3.31-omp.3 — host-version gate, dead code, NixOS integration

- **Type gate against the pinned host** (`@oh-my-pi/*@19.1.1`, same version as
  the store binary): removed `promptSnippet` / `exposure` / `renderShell`
  (fields only `@earendil-works/*` declares — omp's `ToolDefinition` has none
  of them) and the `options.isError` render read (omp forwards the error flag
  on the *result*, `tool-execution.ts:1991`, so the old read was always
  `undefined` — non-`sudoResult` error cards kept their error framing via
  `result.isError` now).
- **`yolo` / `afk` deleted**: `getUnattendedMode` read a WeakMap nothing ever
  wrote, so `mode` was always `"off"` — the branches were unreachable, and
  omp's `tools.approvalMode` was never read. Behavior on this machine was
  already "every root command shows Allow, with password skipped on a cached
  ticket"; now the code says so. `withAgentBlock` / `beginAgentBlock` /
  `herdr-notify` stay (the blocked-state bridge is used).
- **`agentDir()` fix**: falls back to `~/.omp/agent` when it exists (omp sets
  `PI_CODING_AGENT_DIR` only with profiles). `/pix` state now lands where omp
  reads it instead of `~/.pi/agent`.
- **sudo hardening**: `catalog.ts` gains `knownPaths` with NixOS's
  `/run/wrappers/bin/sudo` (PATH often stripped under systemd/sanitized
  wrappers), a matching install hint, a 5 s cap on the `sudo -n true` ticket
  probe, and a distinct `errorKind: "no-binary"` so "sudo not found" no longer
  masquerades as "authentication failed".
- **SSOT tooling**: `upstream.json` (name/version/tarball/sha256) +
  `scripts/sync-upstream` (download, verify, extract) + `scripts/port`
  (git-src → src with import rewrite and an explicit deletion/replacement
  list) and `scripts/port --check`, which proves `src/` is exactly derived.
  24 files unreachable from the load closure were removed (71 → 47 TS files).
- **flake.nix**: store package (src + package.json + LICENSE), bun-only
  devShell, version derived from package.json.

## 0.3.31-omp.2 — runtime fixes

`0.3.31-omp.1` shipped a port that loaded and registered cleanly, so the bugs
below were invisible to every check that version was verified with. They were
found by driving the real renderers through a replica of omp's own render-call
convention, and by auditing the tool against the 18.4.11 host source.

### 1. Cards never collapsed — `src/index.ts`

The port keyed its per-card render state on `options.toolCallId`, and its own
comment already recorded that the host forwards no call id. It did not:

- `ToolRenderResultOptions` (`types.ts:637`) carries only `expanded`,
  `isPartial`, `spinnerFrame`.
- `RegisteredToolAdapter` rebuilds a **fresh three-key literal** for every
  `renderResult` (`wrapper.ts:96`).
- Its `renderCall` proxy forwards any property that is not an own key of that
  literal to the **live `Theme`**, which has no `toolCallId` (`wrapper.ts:43-55`).

So `toolCallId` was always `undefined`, every render minted a *fresh* state
bag, and with it: `state.collapsed` never latched, the call row was never
hidden, and `tickCollapse` re-armed a 10s timer on **every repaint** of every
settled card. The collapse feature — the point of the vendored `collapse`
section — was dead, and leaked one `Map` entry plus one live interval per
repaint for the life of the process.

The card's per-call `args` object *is* stable: `ToolExecutionComponent` holds
one `#args`, and `#getCallArgsForRender()` returns that same reference for
non-edit tools (`tool-execution.ts:1652-1656`). The state bag is now a
`WeakMap` keyed on it, so each card keeps one bag across repaints and the
entry is collected with the card.

### 2. Denied and cancelled root requests were reported as success

The denial, timeout and cancel branches returned a result with no `isError`
key, which the host reads as falsy (`wrapper.ts:479` —
`result.isError ?? !!executionError`). Pressing **Deny** told the model the
call succeeded, so it would report the task done. Both branches now set
`isError: true`; a blocked request must read as a failure.

### 3. Abort listener leaked per call — `src/lib.ts`

`spawnSudo` registered an `{ once: true }` abort listener that was never
removed on the normal path, so every `sudo_run` left a listener on the caller's
signal holding that child's handle for the rest of the session. The listener is
now detached when the promise settles, and an already-aborted signal short
circuits before the call proceeds.

## Installation

**Declarative (NixOS, the supported path)** — the plugin is a nix package and
omp loads it from a store path via `~/.omp/agent/config.yml`:

```nix
# nixos_data/flake.nix inputs:
omp-pix-sudo.url = "tarball+https://codeload.github.com/daiaji/omp-pix-sudo/tar.gz/refs/tags/v0.3.31-omp.4";
# nixos_data/omp-pix-sudo.nix: home-manager writes config.yml with
#   extensions: [ "${inputs.omp-pix-sudo.packages.<system>.default}/share/omp-pix-sudo/src/index.ts" ]
```

No bun, no `omp plugin link`, no writes to `~/.omp/plugins`. Rollback =
change the flake input's tag → `nixos-rebuild switch`; load health is
machine-checked by `checks.omp-pix-sudo-load` (`just verify <host>` step 3
in nixos_data).

From Git (manual, legacy):

```bash
omp install github:daiaji/omp-pix-sudo#v0.3.31-omp.4
```

Use an immutable tag or commit for reproducible installs — the release tag
above is the ref this line points at. `main` will move.

**`omp install` needs `bun` on `PATH`.** omp installs plugins by running
`bun install` in the plugins directory (`installer.ts:48`), so without bun it
fails with:

```
Failed to install <spec>: Error: Executable not found in $PATH: "bun"
```

This is omp asking for its own tooling, not a fault in this plugin — the
extension never invokes bun at runtime, and `omp plugin link` loads it
without bun present. Install bun (any recent version) and the install path
works.

Local, from a checkout — clone, then link the working copy so edits take effect
without reinstalling:

```bash
git clone https://github.com/daiaji/omp-pix-sudo.git
cd omp-pix-sudo
omp plugin link "$PWD"
```

`omp plugin link` takes a path to a directory; `"$PWD"` is whatever the clone
ended up as, so the three lines above run as-is wherever you start them.

Extension factories are initialised at session startup. After changing
`src/index.ts`, exit and start a new session to load the new code — there is no
hot reload.

## Layout

```
omp-pix-sudo/
  LICENSE                 upstream MIT (pix-sudo)
  README.md               this file
  package.json            omp plugin manifest
  git-src/                upstream sources, unmodified, for diffing
    pix-sudo/
    pix-runtime/
    pix-pretty/
  src/                    the port
    index.ts              extension entry (pix-sudo)
    lib.ts                sudo runner + helpers
    pix-runtime/          vendored pix-runtime 0.12.2, ported
    pix-pretty/           vendored pix-pretty 1.29.0, ported
```
