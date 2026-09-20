# Program: turn moat into a sellable product

You are working on **moat** at the repo root, unattended, across many sessions.
This document is the contract for the whole program. Re-read it and `AGENTS.md`
at the start of **every** session. Keep `docs/PROGRESS.md` as the journal that
lets a session with no memory resume: it must always state **which phase you are
in** and whether that phase's gate has passed.

---

## 1. The thesis you are building toward

moat currently sells itself as a sandbox. That is no longer special — Vercel,
Docker, E2B and the agent vendors all run agents in boxes now.

What nobody has: **because moat records a baseline ref before the agent starts,
it can tell the difference between "the agent changed this", "you changed this",
and "you both changed this".** Every other tool works inside your repo, where
the agent's edits and yours are indistinguishable.

The product is not the box. The box is how the guarantee is enforced.

> **See exactly what your agent did, accept it hunk by hunk, and know it never
> touched your machine.**

And it must work with the agent people already use — not force them onto Codex
with DeepSeek.

---

## 2. Read before anything

`AGENTS.md` (the contract — 600 lines, read all of it), `docs/SPEC.md`,
`docs/VERIFICATION.md` (including the Not-verified table), `docs/HISTORY.md`.

---

## 3. How to work this program

- **Phases are gated.** Do not start phase N+1 until phase N's gate is green.
  If a gate cannot pass without weakening something, STOP and journal it.
- **Stop at every gate.** Write a report in `docs/PROGRESS.md`, then continue
  only if the gate passed. A fresh session with no memory must be able to resume
  from that file alone.
- **Small commits.** Every commit leaves the repo green. Never end a session
  with the repo broken or mid-phase without a journal entry saying exactly where
  you are.
- **Verify claims, including the ones in this document.** Section 8 is a list of
  reported defects. Some were verified by hand; some were not. Confirm each one
  reproduces before you "fix" it. If one does not reproduce, say so in the
  journal and move on.
- **A check that cannot fail is not a check.** When you add a guard, reintroduce
  the bug, watch it fail, then trust it.
- Do not hand-edit `test/evidence/`. Regenerate by running the suites.
- `npm run test:unit` stays green at all times.

---

## 4. Invariants — these never move, in any phase

If a phase seems to require breaking one, stop and journal it. Do not break it.

1. The host filesystem is never mounted into the sandbox. Only the six device
   nodes. Copy-in is a `git clone`, never a bind mount.
2. No credential ever reaches the image. Environment variable only.
3. No server runs in the box and nothing is proxied. **No host-facing port.**
4. Copy-out is explicit: `fetch` writes one ref; `apply` is a separate command.
   The host tree is provably unchanged until the user says so.
5. The runtime config is rendered by moat on every boot, through the rootfs
   guard. The agent never owns that file.
6. Every host-side write into the rootfs goes through `lib/rootfs-fs.ts`.
7. Every network artefact is digest-verified against `lib/pins.ts`.
8. Text from the sandbox is untrusted as terminal input. `stripAnsi` at every
   print boundary, no exceptions.

---

## 5. Phases

### Phase 0 — make the ground trustworthy

Fix the defects that make verification unreliable (section 8, items 1–7), plus
the user-visible bugs. Nothing is built on top of a test suite that cannot fail.

**Gate:** `e2e-extras.sh` exits non-zero when a check fails, proven by breaking a
check on purpose and watching it fail. `--verbose` produces output.

### Phase 1 — drop the DeepSeek lock

Codex natively supports arbitrary providers via `model_providers` — that is the
TOML block moat already renders. moat is what forces DeepSeek, and then carries
~1,500 lines to bridge the gap: `bundle/codex.ts`, `bundle/deepseek-models.json`
(38KB), `lib/catalog.ts`, the `base_instructions` prompt pin and its documented
landmine.

Make the provider and model **whatever the user configures**, with DeepSeek as
just the default. Delete the bridging machinery the unlock makes unnecessary.

**This phase is security-relevant and must be treated as such.** The credential
story is currently tied to DeepSeek: `DEEPSEEK_API_KEY`, the rendered `env_key`,
the `LITERAL_KEY` tripwire, the rootfs sweep, `doctorInjectedVarNames`. Making
the provider general is exactly the kind of change where a guarantee leaks.

You must preserve, and add tests proving:

- No credential ever reaches the image, for *any* configured provider.
- `installCodexFiles` still refuses to write a config or brief containing a
  literal key. Extend the tripwire if the config shape changes.
- `--no-credential` still produces a box with nothing stealable in it.
- The post-boot rootfs credential sweep still runs and still aborts the boot.

