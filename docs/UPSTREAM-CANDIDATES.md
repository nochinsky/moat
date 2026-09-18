# Upstream changes moat would like, but did not make

moat does not fork, patch or vendor opencode. Every item below
is therefore a *request*, with the exact location, the reason, and a rough diff
size, so it can be filed rather than hacked around. Nothing here was applied:
`opencode-ai@1.18.31` is used exactly as published.

All line numbers refer to the reference clone at
`/home/user/opencode-upstream` (branch `dev`, version `1.18.31`).

---

## 1. A supported way to prune built-in tools from the model-facing list

**Why moat cares.** The goal is that the user gets exactly the tools
the bundle declares, not opencode's defaults". moat cannot satisfy that exactly.

**What happens today.** The model-facing tool list is assembled from the static
`builtin` array in `packages/opencode/src/tool/registry.ts:231`, returned by
`all()` as `[...s.builtin, ...s.custom]` (`registry.ts:256`), and consumed by
`packages/opencode/src/session/tools.ts:92`. No permission filter is applied to
built-ins on that path. Permission-based hiding exists, `Permission.disabled`
(`packages/opencode/src/permission/index.ts:204`) and
`Permission.visibleTools` (`:216`), but the only caller for tools is the MCP
path at `packages/opencode/src/tool/registry.ts:286`.

Meanwhile `tools: {name: false}` in config compiles to a *permission rule*
(`packages/opencode/src/config/config.ts:567`; same normalisation for agents in
`packages/core/src/v1/config/agent.ts`, `normalize`). So the tool stays
advertised and the model is invited to call something it will then be refused.

**Measured effect** (captured from the provider side, see `docs/VERIFICATION.md`):
with the moat bundle, a non-GPT model is offered
`bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`, three of
which (`skill`, `task`, `webfetch`) are not in the bundle.

**Smallest change that would fix it.** Apply the existing visibility helper to the
built-in path as well:

```ts
// packages/opencode/src/tool/registry.ts, inside `tools()`, around line 292
const filtered = (yield* all()).filter((tool) => {
  if (tool.id === WebSearchTool.id) return webSearchEnabled(input.providerID, { exa: flags.enableExa, parallel: flags.enableParallel })
  ...
})
```

becomes something that also consults the merged ruleset:

```ts
const ruleset = Permission.merge(input.agent.permission, input.permission ?? [])
const filtered = Permission.visibleTools(
  Object.fromEntries((yield* all()).map((t) => [t.id, t])),
  ruleset,
)
```

Estimated diff: **~10 lines in one file**, plus a test. Risk: moderate. It
changes what every agent is offered, so it needs a deliberate decision about
whether `tools: {x: false}` should mean "hidden" or "refused". moat's position is
that "not in the bundle" should mean **hidden**, because a refusal the model can
see and retry against is a worse experience than a capability that does not
exist.

**Alternative, larger:** a first-class `tools: { hidden: string[] }` config key
alongside the existing allow/deny map. Diff: **~40 lines across config schema,
registry and docs.**

---

## 2. An authoritative "materialized tool list" HTTP endpoint

`GET /experimental/tool/ids` (`packages/sdk/js/src/gen/sdk.gen.ts:373`) returns
`registry.ids()`, i.e. the pre-materialization registry. It lists `question`,
`skill`, `task`, `webfetch`, `websearch`, `invalid` even when the session will
never be offered them. A headless supervisor like moat therefore cannot ask the
server what the model will actually see; it has to observe an inference request.

**Request:** expose the effective, permission- and provider-filtered list for a
given `(agent, provider, model)`, e.g. `GET /experimental/tool?agent=&provider=&model=`
already exists, clarify in its description that it is materialized, or add the
filter to `/experimental/tool/ids`.

Estimated diff: **~15 lines**.

---

## 3. Document the `OPENCODE_CLIENT` enum

`RuntimeFlags.client` defaults to `"cli"` and is compared against
`["app", "cli", "desktop"]` to decide whether to add the interactive `question`
tool (`packages/opencode/src/tool/registry.ts:207`). Setting it to any other
string silently removes `question`, which moat relies on, having discovered it
empirically. There is no documented list of accepted values and no mention that
the value gates a tool.

**Request:** document the accepted values, and name the behaviour explicitly
(e.g. a `headless` value that is understood rather than merely not-`cli`).

Estimated diff: **docs only**.

---

## 4. Unify the two permission rule shapes

`packages/core/src/tool/registry.ts:132` (`whollyDisabled`) inspects
`rule.resource === "*" && rule.effect === "deny"`, while
`packages/opencode/src/permission/index.ts:204` (`disabled`) inspects
`rule.pattern === "*" && rule.action === "deny"`. Two registries, two rule
vocabularies, same concept. moat had to read both to understand whether a tool is
hidden or merely refused, and the two answers disagree.

**Request:** one `Rule` type, or an explicit adapter between them.

Estimated diff: **~30 lines**, mechanical, but it touches permission semantics so
it needs care.

---

## 5. Permission events on the HTTP API

A headless supervisor cannot observe permission decisions without loading a
plugin: the only signal is the `permission.ask` hook
(`packages/plugin/src/index.ts:261`). moat proves "zero permission prompts" by
the absence of a file its own plugin writes, which is indirect.

**Request:** emit permission decisions on the existing event stream
(`GET /event`) with tool, session, action and rule.

Estimated diff: **~20 lines**.

---

## 6. Serve a workspace's repository over a socket

Copy-out currently names the sandbox's working directory as a git remote
(`git fetch <rootfs>/work`). It works and it is a real `git fetch`, but it means
the host touches the sandbox's filesystem. If opencode exposed a git transport
for the workspace (or if the workspace adapter API,
`WorkspaceAdapter.target()` in `packages/plugin/src/index.ts`, could return a
`git://`/`ssh://` target), moat could fetch over the socket and stop assuming
host filesystem access.

Estimated diff: **large / architectural**; noted for v1, not requested for
v1.18.x.

---

## 7. Documentation corrections

* The plugin hook is `permission.ask`, not `permission.asked`. The latter name
  does not exist in the API.
* `packages/core/src/tool/builtins.ts` and
  `packages/opencode/src/tool/registry.ts` disagree about the built-in set
  (`task`, `lsp`, `plan`, `invalid`, `execute` appear in one and not the other,
  and `apply_patch` is registered as `patch` internally while being advertised as
  `apply_patch`). A single documented list would save every integrator an hour.
* `apply_patch` is only offered when `modelID.includes("gpt-")` and not `oss` /
  `gpt-4` (`registry.ts`, `usePatch`). This is not mentioned in any tool
  documentation, and it surprised moat: a bundle that declares `apply_patch`
  gets it only on some models.
