# What moat claims, and what has actually been checked

> **Generated** by `node scripts/trust.mjs` from this repository's own evidence. Do not edit by
> hand: `test/unit/trust-generated.test.ts` regenerates it and fails if the committed file
> differs. It prints no number it cannot read out of a capture, which is why some cells say
> what to run rather than a figure.

moat runs an AI coding agent inside a disposable Linux sandbox — `unshare`, `mount` and
`chroot` by default, with no required container runtime or daemon — and reviews it before any of
it reaches your working tree. The point is **autonomy without built-in approval prompts**: the
blast radius is a box, and copy-out is a decision you make afterwards.
Pi's built-in tools need no approval dialogs; copied extensions are trusted code and can add
their own policies or UI waits. The sandbox is not a confidentiality or resource-quota boundary.

## What is verified, and by what

| suite | result | how to reproduce |
| --- | --- | --- |
| unit tests | Pure logic, no sandbox — this is the suite CI enforces on every change. | `npm run test:unit` |
| acceptance (Pi, keyless) | `acceptance (pi runtime): all criteria passed` | `bash test/e2e-pi.sh` |
| Pi TUI | `pi tui: the default runtime opens a live TUI` | `python3 test/pi-tui.py` |
| published-env upgrade | `pi legacy: published Codex environment upgraded in place; work, refs, baseline and installed state preserved` | `bash test/pi-legacy.sh` |
| installed package | `pi package: installed compiled CLI, pinned lock assets, stale-output cleanup and real sandbox demo passed` | `bash test/pi-package.sh` |
| Pi live DeepSeek (paid) | `pi live: bounded real DeepSeek task, tools, reported usage, verification and read-only review passed` | `bash test/pi-live.sh` |
| published registry package | `pi published: registry install, signatures/provenance, compiled assets and real sandbox demo passed` | `bash test/pi-published.sh` |
| hosted CI sandbox evidence | `ci hosted: real Pi acceptance, extras and egress passed on ubuntu-22.04 and ubuntu-24.04; uploaded captures checked` | `bash test/ci-hosted.sh <run-id>` |
| extras | `checks passed: 49, failed: 0` | `bash test/e2e-extras.sh` |
| egress | `egress checks passed` | `bash test/e2e-egress.sh` |
| provider | `checks passed: 9, failed: 0` | `bash test/e2e-provider.sh` |
| demo | `checks passed: 9, failed: 0` | `bash test/e2e-demo.sh` |
| review | `checks passed: 21, failed: 0` | `bash test/e2e-review.sh` |
| CI entrypoint | Needs no user namespaces, so unlike the sandbox suites it runs on a hosted runner too. | `bash test/ci-entrypoint.test.sh` |

Sandbox suites require usable user namespaces. Current hosted Ubuntu CI passes after capability
setup/probing; other runners may refuse — see [`CI.md`](CI.md). Captures are committed in
`test/evidence/` and quoted by [`VERIFICATION.md`](VERIFICATION.md).

## What is **not** verified

Copied from [`VERIFICATION.md`](VERIFICATION.md), which is the authority. It is longer than the
list above on purpose: a tool that hands an agent a shell should be explicit about the edges of
its own evidence.