**Gate:** a boot with a non-DeepSeek provider works end to end against the local
stub, with no credential in the image and the sweep green. The prompt pin is
either correctly maintained or provably no longer needed — state which, in the
journal.

### Phase 2 — `moat demo`

Keyless, no config, under two minutes warm. Boots a real box, runs the **real
pinned Codex** against the existing local stub, executes a real tool call, and
prints the centrepiece: a three-way attribution — a file only the agent changed,
a file only "you" changed, a file both changed (conflict, nothing written) —
plus the host tree digest before and after, identical.

It must drive the **real apply path** in `sync/apply.ts` against a real git repo.
Do not special-case the demo's scenarios. Do not print attribution the code did
not compute. A demo that is a puppet show is worse than no demo.

On a cold cache, say what it is downloading and why before it does it.

**Gate:** runs with no credential in the environment; output captured in
`test/evidence/` by running the suite.

### Phase 3 — the review surface. This is the product.

Make `moat take` and `moat apply` present attribution properly: every changed
path classified as agent / you / both / conflict, shown **per hunk**, with
individual accept and reject.

The classification logic already exists in `sync/apply.ts` (`entryState`,
`sameContent`, the base/host/sand tree). **Surface it. Do not rewrite it.**

Partial accept must be safe: rejected changes stay out, accepted changes merge
correctly, a conflict still writes nothing, and the three-way re-check before
each write still holds.

**Gate:** a real repo with real agent work, a partial accept, and the host tree
containing exactly what the user approved and nothing else. Unit coverage for
every classification branch and every partial-accept path.

### Phase 4 — the harness seam, and a spike

First, **name the seam**: write down the interface that `codexEntryScript` +
`parseCodexEvents` + the turn runner already implement (start a session in the
box, run a turn, stream events, report usage). One adapter today. No behaviour
change.

Then **spike, do not commit**: investigate ACP (Agent Client Protocol —
JSON-RPC 2.0 over stdio, agents as subprocesses of the client, roughly 40 agents
including Codex and Claude Code). Write a throwaway client that drives the
existing Codex path through ACP and report:

- Does it work inside the box with no port and no server? (It must, or it is
  disqualified — invariant 3.)
- Is `session/request_permission` answerable entirely by the client, so moat
  keeps its "never ask" stance without relying on a config file?
- What third-party adapters would we depend on, and can they be digest-pinned
  the way `lib/pins.ts` pins everything else?
- What breaks?

**Gate:** a written report in the journal with a recommendation. Do **not**
replace the hand-written Codex adapter in this program. If ACP looks right, the
migration is the *next* program.

### Phase 5 — make it reachable

An install story that works: publishable package (`package.json` currently says
`"private": true`), `npx`-able, no prerequisites beyond Node, and a first run
that shows something without demanding an API key.

Rewrite `README.md` so the first sentence is the trust pitch, not the sandbox
pitch. Keep the honest limits — everything `docs/SPEC.md` §1.2 and the
verification Not-verified table say about what moat does *not* protect stays.

**Gate:** clean checkout, fresh cache, documented install command works.

---

## 6. Non-goals — do not do these, in any phase

- Do not remove, fork, or replace the pinned Codex runtime. It stays the default
  adapter for the whole program.
- Do not adopt the Vercel AI SDK harness layer. Its Codex and Claude Code
  adapters are bridge-backed and expose a port (invariant 3), and `HarnessAgent`
  takes ownership of the sandbox lifecycle, which is yours.
- Do not add a web UI, a hosted service, or a GitHub App.
- Do not add macOS support. It is a large separate program.
- Do not refactor `cmdUp` or split `cmd/main.ts` for its own sake.
- Do not weaken the isolation, egress, or credential model to make anything
  easier.

---

## 7. Stop conditions — halt and journal

- A phase requires breaking an invariant.
- You find evidence the trust/attribution thesis is wrong — for example the
  three-way classification cannot express something users would obviously need.
- A gate cannot pass without weakening a check.
- You are about to spend more than one session outside the phases.
- A reported defect in section 8 does not reproduce, and the "fix" would change
  behaviour you cannot justify.

---

## 8. Reported defects

**Verified by hand — reproduce, then fix (Phase 0 unless noted):**

1. **`--verbose` is a no-op.** `lib/log.ts:16` reads `MOAT_VERBOSE` at module
   load; `cmd/main.ts:2302` sets it inside `main()` afterwards. All 13
   `log.debug` sites are unreachable. Add `setVerbose()` mirroring `setQuiet()`.
2. **`test/e2e-extras.sh` cannot fail.** 19 `FAILED` prints, no accumulator, and
   the last statement is `scrub_evidence`, so exit is always 0. `e2e-live.sh` has
   the same shape. Copy `test/e2e-egress.sh:20,229`.
