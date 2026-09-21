# Where the project stands

moat is built and the six phases of `PROGRAM.md` are closed. This page is the short version:
what runs, what is green, and what is still open. The session-by-session record, including every
defect found and how each was settled, is in [`archive/PROGRESS.md`](archive/PROGRESS.md).

`AGENTS.md` remains the contract for anyone changing the code. `SPEC.md` is what the tool
promises. `VERIFICATION.md` is the evidence, and its closing table lists what is *not* verified.

## Where things live

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

## Shipped

The package is publishable, not published. It is `moat-sandbox` on npm (both `moat` and `moat-cli` belong to unrelated
packages), while the installed command stays `moat`.

```bash
npm pack                     # builds dist/ via prepack, then packages it
npm publish                  # the owner's step; not done yet
```

A tarball installed into a clean prefix runs `moat demo` end to end with no API key: a real boot,
a real three-way classification, a conflict left alone. That is Phase 5's gate, measured.

Three things had to change for that to be true, and none of them are visible from inside the
repository: a published package cannot ship TypeScript (Node refuses to strip types under
`node_modules`, so `bin` points at `dist/`), the package root sits at a different depth in the
build than in the source, and `moat demo` read two files from `test/`, which the tarball does not
carry. `AGENTS.md` has a *Packaging* section covering all three, because each was a trap that
looked fine until the artifact was installed.

## Open

Three items, in the order they are likely to matter:

**Publishing.** One command for a logged-in owner. Everything up to it is verified.

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

## Two things worth knowing before you touch anything

The published history was rewritten once, on the owner's instruction, to remove session passwords
that had been committed. Every commit SHA changed as a result, so a clone from before that work
must be re-created rather than pulled.

`test/evidence/onboard.txt` is gitignored and must stay that way: the onboarding smoke test writes
the CLI's own first-run output into it, and that output contains a session password.