| thing | why |
| --- | --- |
| Production microVM backend and Pi inside a microVM | `MICROVM.md` contains separate historical KVM measurements. No microVM backend or Pi microVM task is implemented/claimed by this migration. |
| Provider-side credential revocation, scoped keys and aggregate spend caps | Local TTL enforcement is not provider revocation. Per-boot spend-capped tokens and aggregate session/day budgets are not implemented. |
| Broad live-provider behavior and model quality | The current Pi CLI passes one bounded real DeepSeek Responses task (`pi-live.txt`), with tools, fresh verification and read-only review. That does not validate every protocol/model, long-task quality or a quality benchmark. Historical live turns used retired harnesses. |
| Non-DeepSeek providers | Explicit named-provider configuration and Pi model/auth/effort delivery are checked at a compatible stub. Responses and Chat Completions are supported; native Anthropic/Google protocols and another hosted provider with a real key are not validated by those tests. |
| The `countUnfetched` / host-drift logic under adversarial git states | §AB and §AC cover multiple branches, tags, an already-fetched ref, a non-git host, a detached host HEAD and a detached sandbox HEAD; a *rebased* sandbox branch, and commits that survive only in the sandbox reflog after a `reset --hard`, are still not staged. |
| The `browser`, `db`, `java`, `go`, `rust`, `cc` and `net` profiles | package names were resolved against the real Alpine 3.21 indexes, and the `node`/`python` profiles were installed and exercised end to end. The others were not installed here, to keep the suite under five minutes. |
| Cost figures against an invoice, and universal spend caps | Prices are applied to Pi's reported normalized usage, not checked against a bill. Peak-boundary work is priced at one rate; cache writes use the input rate. Extensions can make unreported requests or change models. No aggregate session/boot/day budget or provider-side cap is enforced. |
| Arbitrary Pi extensions, packages, skills and MCP servers | A project hook and model-invoked custom tool run inside the real box. That does not prove every plugin compatible or safe: network/dependencies, interactive approval policies and unreported model calls remain the extension author's responsibility. No host plugins/auth are imported. |
| Pi's interactive workflows beyond the pty gate | `test/pi-tui.py` reaches the model screen, stays interactive and leaves the keepalive running. Session resume/tree navigation, arbitrary custom UI and every keybinding are Pi's own and are not comprehensively automated here. |
| Exfiltration through an allowed channel | §L verifies that the allowlist admits the provider and refuses an arbitrary address, and that the host's loopback is unreachable on both routes. It does not attempt to push data out *through* an allowlisted address or over DNS, both of which remain possible by construction. |
| Behaviour under host reboot / kernel upgrade with a live env | the environment is designed to survive (`state.json` reconciles a stale PID against the live process table), and §AE covers a box killed out of band and a stale recorded identity, but a real reboot (with the kernel's own pid reuse) was not staged. |
| Project file names that are not valid UTF-8 | refused with the offending bytes before anything is copied (`assertAddressableNames`, `test/unit/fs-names.test.ts`, extras §Q). Byte paths through every host-side walk do not exist yet, so such a project cannot be sandboxed at all: a refusal, not support, and not a silent drop. |
| What the copy-out credential scan cannot see | it compares against the values the host holds at fetch/apply time (`DEEPSEEK_API_KEY`, `MOAT_CREDENTIAL`, the credential store) and searches the commits a fetch brought in (the most recent 50) or the files an apply plan would write (up to 64 MiB each). A key rotated since the boot, a secret the agent obtained somewhere else, older commits and larger files are outside it: each bound is named when it is reached (extras §AB, `test/unit/leak-scan.test.ts`). A file that does not match is not a claim that it is clean. |
| Pi performance and long-task quality relative to retired harnesses | There is no current cold-cache benchmark or live A/B task suite. Older startup/cost captures are history, not Pi measurements. |
| Whether a partially accepted subset of a change is coherent | **partly.** `moat apply` runs the project's own checks against exactly the accepted subset before writing, so a subset that breaks a *declared* check is refused, and extras §AM is that end to end. What is **not** verified: a project with no detectable check (the run warns instead), and a subset that is wrong in a way the project's checks do not cover — the review has no cross-file reasoning and moat has no model of what the project means. The check is the project's own floor, not a proof of intent. |
| A merge's hunks as an exhaustive description of the merge | a `both` path is presented as the hunks between your file and the merged bytes, so the review shows what would change in your copy. A conflict between the *two sides'* intentions that the three-way merge resolved silently is not surfaced as such: it arrives as an ordinary hunk, and the review does not say that the merge chose one side. |
| Harness interchangeability and ACP | Historical ACP measurements were not adopted. Current moat is Pi-only, CLI-driven; Node/npm are now base packages. No host-side agent SDK, extra runtime selector or ACP permission protocol is implemented. |
| Pi under the container backend, a comprehensive security audit and resource exhaustion | The namespace backend is the migration's exercised path. Container Pi turns depend on a usable runtime; skipped tests are named. Namespaces share the host kernel, and moat has no CPU/memory/disk quotas. Keyless acceptance is neither a full audit nor a resource-containment proof. |

## The contract, and the traps

* [`SPEC.md`](SPEC.md) — what each command promises, and where the sharp edges are.
* [`PI.md`](PI.md) / [`SEAM.md`](SEAM.md) — project customization and the host/agent boundary.
* [`PORTABILITY.md`](PORTABILITY.md) — what is measured about running outside Linux, and what a container backend would cost.
* `AGENTS.md` — the invariants and the traps, for anyone changing the code.
