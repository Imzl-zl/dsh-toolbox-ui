# The lifecycle of project-level MCP: why it is the way it is

[中文](project-mcp-lifecycle.md) | **English**


This record answers three things: **what we promise**, **what the basis is** (the original text of the host and the MCP spec, not our preferences), and **what was rejected** (with evidence, to avoid re-arguing it later).

## The one-sentence invariant

> The config is the single source of truth: whatever `<project>/.dsh/mcp.json` says, **the project's next model request** must see the corresponding tool set; the connection's lifecycle follows the config, not the session.

## Basis (the host's own contracts, each item verifiable)

| Contract | Source location | What it requires of this plugin |
|---|---|---|
| Tools must appear before the first turn | `packages/mcp/mcp-client/README.md:91` | Mounting must wait for readiness (with a budget); "not connected yet" must not be left to the first turn |
| During a disconnect, tools stay listed and calls fail | same file `:93` | Do not withdraw tools on session end or a brief disconnect |
| Reconnect budget exhausted → unregister tools and stop; needs config reload / restart | same file `:93` | There must be an "on-demand rebuild" exit; the user must not have to restart the host |
| Editing a config entry = reload the connection in place, names unchanged | same file `:93` | Config changes must reload immediately, not "wait for all sessions to end" |
| The tool name is a pure function of `(serverName, rawName)` | same file `:107` | In-place reload is safe for session history / permission rules |
| Entries are configured by **intended scope**; the same name can be reused across different Agent scopes | `docs/subsystems/mcp.md:24,45` | Project scope holds one connection, reused by multiple sessions |
| Register for a single session → use `agent.ctx` | `docs/architecture.md:164` | Per-session projection is the **officially designated** approach |
| The creation transaction awaits the serial `agent/created` listener before releasing the input | `packages/core/agent-loop/README.md:111`, `src/index.ts:624` | The mount point is chosen on `agent/created`, and being in place before the first turn is guaranteed by contract |
| A throwing listener vetoes creation | `packages/core/agent/src/index.ts:532-559` | The mount path must swallow its own errors and only keep accounts; it must never block the session |
| The scope parent chain has a single slot, binding is one-shot, multi-ownership is unsupported | `packages/core/scope/README.md:73,102` | Do not try to insert the project scope into the session chain |

The MCP spec fills in the connection semantics: a session is closed only when the client "no longer needs" it (e.g. the user is leaving the client application); when an HTTP session expires, the server returns 404 and the client MUST re-initialize; the tool set is maintained by `tools/list` + `notifications/tools/list_changed`. Mainstream clients agree with this (Claude Code goes idle for 30 minutes and allows manual retry on failure; VS Code has a workspace-level `mcp.json`).

## How it is done now

- **Mount point**: a single serial `agent/created` listener (`mountProjectMcpForAgent`). The monkey-patch of `agents.create/resume` and its generation/restore/double-line-of-defense accounting were deleted — the old comment asserted the event was fire-and-forget, which mistook the synchronous `sessions.announce()` for `agents.announce()`; the latter is `await ctx.serial(...)`.
- **Connection lifecycle**: config-driven. `releaseSharedConnection` (session ends) only returns the reference and starts the idle timer; `retireSharedConnection` (no longer valid) destroys immediately. Idle reclamation `idleTimeoutMs` defaults to 5 minutes, `0` = never; plugin unload always destroys immediately.
- **Config alignment**: `reconcileWorkspaceConnections(ctx, wsPath)` is the only synchronization point, called by the panel after every write; the mount path additionally does a `retireStaleConnection`, so hand-editing the config file is also picked up at the next session mount. A config change goes through `repointConnectionSlots` (all session slots repointed to the new connection, with references transferred along with ownership), and a removal goes through `dropConnectionSlots` (the whole projection is withdrawn, leaving no zombie tools).
- **Tool ownership**: the shared scope's tool view also includes global definitions. Project details and session projection use only the connection's own definitions. Overlapping server-name prefixes do not re-register inherited global tools into the session's own layer, so project `exclude` remains effective.
- **First-turn readiness**: the shared readiness budget `readyTimeoutMs` (default 5s, `0` = do not wait); a timeout does not block the session.
- **Terminal-state recovery**: `isDeadConnection` (fiber ACTIVE, 0 tools, and existing for > 5s) is rebuilt at the next mount; the panel's "Reconnect" = the `reconnectWorkspaceServer` RPC, which immediately tears down the old and builds the new, and aligns live sessions.
- **Panel**: `wsSub` states "whether the connection exists" and "how many sessions are using it" separately; the two composite/stale states `awaiting session mount` and `config pending` were deleted.

## Rejected approaches (do not re-argue)

### 1. Project scope + session binding + scope chain inheritance

**Considered**: register project tools in a resident project scope and have sessions attach to it via `bindScopeParent` to inherit — that way config changes would not need per-session synchronization and the code would be much shorter.

**Why rejected (with test evidence)**: the agent scope in the `agent/created` payload has a **single-slot parent chain**, and in real sessions that slot is occupied by the **agent preset registry** (`join()` in `packages/preset/agent-preset-registry/src/index.ts:241-250`); the preset's standing key is also shared by revision, so binding it would leak across projects. `test/scope-chain-inheritance.test.mjs` uses the real official packages to pin three facts that hold (chain inheritance itself is fine, a later-created scope is inherited by an earlier-open session, and a real mcp-client can mount a project scope) and one that does not (a third party cannot insert into a slot already occupied by a preset) — **if the host ever supports multiple parent chains or provides an official per-agent attachment point, the 4th case will fail, and that is the signal to re-evaluate**.

### 2. Connection pooling

MCP servers are stateful (HTTP has `Mcp-Session-Id`, stdio is a single duplex process), so pooling necessarily crosses state. The legitimate way to reduce the number of connections is "let a single connection live longer", not opening several spares.

### 3. Caching the tool list by default (declare first, calibrate later)

It does make cold starts "zero wait", but it introduces a new failure state: the model may call a tool that no longer exists (the declaration and reality disagree). It is only worth it when "waiting for readiness is unacceptable". VS Code goes this route ("Clear cached MCP tools"), which can serve as a reference shape for slow servers in the future; this project does not do it by default.

## Verification anchors

| Property | Evidence |
|---|---|
| Mounting happens inside the creation transaction, and a throw does not block | `test/real-host-integration.test.mjs` (including a fixture-fidelity comparison for "a throw vetoes creation") |
| Writing the config while a session is open → the live session can use it immediately; removing → tools withdrawn, subprocess exits | same file |
| Ready before the first turn (no `waitFor` assertion) | same file |
| Session end does not tear down the connection; idle timeout does; `idleTimeoutMs: 0` never tears down | `test/workspace-runtime.test.mjs` + same file |
| Config change reloads in place, tool names unchanged, old sessions need not be reopened | `test/workspace-runtime.test.mjs` |
| A terminal-state connection is rebuilt on demand and is really callable after the rebuild | same file (real host) |
| Project row wording distinguishes the two facts | `test/client-behavior.test.mjs` (the pure function `wsSub`) |
| README promises and the panel implementation agree | `test/package-contract.test.mjs` |
