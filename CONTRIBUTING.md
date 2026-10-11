# Contributing

moat is a Linux sandbox that runs an untrusted coding agent, so the code has more load-bearing
constraints than its size suggests. `AGENTS.md` is the contract: read it before changing anything.
It is long because the traps cost real debugging time; the constraints that are not obvious
from reading the code are the ones that matter.

This file covers the parts a contributor needs that `AGENTS.md` does not: how to get set up, what
a change has to come with, and what will get a pull request sent back.

## Getting set up

You need Linux x86-64, `node` 22.18 or newer, Git and unprivileged user namespaces.
The default backend needs no Docker or root. Pi's in-box Node requirement is handled by moat.

```bash
git clone https://github.com/nochinsky/moat && cd moat
npm ci
npm run test:unit        # seconds, no sandbox, this is what CI runs
./cmd/main.ts doctor     # does this machine support the sandbox at all?
./cmd/main.ts demo       # end-to-end proof, no API key needed
```

`moat` runs the TypeScript sources directly — Node strips the types — so there is no build step
during development. `npm run build` exists only to make the published tarball, because Node
refuses to strip types inside `node_modules`.

## What a change has to come with

**A test that fails without the change.** This is the one rule the project takes most seriously.
Reintroduce the bug, watch the test fail, then keep it. Several guards in this repository were
written, then found to be incapable of failing — an assertion satisfied by unrelated warning text,
a check of a guard the CLI filters before it can be reached, a regex that matched nothing because
the file had CRLF line endings. Each of those looked like coverage and was not. If you cannot make
your test fail, say so in the pull request rather than shipping it.

**The right suite.** `npm run test:unit` for pure logic. `bash test/e2e-extras.sh` for anything
touching copy-in, copy-out, apply, snapshots or state. `bash test/e2e-pi.sh` for the Pi
harness, config, extensions or event parser; `python3 test/pi-tui.py` for interactive boot. `bash test/e2e-egress.sh` for network policy.
`bash test/e2e-review.sh` for `moat apply`'s classification and partial accepts. They need user
namespaces; current hosted Ubuntu CI runs pass them after capability setup, while other runners
may refuse. Run relevant local gates too and say what you saw; a skipped CI suite is not a pass.

**Evidence, by running the suites.** `test/evidence/` is committed and quoted by
`docs/VERIFICATION.md`. Never hand-edit it.

**Current documentation if behaviour changed.** Update `docs/PROGRESS.md`, the relevant contract
and `docs/VERIFICATION.md`. `docs/archive/` preserves earlier session records, not the current
status. Say what you measured before and after; "fixed" without a before-measurement is a claim,
not a result. Release gates and the bounded paid-provider test are in [`docs/RELEASE.md`](docs/RELEASE.md).

## What will get sent back

- **Weakening a check to make something pass.** If a gate cannot pass without loosening it, the
  answer is to say so in the open, not to loosen it. That is written into the project's own stop
  conditions.
- **Unnecessary host dependencies.** The host controller uses the standard library and existing
  tools. Pi's in-box npm graph is separately pinned and verified in `bundle/pi-runtime/`; changes
  to it require a lock-pin update and acceptance tests. No Pi dependency lifecycle scripts run on the host; moat's own trusted build/pack hooks do.
  A dependency touching the credential path or sandbox boundary needs a very good reason.
- **A download that skips digest verification.** Everything fetched at runtime is pinned in
  `lib/pins.ts` and checked before it is unpacked.
- **Untested claims in prose.** The docs are the product here. If you write that something is
  verified, it has to be — with the capture or the test to back it. Numbers the tool prints do not
  belong in `SPEC.md`; they drift and nothing keeps them honest.
- **AI-generated padding.** Long comments restating the code, docstrings on self-evident
  functions, or a paragraph where a sentence would do. The comments in this repository explain
  *why* and what was measured; that is the standard.

## Style

There is no linter and no formatter config, which means the code around you is the style guide.
Two things worth matching: comments explain reasoning and cite measurements rather than describing
what the next line does, and error messages say what happened and what to do about it.

## Security

Do not open an issue for a vulnerability — see [`SECURITY.md`](SECURITY.md), which also lists what
this project deliberately does *not* protect against. Reading that list first will save you writing
up something that is working as designed.