3. **`moat profiles --json`** emits only `{"base": [...]}`. The ternary at
   `cmd/main.ts:2053` is statically undefined, and there is no `return`.
4. **`moat status /nonexistent`** leaks a raw `ENOENT` from `envPaths`.
5. **`cmd/main.ts:1484`** prints `left alone:` paths without `stripAnsi` —
   violates invariant 8.
6. **`bundle/codex.ts:185`** interpolates `contextWindow` / `maxOutputTokens`
   unquoted into TOML, and `lib/catalog.ts:75` copies them from network JSON
   with a bare cast. Add numeric validation.
7. **`sync/copyout.ts:411`** uses `git branch --force` and will silently move an
   existing local branch. Check first, then refuse or warn. (`--checkout` at
   `:409` has the same shape.)
8. **`test/evidence/onboard.txt`** is tracked and contains a plaintext session
   password from the deleted opencode runtime. Delete it. **`test/evidence/`
   `audit.jsonl`** is an orphan from the same runtime — delete it too.
9. **`docs/SPEC.md:805-809`** duplicates the `exposure` bullet verbatim.

**Reported by review, not independently verified — confirm before acting:**

10. **`writeRootfsFile` (`lib/rootfs-fs.ts:73-102`)** verifies the temp file
    through `/proc/self/fd` but then `renameSync(tmp, full)` re-resolves
    directory components. A directory-swap race can redirect the write outside
    the rootfs. The readers (`:111-126`, `:207`) are correct; the writer is the
    gap. Fix via a dirfd.
11. **The egress ruleset is loaded from inside the agent-writable rootfs**
    (`sandbox/egress.ts:192-200` → `launcher.ts:216-229`), so it can be rewritten
    between boots. The boot log already solves this with a host fd (`exec 1>&3`,
    `launcher.ts:171-173`); use the same pattern.
12. **`moat up` reports success when the box died instantly** (`launcher.ts:584`,
    `cmd/main.ts:1067-1071`). The expired-credential path exits in milliseconds.
13. **slirp spawn errors are swallowed** (`sandbox/egress.ts:237-253`).
14. **The boot marker is check-then-write with no lock** (`sandbox/boot.ts:76-88`).
    Two concurrent `up`s can race into `fs.rmSync(rootfs)`.
15. **A dangling baseline symlink breaks every snapshot listing**
    (`sandbox/rootfs.ts:631-641`, unguarded `statSync`).
16. **The leak scan cannot see `--credential-env` keys**, and its "did not run"
    notice is `log.debug` (`sync/leak-scan.ts:190`) — hidden even once
    `--verbose` works. Make it a warning.
17. **`applyPlan` re-reads agent-controlled bytes at write time**
    (`sync/apply.ts:602`), so the scan verdict and the written bytes can differ,
    and a symlink swap can pull a host file into the project.
18. **In-tree `.gitattributes` can still execute `filter.<driver>.clean`**
    despite `hardenedGitArgs()` — `-c core.attributesFile=/dev/null` only covers
    the global file.
19. **`parseCodexEvents` synthetic-id fallback** (`bundle/codex.ts:371`)
    recomputes an id that has grown, producing two rows for one tool.
20. **Coverage:** `sandbox/isolation.ts` is 35% (its `runIsolationChecks` body,
    lines 329-596, is entirely uncovered), `cmd/main.ts` is 0%, as are
    `lib/catalog.ts`, `lib/host.ts`, `sandbox/profiles.ts`. `test/` is excluded
    from `tsconfig.json`, so 40+ `as never` casts in fixtures are unchecked. Add
    `--experimental-test-coverage` to CI and typecheck `test/`.
21. **Weak tests to fix or delete:** `stop-slirp.test.ts:39` (zero assertions),
    `runtime-image.test.ts:24` (constant vs retyped literal),
    `pid-identity.test.ts:25` (call compared to itself), `base-url.test.ts:41`
    (self-disabling loop), `runtime-install.test.ts:40` (matcher-less
    `assert.rejects`), `hash-tree.test.ts:76` (name describes a scenario it never
    creates), `copyin-reporting.test.ts:41` (assertion inside `if (mkfifo ok)`).

---

## 9. Final acceptance

`npm run test:unit` green and typechecking `test/`. All four e2e suites green
**and able to fail**. `moat demo` works keyless on a clean checkout. `moat take`
presents per-hunk attribution with working partial accept. A non-DeepSeek
provider boots with no credential in the image. The README leads with the trust
pitch. `docs/PROGRESS.md` explains what you did, what you decided, and what you
are unsure about.

Write two closing sections: **what you built**, and **everything you found that
contradicts what this document assumed**.
