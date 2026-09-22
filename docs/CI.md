# Running moat in CI

The `moat` action runs one unattended task in the sandbox and writes a review, so a pipeline can let
an agent loose on real work and hand a human a classified diff instead of an unexpected commit.

```yaml
jobs:
  agent:
    # Self-hosted: see "GitHub-hosted runners cannot run this" below.
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v5
      - uses: nochinsky/moat/.github/actions/moat@main
        with:
          task: Fix the failing tests in src/.
          moat-args: --profile node --max-tokens 200000
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
```

The action uploads the output directory as a `moat-review` artifact: the doctor report, the task's
own log, and `review.txt` — which is what `moat take` prints, the three-way classification plus the
project's own checks.

## GitHub-hosted runners cannot run this

Not a caveat, a measurement, taken in this repository's own CI. On `ubuntu-latest`:

```
host capability probe:
  "userns": false,
  "unprivileged user namespaces are unavailable: `unshare --user --map-root-user` could not
   mount a tmpfs. moat has no host fallback, so it cannot run here."

sandbox end-to-end (ubuntu-24.04):
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  kernel.apparmor_restrict_unprivileged_userns = 0     ← lifted, and unshare is still killed
```

moat isolates with `unshare` + `mount` + `chroot` and **has no host fallback by design**
(`docs/SPEC.md` §2.3, step 1). A runner that cannot create unprivileged user namespaces cannot run
it, and lifting AppArmor is not enough because the runner's own confinement kills `unshare`
afterwards. This is the same wall as macOS — see `docs/PORTABILITY.md`, which is where the
container-backend answer would have to come from.

## What the entrypoint does

`scripts/ci/run-task.sh` is the whole action; the YAML only calls it, because a composite action is
YAML nobody can run locally and this has two branches that both have to be provable.

1. **`moat doctor --json` first.** If `host.userns` is not `true`, it prints the doctor's own
   `host.problems` — the real reason — and exits **2** without running anything. A host that cannot
   sandbox should fail saying so, not fail later with something that reads like a moat bug.
2. **`moat run "<task>"`** — the turn, unattended, in the box. Its log is captured and its exit code
   is the run's.
3. **`moat take --quiet`** — fetch the agent's branch, classify the three trees, and run the
   project's own checks. **Read-only**: nothing reaches the working tree, which is why a CI run can
   produce a review without the host project being touched (SPEC §2.2).

| exit | meaning |
| --- | --- |
| 0 | the task ran and the review was written |
| 1 | the task failed, or the review could not be produced |
| 2 | this host cannot sandbox, or no task was named — nothing was run |

## What it deliberately does not do

* **It does not `moat apply`.** A review is not a decision; writing the agent's work onto a branch in
  CI would be the "automatic apply" the whole design avoids. A workflow that wants the change adds
  its own `moat apply` step, on a branch it chose.
* **It does not open a pull request.** That is a policy question about a repository, not a property
  of the sandbox, and the action stops at the artifact.
* **It does not make a hosted runner work.** Nothing here can; it makes the failure honest.

## Testing the entrypoint

`test/ci-entrypoint.test.sh` runs both branches with a fake `moat` on `PATH`, so it needs no user
namespaces and **does** run on a hosted runner — `ci.yml` runs it in the `checks` job for exactly
that reason. It asserts the refusal, the happy path, a failed task, a failed review, and an empty
task, and it was proved to bite by deleting the user-namespace gate (two checks fail).
