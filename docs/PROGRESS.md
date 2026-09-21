# Where the project stands

moat is built. This page is the short version: what runs, what is green, and what is still open.
The session-by-session record, including every defect found and how each was settled, is in
[`archive/PROGRESS.md`](archive/PROGRESS.md), and the phase program that produced it is in
[`archive/PROGRAM.md`](archive/PROGRAM.md). Both are history; neither tells you what to do next.

`AGENTS.md` remains the contract for anyone changing the code. `SPEC.md` is what the tool
promises. `VERIFICATION.md` is the evidence, and its closing table lists what is *not* verified.

## Where things live

`docs/archive/` holds two documents that were once live instructions and are now records: the
build journal, and the six-phase program that produced the tool. They are worth reading for the
reasoning behind a decision — the journal is where every defect and measurement is written down —
and they are not a to-do list.

`SPEC.md` is the contract and `VERIFICATION.md` is the evidence, so both are long by design:
one states what each command promises, the other quotes the raw output that shows it. The two
files worth reading first are this page and `../README.md`.

The build journal used to sit at `docs/PROGRESS.md` and grew to 1,285 lines of session history
doubling as a status page. It now lives in `archive/PROGRESS.md`, and this page took its place.
Nothing was discarded; the defects, the measurements and the reasoning behind each decision are
all still there.

## State

All five phases passed their gates. The suites run green on `main`:

| suite | result |
| --- | --- |
| `npm run test:unit` | 243 pass, 0 fail |
| `test/e2e-codex.sh` | acceptance list, all criteria passed |
| `test/e2e-extras.sh` | 50 checks, 0 failed |
| `test/e2e-egress.sh` | all egress checks passed |
| `test/e2e-provider.sh` | 9 checks, 0 failed |
| `test/e2e-demo.sh` | 9 checks, 0 failed |
| `test/e2e-review.sh` | 21 checks, 0 failed |

`test/evidence/` holds the raw output from the last clean run of all of them. Regenerate it by
running the suites; never edit it by hand.

## Published

`moat-sandbox` is on npm, currently **0.0.3**, with a provenance record. A release is a tag: the
`v*` tag runs `.github/workflows/release.yml`, which typechecks, tests, checks the tag against
`package.json`, and publishes over GitHub OIDC — no token anywhere. The installed command is
`moat`. Both `moat` and `moat-cli` were already taken by unrelated packages, which is why the
package name and the command differ.

```bash
npx -y moat-sandbox demo     # the first thing a stranger should run
```

A cold start downloads about 560 MB (the Alpine rootfs and the pinned Codex binary) and takes
roughly a minute; later runs are under ten seconds. Verified by running `npx` from a clean
directory with an empty cache, no API key, and no repository — a real boot, a real three-way
classification, and a conflict left alone. That is Phase 5's gate, measured, and the demo says
which artifacts it is about to fetch before it fetches them.

Three things had to change for that to be true, and none of them are visible from inside the
repository: a published package cannot ship TypeScript (Node refuses to strip types under
`node_modules`, so `bin` points at `dist/`), the package root sits at a different depth in the
build than in the source, and `moat demo` read two files from `test/`, which the tarball does not
carry. `AGENTS.md` has a *Packaging* section covering all three, because each was a trap that
looked fine until the artifact was installed.

## Open

One item, and it is a question rather than a task:

**The ACP permission question.** Phase 4's spike showed that the official Codex ACP adapter drives
moat's pinned binary over stdio with no port, which answers the question that mattered most. It
could not show whether `session/request_permission` is answerable under moat's configuration,
because the adapter never asked. This only matters if ACP is ever adopted, and the recommendation
in `archive/PROGRESS.md` is not to adopt it in this program.

Everything else that was open has been closed:

- **Publishing** is done, and it is a tag: `npm version patch --no-git-tag-version`, commit, then
  `git tag v0.0.3 && git push origin main v0.0.3`. `.github/workflows/release.yml` publishes over
  GitHub OIDC, so there is no token to store and every release carries provenance. `AGENTS.md` has
  the details, including the one-time publisher setup on npmjs.com.
- **The cold cache is measured**, not argued: see *Published* above.
- **Package metadata is current as of 0.0.3**, which carries the corrected keywords and the
  `SECURITY.md`, `CONTRIBUTING.md` and `RUNTIMES.md` that 0.0.2 predated.

**The cold-cache half of Phase 5's gate.** The tarball install and `moat demo` were measured with
a warm cache. A genuinely cold one means roughly 560 MB of downloads, and it was skipped rather
than run. The download path is untouched by packaging and the tarball carries no data files, so a
cold start should fetch exactly what a warm-cache source run does. That reasoning has not been
tested, and it is the cheapest open item to close.

**The ACP permission question.** Phase 4's spike showed that the official Codex ACP adapter drives
moat's pinned binary over stdio with no port, which answers the question that mattered most. It
could not show whether `session/request_permission` is answerable under moat's configuration,
because the adapter never asked. This only matters if ACP is ever adopted, and the recommendation
in `archive/PROGRESS.md` is not to adopt it in this program.

## Not built, and not claimed

Listed in `AGENTS.md` under *Where this is going*: the second half of the egress policy (a
resolving proxy moat would own, rather than an IP snapshot), provider-side credential scoping,
cost ceilings, byte paths for filenames that are not valid UTF-8, tool-set curation, and the v1
microVM. `VERIFICATION.md`'s closing table is the authoritative list of what remains unverified.

## The first run asks for the key before it downloads anything

A cold `moat up` used to provision first and ask second: the image download (several hundred
megabytes, minutes on a cold cache) completed before the prompt that said a key was needed. Someone
without one paid for the whole download and then hit a question they could not answer.

The ask now happens before provisioning, and only when the answer is still unknown — an environment
variable, the credential store or a flag needs no prompt, and an existing environment does not
provision at all. `onboard` saves the key and the mint below reads it exactly as before, so this is
an order change rather than a behaviour change. Two things worth knowing about it:

* **It degrades.** Cancelling the prompt returns null and the boot carries on to the same
  "no credential" notice it would have printed anyway. An unreachable provider saves the key
  unchecked, which is what `onboard` already did.
* **It is untested at the end-to-end level.** The prompt only appears when stdin is a terminal, and
  exercising that needs a pty. The change is four lines and every suite passes, but nothing in
  `test/` would catch a regression that moved the prompt back after provisioning. Recorded rather
  than papered over.

## Repository surface

`SECURITY.md` says how to report a vulnerability privately and, more usefully, lists what is *not*
one: the agent reading your key, the egress policy being a policy rather than a jail, namespaces
rather than a VM, and the bounds on the copy-out leak scan. Each of those is a documented tradeoff
in `SPEC.md` §1.2 or the Not-verified table, so a report about one is a documentation question
rather than a security one.

`CONTRIBUTING.md` holds what `AGENTS.md` does not: setup, which suite covers what, and what gets a
pull request sent back. Its hardest rule is the one the project keeps relearning — a change arrives
with a test that fails without it. Three guards in this repository's history looked like coverage
and were not: an assertion satisfied by unrelated warning text, a check of a guard the CLI filters
before it can be reached, and a regex that matched nothing because the file had CRLF endings.

Both ship in the npm tarball, and the README points at them.

## Two things worth knowing before you touch anything

The published history was rewritten once, on the owner's instruction, to remove session passwords
that had been committed. Every commit SHA changed as a result, so a clone from before that work
must be re-created rather than pulled.

`test/evidence/onboard.txt` is gitignored and must stay that way: the onboarding smoke test writes
the CLI's own first-run output into it, and that output contains a session password.
