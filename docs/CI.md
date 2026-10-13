# Running moat in CI

The `moat` action runs one unattended task in the sandbox and writes a review. It does not apply
changes or open a pull request. **The requirement is usable Linux user namespaces, not a particular
runner brand.** Probe the actual host; never fall back to running the agent on the host.

## Current hosted-runner evidence

The 0.1.0 release commit passed the real Pi acceptance, extras and egress suites on GitHub-hosted
**Ubuntu 22.04 and Ubuntu 24.04**. The run is
[`38170437071`](https://github.com/nochinsky/moat/actions/runs/38170437071), source commit
`88e9bda095668b29667d845dbc52c2d0ef820138`. `test/evidence/ci-hosted.txt` is generated from its job
results **and the uploaded suite captures**, not only green job labels:

```bash
bash test/ci-hosted.sh 38170437071
```

Older captures reported unavailable namespaces, and earlier docs generalized that to all hosted
runners. The workflow probe also had a defect: its tmpfs mount target did not exist, so a capable
runner could be falsely skipped. The probe now uses a unique existing directory. These current
passing runs supersede the blanket limitation; they do not promise that every future runner,
organization policy or kernel configuration will allow namespaces.

The repository workflow lifts `kernel.apparmor_restrict_unprivileged_userns` when present, then
probes actual namespace/mount capability. A workflow without that permission may still be refused.
A self-hosted Linux runner is another option, not a universal requirement. macOS and native Windows
remain unsupported by this release.

## Focused compatibility evidence

The follow-up run [`38331376464`](https://github.com/nochinsky/moat/actions/runs/38331376464)
passes the unborn-project, local package/stdio MCP/session-resume and real Pi container-task suites
on both hosted Ubuntu versions. Validate the actual captures with:

```sh
bash test/pi-compatibility-hosted.sh 38331376464
```

The container fixture checks default filtered boot/rules separately from its real Pi task using an
explicit open/loopback model stub. It includes budget stops, tool timeout, credential expiry and
container removal. Missing/unusable Podman exits 77; CI does not accept that as success.
A manual dispatch with `scope=pi-compatibility` runs just these focused sandbox suites plus the
build/unit job; it does not establish new acceptance/extras/egress evidence. Pushes and PRs always
run the full suites. Existing 0.1.0 release evidence above remains distinct.

## Example

```yaml
jobs:
  agent:
    runs-on: ubuntu-24.04  # or a capable self-hosted Linux runner
    steps:
      - uses: actions/checkout@v5
      - name: Allow user namespaces where AppArmor restricts them
        run: |
          if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          fi
      - uses: nochinsky/moat/.github/actions/moat@v0.1.0
        with:
          task: Fix the failing tests in src/ and commit the fix.
          moat-args: --profile node --timeout 180 --max-tokens 30000 --max-cost 0.10
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

Use a provider-scoped credential with a low provider-side spend cap. The streamed limits monitor
reported usage for one task, not every request an extension might make or an aggregate daily budget.
The agent can read the injected key and project. A pipeline should still review the result.

The action uploads a `moat-review` artifact: the doctor report, task log and `review.json`.
[`SPEC.md` §4](SPEC.md#4-review-and-apply) describes the review contract. Its `review` output points
to that JSON file.

## What the entrypoint does

`scripts/ci/run-task.sh` is the entrypoint; the composite YAML invokes it.

1. **`moat doctor --json` first.** If the command fails or `host.userns` is not `true`, refuse with
   the doctor's reason and exit **2** before the task. No host-agent fallback.
2. **`moat run "<task>"`.** Run unattended in the box, with stdin closed and captured logs.
3. **`moat take --json --quiet`.** Fetch a review ref, classify the trees and run the project's
   checks. The summary is derived from JSON. The host working tree is not written.

| exit | meaning |
| --- | --- |
| 0 | the task ran and a review was written; inspect its check verdict before accepting |
| 1 | the task failed, or the review could not be produced |
| 2 | the host cannot sandbox or no task was named; nothing was run |

## What it does not do

- **No `moat apply`.** Writing accepted changes is a separate explicit workflow decision.
- **No automatic pull request.** The action stops at a review artifact.
- **No workaround for an incapable runner.** It reports a refusal rather than relaxing isolation.
- **No universal hosted-runner guarantee.** The current passing configurations are evidence,
  not a promise about every image or future kernel policy.

## Tests and release gates

`test/ci-entrypoint.test.sh` exercises refusal, success, failed task/review and empty-task paths
with a fake CLI; it needs no namespaces. `test/unit/ci-action.test.ts` executes the declared shell
body and validates the JSON output path, and checks that the namespace probe receives an existing
mount target. Restoring either old action path/output or the missing-target probe fails the guard.

The real sandbox work is measured separately by the namespace suites and the uploaded artifacts.
TUI, old-environment upgrade, installed-package and real-provider gates are still run locally before
release. The tag publication workflow checks type/unit/trust/package assets; the main CI workflow
runs sandbox suites **only when the capability probe succeeds**. A skipped suite is not a pass.
