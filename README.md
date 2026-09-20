# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)

moat runs an AI coding agent inside a disposable Linux sandbox on your own machine, with
no container runtime and no permission prompts. The agent gets a copy of your project.
Your machine keeps the original.

That is the whole idea: **autonomy without prompts**, bought by making the blast radius a
box instead of your home directory.

It is not a confidentiality boundary, and the docs say so everywhere it matters. The agent
has to read the project to work on it and has to read the key to call the model, so it has
both. The default network policy only narrows where those can go: an allowlisted address,
or DNS, can still carry them out.

## What a run looks like

```
moat                            # open the agent in this project; boot the box if needed
moat run "fix the failing tests"
moat verify                     # run the project's own checks inside the box
moat fetch                      # bring the agent's branch back as refs/moat/<branch>
moat apply                      # merge that work into this directory, a separate step
moat down                       # stop the box; nothing is lost
moat destroy                    # delete the environment and its snapshots
```

Also useful: `moat exec -- <cmd>` and `moat shell` to work in the box yourself,
`moat logs sandbox` for the boot log, `moat snapshot <name>` / `moat restore <name>`,
`moat doctor` for what the box actually is, and `--profile node,python,cc,...` to have a
toolchain installed when the project needs one.

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

* It does not keep your project or your key secret from the model. It gives the agent both;
  the allowlist only narrows where they can be sent.
* The network policy is a policy, not a jail. Inside the box, root can flush its own
  ruleset. moat re-applies it on every boot and `moat doctor` re-measures it, so you find
  out on the next run, not before.
* Isolation is namespaces, which is v0. A microVM is the next step, not a claim.
* Nothing stops spending. A turn reports what it cost; no ceiling stops it.
* moat does not curate the agent's tools. Codex ships its own and the box bounds them.
  `web_search` is the one entry the config can switch off, and it is off: DeepSeek's API
  accepts that tool and ignores it.

## Layout

```
cmd/main.ts      the CLI; all UX lives here
sandbox/         rootfs, namespaces, profiles, snapshots, isolation checks
sync/            copy-in, copy-out, the three-way apply
secrets/         credential broker, first-run onboarding
bundle/          the rendered Codex config, the model catalog, the agent brief
lib/             provider, catalog, pricing, git, host probe
test/            keyless model stubs, suite scripts, committed evidence
docs/            SPEC (the contract), VERIFICATION (the evidence), HISTORY
```

## Running the tests

```bash
npm run test:unit         # pure unit tests, no sandbox, CI can run these
bash test/e2e-codex.sh    # the acceptance list, against a keyless model stub
bash test/e2e-extras.sh   # snapshots, apply, credential expiry, state and process traps
bash test/e2e-egress.sh   # netns, slirp datapath, loopback closed, allowlist enforced
DEEPSEEK_API_KEY=... bash test/e2e-live.sh   # one real model, one real task
```

The suites write `test/evidence/`, which is committed and quoted by `docs/VERIFICATION.md`.
Regenerate it by running them; do not edit it by hand. Never run two suites at once: they
share `~/moat-demo`.

## Reading order

* `docs/SPEC.md` is the contract: what each command promises, and where the sharp edges are.
* `docs/VERIFICATION.md` is the evidence: the criteria, the captures, and a closing table of
  what is **not** verified. Read that table before believing anything here.
* `docs/HISTORY.md` is how the project got here, including the runtime it used before this
  one.
* `AGENTS.md` is for people changing the code: the invariants, the traps that cost real
  time, and what is still unbuilt.

## Requirements

Linux, `node` 22.18 or newer (types are stripped, there is no build step), and an
unprivileged user namespace. `moat doctor` checks the host and prints its findings before
anything is copied.
