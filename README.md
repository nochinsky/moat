# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)

**See exactly what your agent did, accept it hunk by hunk, and know it never touched your
machine.**

Every other tool works inside your repo, where the agent's edits and yours are
indistinguishable. moat records a baseline before the agent starts, so afterwards it can tell
you which changes are the agent's, which are yours, and which are both — and then apply the
part you actually want.

It does that by copying your project into a disposable Linux sandbox and running the agent
there. Nothing crosses back until you say so. There is no container runtime involved:
`unshare`, `mount` and `chroot` directly, no Docker, no daemon.

That is the whole idea: **autonomy without prompts**, bought by making the blast radius a box
instead of your home directory.

## See it work, in a minute, with no API key

```bash
npx -y moat-sandbox demo
```

This makes a scratch project, boots a real sandbox, runs a real agent against a scripted model,
and shows the three-way classification on your terminal: what the agent changed, what you
changed, and the file you both touched — which moat refuses to write and hands back to you. It
costs nothing and needs no credential, because the point being demonstrated is not the model.
It leaves your directory alone and removes its scratch project afterwards.

## Install

```bash
npx -y moat-sandbox       # run without installing
npm i -g moat-sandbox     # or install it; the command is still `moat`
```

Then, in a project you have committed to git:

```bash
moat                     # open the agent in this project; boot the box if needed
moat run "fix the failing tests"
moat verify              # run the project's own checks inside the box
moat take                # review what the agent did, per file and per hunk
moat apply               # write the part you accepted — a separate, explicit step
moat down                # stop the box; nothing is lost
```

`moat apply` is not one decision. It classifies every changed path as *agent*, *you*, *both* or
*conflict*, shows each change per hunk, and writes only what you choose: whole files with
`--only`/`--skip`, or `--hunks 1,3-5` for part of one. A file you both changed is never written
unless you ask for it by name, and even then only after moat tells you it is a conflict.

Also useful: `moat exec -- <cmd>` and `moat shell` to work in the box yourself, `moat logs
sandbox` for the boot log, `moat snapshot <name>` / `moat restore <name>`, `moat doctor` for
what the box actually is, and `--profile node,python,cc,...` to have a toolchain installed when
the project needs one.

## What a boot does

1. Copies the project with git (`clone --no-hardlinks`), never a bind mount. The only host
   things inside are six device nodes.
2. Builds an Alpine image once and reuses it: bash, git, curl, ripgrep, nftables, and the
   pinned Codex CLI as a musl binary. No Docker, no podman, no daemon.
3. Boots it with its own mount, pid, user, uts and ipc namespaces, and its own network
   namespace behind slirp4netns unless egress is `open`.
4. Renders `/root/.codex/config.toml`, `/root/.codex/models.json` and
   `/root/.codex/AGENTS.md` into the box on every boot, through a guard that refuses to
   follow a symlink the agent planted.
5. Passes the provider key as an environment variable, never as a file. `moat doctor` shows
   what the box can see.

The agent runs as a task (`codex exec --json`, whose stream moat reads and prices) or as its
own TUI, which moat hands a real terminal. Both run inside the box. The host is a terminal
and a log reader, nothing more.

## What it does not do

This is the part most projects leave out. Read it before deciding how much to trust the box.

* **It does not keep your project or your key secret from the model.** It gives the agent both;
  the allowlist only narrows where they can be sent. Egress to an allowlisted address, or over
  DNS, can still carry them out.
* **The network policy is a policy, not a jail.** Inside the box, root owns its network
  namespace and can flush the ruleset. moat re-applies it on every boot and `moat doctor`
  re-measures it, so you find out on the next run — never before.
* **Isolation is namespaces, which is v0.** A microVM is the next step, not a claim.
* **Nothing stops spending.** A turn reports what it cost; no ceiling stops it.
* **moat does not curate the agent's tools.** Codex ships its own and the box bounds them.
  `web_search` is the one entry the config can switch off, and it is off: DeepSeek's API
  accepts that tool and ignores it.
* **A partial accept is checked for coherence, not for correctness.** Taking a subset of a
  change now runs the project's own checks against exactly what is about to be written, and
  refuses to write when they fail — so "take hunk 2 and reject the hunk that makes it compile"
  is caught rather than written. What that does *not* buy is cross-file reasoning or a proof
  the subset is what you meant: it says the check you already have still passes, no more.

`docs/VERIFICATION.md` ends with a table of everything that is **not** verified. It is the
honest half of this section and it is longer.

## Requirements

Linux, `node` 22.18 or newer, and an unprivileged user namespace. No container runtime, no
daemon, no root.

`moat doctor` checks the host and prints its findings — including the sandbox's mount table and
the environment it can see — before anything is copied. If your machine cannot create a user
namespace, it says so instead of failing later.

## Layout

```
cmd/main.ts      the CLI; all UX lives here
sandbox/         rootfs, namespaces, profiles, snapshots, isolation checks
sync/            copy-in, copy-out, the three-way apply
secrets/         credential broker, first-run onboarding
bundle/          the rendered Codex config, the model catalog, the agent brief
lib/             provider, catalog, pricing, git, host probe
stub/            the keyless model stub (`moat demo` ships it, so it lives here)
test/            the suite scripts and the committed evidence they write
docs/            SPEC (the contract), VERIFICATION (the evidence), HISTORY, SEAM
```

## Working on moat

`node` 22.18+ strips TypeScript types natively, so development has no build step: the CLI runs the
sources directly. `npm run build` exists only for the published tarball, whose `dist/` is compiled
because **Node refuses to strip types inside `node_modules`** — a published package cannot ship
`.ts`.

```bash
npm run test:unit         # pure unit tests, no sandbox, CI runs these
bash test/e2e-codex.sh    # the acceptance list, against a keyless model stub
bash test/e2e-extras.sh   # snapshots, apply, credential expiry, state and process traps
bash test/e2e-egress.sh   # netns, slirp datapath, loopback closed, allowlist enforced
bash test/e2e-provider.sh # a named, non-DeepSeek provider, end to end
bash test/e2e-demo.sh     # `moat demo`: three-way attribution, keyless
bash test/e2e-review.sh   # the review surface: per-hunk attribution, a partial accept
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # one real model, one real task
```

The sandbox suites need a user namespace, which GitHub's runners cannot provide, so they run
locally. They write `test/evidence/`, which is committed and quoted by `docs/VERIFICATION.md` —
regenerate it by running them rather than editing it. Do not run two at once; they share
`~/moat-demo`.

Bug reports and pull requests are welcome. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers what a
change has to come with and what will get sent back. Found a security problem?
[`SECURITY.md`](SECURITY.md) says how to report it privately, and lists what moat deliberately does
**not** protect against.

## Reading order

* `docs/SPEC.md` is the contract: what each command promises, and where the sharp edges are.
* `docs/VERIFICATION.md` is the evidence: the criteria, the captures, and the closing table of
  what is **not** verified. Read that table before believing anything here.
* `docs/HISTORY.md` is how the project got here, including the runtime it used before this one.
* `docs/SEAM.md` is the interface a second agent runtime would have to satisfy, and
  `docs/RUNTIMES.md` is what adding one costs — including why it is not a protocol problem.
* `AGENTS.md` is for people changing the code: the invariants, the traps that cost real time,
  and what is still unbuilt.
