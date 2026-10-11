# Where the project stands

moat now uses **Pi only**. The owner explicitly chose to replace both Codex and Claude Code rather
than add another runtime. The sandbox/copy/review architecture is retained; harness customization
belongs to Pi inside the box. **0.1.0 is published on npm as `moat-sandbox` and is the `latest`
dist-tag**, from `v0.1.0` / commit `88e9bda095668b29667d845dbc52c2d0ef820138`.
The [publication workflow](https://github.com/nochinsky/moat/actions/runs/38170437304) succeeded;
registry installation, signatures/provenance and an actual sandbox demo pass (`pi-published.txt`).
0.0.x packages use the previous harnesses.

`AGENTS.md` and [`SPEC.md`](SPEC.md) are the contracts. [`PI.md`](PI.md) explains customization.
[`VERIFICATION.md`](VERIFICATION.md) distinguishes current captures from historical measurements;
[`TRUST.md`](TRUST.md) derives verdicts from suite output. `archive/` is history, not instructions.

## Implemented

* One pinned Pi CLI, no runtime selector, no Codex/Claude adapters or vendored Codex prompt.
* Complete SHA-256-pinned npm dependency lock; dependency tarballs verified with SHA-512 SRI.
  No dependency lifecycle scripts execute on the host. Node/npm are in the Alpine base image.
* Sandbox-local Pi settings/model definitions/global brief, rewritten through the rootfs guard
  each boot. Credentials remain environment-only; no host Pi configuration/auth is imported.
* Project-local extensions, skills, prompts, settings and package declarations are Pi's
  customization surface, copied with the project and executed inside the sandbox.
* Pi's own TUI on a pty; JSON-mode tasks with normalized tool rows, messages, errors and usage.
  A failed Pi response returns nonzero even when Pi's process returns zero.
* Reported-usage ceilings use the same parser as the footer; budgeted tasks run headless.
  Cache reads, cumulative streaming usage, reasoning, compaction and reported nested calls are
  handled without summing snapshots twice. Incremental accounting survives raw-log truncation;
  provider-qualified models cannot borrow another provider's prices.
* Both compatible OpenAI protocols, Responses and Chat Completions. Model ids containing slashes,
  protocol, endpoint and effort persist. Keyless requests suppress the SDK's dummy Bearer header
  through a small in-box hook; this is asserted at the receiving stub.
* Existing sandboxes upgrade/repair in place rather than destroying `/work`; the published 0.0.3
  rootfs upgrade is tested with a real old binary, recorded baseline and sandbox branch. Installed
  Node alone is not enough: APK metadata below 22.19 triggers an in-place upgrade, never host
  execution of the sandbox's Node binary.
* Archive extraction stages outside the agent-writable rootfs; directory replacement/rollback
  uses the rootfs guard's held parent descriptor, with a tested parent-swap attack.
* Rootfs reads verify the opened descriptor after a parent-swap race; capped reads remain bounded
  if the file grows. FIFOs/devices are refused without blocking the host.
* Credential expiry bounds ephemeral tasks/TUIs through a host-owned timer as well as the keepalive.
  Container plans avoid credential values in argv and give ephemeral boots unique names for removal;
  actual Pi container execution is still unverified here.
* A pre-existing backend unit fixture that deleted shared `~/.moat/envs` is isolated to a temp
  `MOAT_HOME`, with a containment assertion before filesystem operations.
* A proxy readiness race exposed during regression testing is fixed: a visible veth is not a
  ready network; the boot waits for the actual listener before a short command can exit.
* The composite CI action now resolves the real script and returns the produced `review.json`.
  Its declared shell body is exercised, not just the script it was meant to call. The hosted-CI
  namespace probe now creates its mount target so capable runners are not falsely skipped.
  The release commit's real hosted Ubuntu 22.04/24.04 namespace suites pass; `ci-hosted.txt`
  checks uploaded acceptance/extras/egress captures, superseding the old blanket CI limitation.
* Release notes, supported-platform requirements and a bounded current-Pi provider smoke gate
  are documented. The tag workflow checks and publishes the same compiled tarball.

## Validation

Current Pi migration checks are reproduced with:

```sh
npm run typecheck
npm run test:unit
bash test/e2e-pi.sh
python3 test/pi-tui.py
bash test/pi-legacy.sh
bash test/pi-package.sh
bash test/e2e-provider.sh
bash test/e2e-demo.sh
bash test/e2e-review.sh
bash test/e2e-egress.sh
bash test/e2e-extras.sh
npm pack
# With a spend-capped DEEPSEEK_API_KEY already in the launching shell:
bash test/pi-live.sh
```

Read the generated trust page and captures for verdicts rather than a copied test count here.
The Pi acceptance suite measures a real in-box shell/edit/commit task, a project extension,
provider-side credential/effort/brief delivery, immutable host files after fetch, runtime repair,
terminal escape stripping, API failure reporting, a request-stopping token ceiling, long-stream
accounting beyond diagnostic capture, ephemeral credential expiry and keyless Chat Completions. The pty check measures Pi's actual model screen, not just an escape byte.

The separate bounded real-DeepSeek gate now passes with the current Pi CLI (`test/evidence/pi-live.txt`):
a genuinely broken fixture is fixed and committed, fresh checks pass, and review leaves host files
and HEAD unchanged. Reported usage is present; its estimated cost is not an invoice measurement.
This validates a small default-model Responses task, not every protocol/model or long-task quality.
Native provider-specific protocols, arbitrary extensions/packages/MCP servers and their billing
behavior are not universally validated.
A Pi cold-cache startup benchmark and container-backend Pi turn are not implied by the namespace
suite. Historical runtime and cold-start measurements are preserved, not relabeled as Pi readings.

## Open decisions and limitations

* **Default egress:** filtered nftables remains the default; the separately enforced resolving
  proxy is explicit because it needs host `ip(8)`. No silent fallback makes policy depend on host
  capabilities. DNS/IP snapshot/agent-modifiable rules remain limits of unproxied filtered mode.
* **Credentials and spend:** no provider-side per-boot scoped credential or aggregate boot/session/
  day budget. Stream ceilings cannot cover unreported extension requests or stop a provider before
  it reports usage. Cache writes are currently priced as input, not at a separate write rate.
* **Resource isolation:** namespaces share the host kernel; no moat-managed CPU/memory/disk quotas.
  The microVM path has historical measurements, not a production backend.
* **Project integration:** accepted-subset checks test coherence, not intent/correctness. Unborn Git
  copy-in and non-UTF-8 path support retain their documented limitations.
* **Customization compatibility:** installed package state and network/tool dependencies must be
  available inside the box. Offline startup does not silently install missing packages. Extensions
  can add approval dialogs or UI waits; unattended workflows must be designed accordingly.

The earlier phase program, ACP experiments and Codex/Claude measurements live in `archive/` and
`RUNTIMES.md`. They are not pending implementation tasks or supported runtime switches.

## Release

A release is an explicit matching package version and `v*` tag. The release workflow typechecks,
tests and publishes with GitHub OIDC provenance, without a stored npm token. Do not reuse an
already-published version. Pi's manifest and dependency lock must be present in the compiled
package under `dist/bundle/pi-runtime/`; source files under `test/` are not runtime assets.
Post-publication checks are reproduced with `bash test/pi-published.sh` and
`bash test/ci-hosted.sh 38170437071`. The release tag is immutable; subsequent documentation and
registry/CI evidence updates on main do not change the already-published package.
[`RELEASE.md`](RELEASE.md) defines local gates, version/tag handling and publication confirmation;
[`../CHANGELOG.md`](../CHANGELOG.md) records the 0.1.0 migration.
