# What moat claims, and what has actually been checked

> **Generated** by `node scripts/trust.mjs` from this repository's own evidence. Do not edit by
> hand: `test/unit/trust-generated.test.ts` regenerates it and fails if the committed file
> differs. It prints no number it cannot read out of a capture, which is why some cells say
> what to run rather than a figure.

moat runs an AI coding agent inside a disposable Linux sandbox — `unshare`, `mount` and
`chroot`, no container runtime, no daemon — and reviews what it did hunk by hunk before any of
it reaches your machine. The point of that shape is **autonomy without approval prompts**: the
blast radius is a box, and copy-out is a decision you make afterwards.

## What is verified, and by what

| suite | result | how to reproduce |
| --- | --- | --- |
| unit tests | Pure logic, no sandbox — this is the suite CI enforces on every change. | `npm run test:unit` |
| acceptance (Codex, keyless) | `acceptance (codex runtime): all criteria passed` | `bash test/e2e-codex.sh` |
| extras | `checks passed: 52, failed: 0` | `bash test/e2e-extras.sh` |
| egress | `egress checks passed` | `bash test/e2e-egress.sh` |
| provider | `checks passed: 9, failed: 0` | `bash test/e2e-provider.sh` |
| demo | `checks passed: 9, failed: 0` | `bash test/e2e-demo.sh` |
| review | `checks passed: 21, failed: 0` | `bash test/e2e-review.sh` |
| CI entrypoint | Needs no user namespaces, so unlike the sandbox suites it runs on a hosted runner too. | `bash test/ci-entrypoint.test.sh` |

Every sandbox suite must be run on a host with unprivileged user namespaces, which GitHub's
runners cannot provide — see [`CI.md`](CI.md). The captures above are committed in
`test/evidence/` and quoted by [`VERIFICATION.md`](VERIFICATION.md).

## What is **not** verified

Copied from [`VERIFICATION.md`](VERIFICATION.md), which is the authority. It is longer than the
list above on purpose: a tool that hands an agent a shell should be explicit about the edges of
its own evidence.

