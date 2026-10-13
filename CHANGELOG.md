# Changelog

## Unreleased — focused Pi follow-up

### Fixed

- Copy-in for Git repositories with no commits now retains indexed and untracked working files,
  post-stage edits, symlinks, executable modes and binary bytes. Deleted cached paths and replaced
  parent directories do not copy stale/outside files. The baseline remains empty, preserving
  conflicting-addition review rather than silently overwriting the user's initial work.
- Unborn commit/branch metadata is reported truthfully; host HEAD/index are not modified.
- Proxy boot waits for the holder's distinct network namespace, not only its published pid;
  the existing deadline and same-namespace refusal remain.
- Doctor messages no longer call WSL2 container-only or suggest that accessible KVM means a
  production microVM backend exists.

### Validation

- A real unborn-project Pi task and read-only review, with host files/index/HEAD unchanged.
- A representative local Pi package with an in-box dependency, stdio MCP tools/resources,
  explicit skills/prompts, persistent CLI session resume and a fail-closed headless approval policy.
- Added rootless-Podman Pi task, budget, timeout, credential-expiry, keyless-auth and cleanup gates
  to both hosted Ubuntu jobs; both passed in run `38331376464`. Default filtered boot/checks are
  separate from the real Pi task's explicit open/loopback stub. Runtime absence exits 77, not a
  pass; uploaded captures are checked separately by `test/pi-compatibility-hosted.sh`.

No new package version or release tag is implied by this section. Broad plugin compatibility,
resource quotas, aggregate budgets and a production microVM backend remain out of scope.

## 0.1.0 — Pi-only harness

### Breaking changes

- **Pi replaces Codex and Claude Code as the only agent runtime.** `--runtime` is refused.
  Moat does not uninstall host-global tools or delete legacy runtime/session files from existing
  sandboxes; they are no longer driven paths.
- Node/npm are part of every sandbox image. The in-box Node must support Pi (22.19+); the host
  controller still requires Node 22.18+. This release targets Linux x86-64, including WSL2.
- Pi supplies the tool surface, prompt and TUI. Use copied project `.pi` resources for extensions,
  skills, prompts, packages and MCP workflows; host Pi settings/auth are not imported.

### Added and changed

- Complete pinned Pi dependency graph, SHA-256 lock validation and SHA-512 archive verification,
  without dependency lifecycle scripts executing on the host.
- Sandbox-local configuration and environment-only credentials, with receiving-end assertions
  for credentialed and genuinely keyless Responses/Chat Completions requests.
- Incremental usage accounting shared by the task footer and reported-usage ceilings. Cache,
  reasoning and cumulative/final snapshots are normalized without double counting; accounting
  survives diagnostic-log truncation. Unknown or switched models are not priced as free.
- Host-owned credential-expiry enforcement for ephemeral tasks and TUIs. Container plans keep
  credentials out of argv and name ephemeral containers uniquely for explicit removal.
- Guarded runtime replacement/rollback and reads hardened against parent swaps, FIFOs and
  post-stat growth. These regression checks are not a comprehensive security audit.
- In-place repair and an actual published-0.0.3 environment upgrade test, preserving work,
  branches, the recorded baseline and installed state.
- Real Pi CLI acceptance, TUI and installed-tarball gates. The bounded real DeepSeek Responses
  smoke test passes, including tools, reported usage, independent checks and read-only review.
- Updated contracts, customization documentation, generated trust page and release checks.
- Fixed the composite CI action's nonexistent relative script path and incorrect review output.
  Its declared shell entrypoint and produced JSON are now exercised by a regression test.
- Fixed the hosted-CI namespace probe's missing mount target and made matrix artifact names
  distinct. CI uses the tracked lockfile; trusted publishing correctly requires npm 11.5.1+.

### Migration and limits

Run `moat up` in the existing project to upgrade; **do not use `--fresh` to migrate**. Moat keeps
`/work`. Backup important sandbox work as you would for any tool upgrade.

The default namespace backend is tested with the current Pi CLI. A current-Pi container turn,
arbitrary extension/MCP compatibility and production microVM isolation remain unverified. Moat
is not a confidentiality boundary or resource-quota system; reported-usage ceilings are not a
universal spending guarantee. See [`docs/VERIFICATION.md`](docs/VERIFICATION.md#not-verified).

## 0.0.3 and earlier

These published versions use the retired harnesses. Their contracts and measurements are retained
in `docs/archive/`, `docs/HISTORY.md` and `docs/RUNTIMES.md`; they are not current runtime options.