| thing | why |
| --- | --- |
| v1 (microVM on KVM): boot time, image size, delta vs v0 | `/dev/kvm` is present but not accessible to this user (mode 660, gid 991, not a member). v1 is a separate phase and is not claimed here. |
| v2 (provider-side credential revocation and spend caps, concurrent sandboxes) | explicitly gated on v0 *and* v1 passing. Egress rules landed ahead of v2 and are verified in §L. |
| Model quality, as opposed to model reachability | a real DeepSeek session is verified above. That is one task, one model, one run: a smoke test with teeth, not a benchmark. |
| Non-DeepSeek providers | a *named* provider configured with `moat provider add` is verified end to end against a stub (`test/e2e-provider.sh`, 9 checks: the model id and base URL on the wire, no credential name from the default provider in the image or the environment, the rendered catalog describing that provider's model). No second **hosted** provider has been called with a real key, and moat still refuses a provider name nobody configured and infers nothing from the environment. |
| The `countUnfetched` / host-drift logic under adversarial git states | §AB and §AC cover multiple branches, tags, an already-fetched ref, a non-git host, a detached host HEAD and a detached sandbox HEAD; a *rebased* sandbox branch, and commits that survive only in the sandbox reflog after a `reset --hard`, are still not staged. |
| The `browser`, `db`, `java`, `go`, `rust`, `cc` and `net` profiles | package names were resolved against the real Alpine 3.21 indexes, and the `node`/`python` profiles were installed and exercised end to end. The others were not installed here, to keep the suite under five minutes. |
| The absolute correctness of a cost figure against a DeepSeek invoice | the figure is the published table applied to the billed token counts in the CLI's own usage block. Codex reports one usage block per turn, so a turn that crosses a peak-pricing boundary is priced at one rate and the label names one side; only per-request timestamps could split it, and they are not reported. Nothing here is compared against a real bill. |
| Codex's tool list over time | the `codex-*.txt` captures record what one pinned version advertised on one turn. Another version may advertise a different set, and nothing in moat reads or constrains it. |
| The interactive screen beyond reaching it | extras section AL (`test/codex-tui.py`) proves moat reaches a live TUI and that leaving it leaves the box running. What the TUI draws, its keybindings, its model picker and its session resume behaviour are the CLI's own, and are not automated here. |
| Exfiltration through an allowed channel | §L verifies that the allowlist admits the provider and refuses an arbitrary address, and that the host's loopback is unreachable on both routes. It does not attempt to push data out *through* an allowlisted address or over DNS, both of which remain possible by construction. |
| Behaviour under host reboot / kernel upgrade with a live env | the environment is designed to survive (`state.json` reconciles a stale PID against the live process table), and §AE covers a box killed out of band and a stale recorded identity, but a real reboot (with the kernel's own pid reuse) was not staged. |
| Project file names that are not valid UTF-8 | refused with the offending bytes before anything is copied (`assertAddressableNames`, `test/unit/fs-names.test.ts`, extras §Q). Byte paths through every host-side walk do not exist yet, so such a project cannot be sandboxed at all: a refusal, not support, and not a silent drop. |
| What the copy-out credential scan cannot see | it compares against the values the host holds at fetch/apply time (`DEEPSEEK_API_KEY`, `MOAT_CREDENTIAL`, the credential store) and searches the commits a fetch brought in (the most recent 50) or the files an apply plan would write (up to 64 MiB each). A key rotated since the boot, a secret the agent obtained somewhere else, older commits and larger files are outside it: each bound is named when it is reached (extras §AB, `test/unit/leak-scan.test.ts`). A file that does not match is not a claim that it is clean. |
| Whether the Codex loop is better than the old runtime's on long work | cost per turn is measured (`docs/HISTORY.md`), but the old runtime is deleted, so that comparison is history rather than a live A/B, and "which harness does long autonomous work better" would need a task suite and many runs. |
| Whether a partially accepted subset of a change is coherent | **partly.** `moat apply` runs the project's own checks against exactly the accepted subset before writing, so a subset that breaks a *declared* check is refused, and extras §AM is that end to end. What is **not** verified: a project with no detectable check (the run warns instead), and a subset that is wrong in a way the project's checks do not cover — the review has no cross-file reasoning and moat has no model of what the project means. The check is the project's own floor, not a proof of intent. |
| A merge's hunks as an exhaustive description of the merge | a `both` path is presented as the hunks between your file and the merged bytes, so the review shows what would change in your copy. A conflict between the *two sides'* intentions that the three-way merge resolved silently is not surfaced as such: it arrives as an ordinary hunk, and the review does not say that the merge chose one side. |
| Harness interchangeability, and ACP | **Measured but deliberately not adopted.** The agent-harness seam is written down in `docs/SEAM.md`. A Phase 4 spike drove `@agentclientprotocol/codex-acp` 1.12.0 (digest recomputed and matched, so it pins like everything else in `lib/pins.ts`) against moat's own pinned Codex binary inside a sandbox, over stdio with no port: `initialize`, `authenticate`, `session/new`, a full turn to `end_turn`. Two facts matter for anyone who takes it further and neither is a claim that it is adopted: the adapter is a Node program and the default image has **no `node`** (`node` is a profile, not `BASE_PACKAGES`), and it overrides `approval_policy` per turn from its own mode table, so moat's rendered `approval_policy = "never"` would stop being what decides whether the box asks. The one question that decides whether it *fits* — whether a client can answer `session/request_permission` under moat's configuration — **was not settled**: the adapter never asked in any of its three modes, so "moat keeps its never-ask stance at the protocol level" is unverified. The recommendation in `docs/archive/PROGRESS.md` is not to migrate in this program. |
| Anything about a real model other than what the live suite ran | `bash test/e2e-live.sh` is the only evidence against the hosted model. Everything else runs against the deterministic stub, which cannot show model quality, refusals, or provider-side behaviour. |

## The contract, and the traps

* [`SPEC.md`](SPEC.md) — what each command promises, and where the sharp edges are.
* [`SEAM.md`](SEAM.md) / [`RUNTIMES.md`](RUNTIMES.md) — the agent-harness boundary, and what a second runtime costs.
* [`PORTABILITY.md`](PORTABILITY.md) — what is measured about running outside Linux, and what a container backend would cost.
* `AGENTS.md` — the invariants and the traps, for anyone changing the code.
