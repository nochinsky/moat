# moat

[![ci](https://github.com/nochinsky/moat/actions/workflows/ci.yml/badge.svg)](https://github.com/nochinsky/moat/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/moat-sandbox)](https://www.npmjs.com/package/moat-sandbox)

**Run an extensible coding agent on a project copy. Review its work hunk by hunk before
it reaches your working tree.**

moat copies your project into a persistent, disposable Linux sandbox and runs **Pi** there.
The agent gets tools, a package manager and room to work without built-in tool approval dialogs.
Your authoritative project stays on the host. Fetching creates a review ref; applying changes is a
separate, explicit decision.

The default backend uses Linux namespaces and chroot directly: **no Docker, podman or daemon is
required**. The box limits the filesystem blast radius; it is **not a confidentiality boundary**
and does not impose CPU, memory or disk quotas.

> **Pi is the only harness from 0.1.0 onward.** Earlier npm releases use the retired harnesses.
> Existing environments upgrade in place, preserving sandbox work. There is no `--runtime` selector.

## Try it without a key

```bash
npx -y moat-sandbox@latest demo
```

The demo boots a real sandbox, runs Pi against a scripted model, and shows a three-way review:
the agent's changes, your changes and a conflict that moat refuses to overwrite. It uses a scratch
project, leaves your current directory alone, and spends no model tokens.

## Install and run

**Requirements:** Linux x86-64 (including WSL2), Node **22.18+**, Git and the usual Linux namespace,
mount and archive utilities. Unprivileged user namespaces must be available. No root or container
runtime is required. macOS, native Windows and ARM are not supported by this release.

```bash
npm install -g moat-sandbox@latest    # package: moat-sandbox; installed command: moat
moat doctor                         # check the host before creating an environment
```

In a project with a Git commit:

```bash
moat                                # boot and open Pi's TUI
moat run "fix the failing tests"     # run a task in the sandbox
moat verify                         # run the project's checks inside the box
moat take                           # fetch and review; your tree stays unchanged
moat apply                          # explicitly accept files or hunks
moat down                           # stop; retain work, packages and sessions
```

DeepSeek is the default provider. At a terminal, first-run onboarding asks for a key; for automation,
set `DEEPSEEK_API_KEY` in the launching environment. Prefer a short-lived, provider-scoped key with
a low provider-side spend limit. **Do not put keys in project files or command arguments.** Named
providers must be configured explicitly with `moat provider add`; moat never chooses a provider
because it found another vendor's key. `--base-url` supports OpenAI-compatible endpoints, and
`--wire-api responses|chat` selects the protocol. See [`docs/PI.md`](docs/PI.md).

For a monitored headless task:

```bash
moat run --no-follow --timeout 180 --max-tokens 30000 --max-cost 0.10 \
  "fix the failing tests, run them, and commit your changes"
```

Ceilings cover **reported usage for that invocation**, not a session or day. Unknown prices warn
rather than become free; providers may report only after a request finishes, and extensions can
make unreported calls. Provider-side limits are the hard spending bound.

## Review is a separate step

moat records the original HEAD as a baseline while copying your uncommitted work for the agent to
see. Review compares that baseline, the agent's proposal and your current files. Each change is
classified as *agent*, *you*, *both* or *conflict*.

`moat apply` writes only what you accept. Use `--only`/`--skip` for files, or `--hunks 1,3-5` for
part of a file. Paths changed by both sides need explicit selection; unresolved conflicts are
never overwritten. Rejecting everything writes nothing. Partial accepts run your project's checks
against **your current tree plus exactly the accepted subset**, in scratch space inside the box.
A failing check writes nothing. Passing checks establish coherence, not correctness or intent.

Other useful commands:

| command | purpose |
| --- | --- |
| `moat exec -- <command>` / `moat shell` | Work inside the box yourself. |
| `moat status` / `moat logs sandbox` | Inspect lifecycle and bounded boot logs. |
| `moat snapshot <name>` / `moat restore <name>` | Save/restore installed state while retaining project work. |
| `moat up --sync` | Explicitly re-copy the host project. |
| `moat destroy` | Delete the environment and snapshots after confirmation. |
| `moat profiles` | List available toolchains; database services are opt-in. |

## Customize Pi, inside the box

Commit `.pi/settings.json`, `.pi/extensions/`, skills, prompts or MCP configuration with your
project. Pi loads the copied resources **inside the sandbox**, so extensions can add tools and
workflows without a host-side agent SDK. Moat does not forward host `~/.pi`, auth/OAuth state,
SSH agents, settings or extensions. Pi session history stays in the persistent rootfs.

Moat provisions Alpine with Node/npm and a pinned Pi CLI whose complete dependency graph is
SHA-256 locked and whose archives are SHA-512 verified. No dependency installation scripts execute
on the host. Every boot regenerates sandbox-local settings, the model definition and the brief;
missing runtime files or an old in-box Node are repaired without re-provisioning over `/work`.

Copied extensions are **trusted executable configuration**, not vetted confinement. They can read
the project and key, change models, introduce approval dialogs or wait for UI input. Packages and
MCP servers may need in-box installation and additional network destinations. See
[`docs/PI.md`](docs/PI.md) for examples and compatibility limits.

## Boundaries and limitations

- **The host project is copied, never mounted.** On the default backend only six device nodes
  are host binds; other mounts are sandbox-local or fresh pseudo-filesystems. `moat doctor`
  measures the environment once one exists, including mounts, namespaces and exposures.
- **The key is readable by the agent.** Moat injects it through the environment, not image files,
  config or argv. An agent or extension can still persist or send it elsewhere. Copy-out leak
  scans are bounded warnings, not guarantees or apply gates.
- **Default egress is filtered, not tamper-proof.** The allowlist is a boot-time IP snapshot, DNS
  remains an outbound channel, and root inside the box can flush nftables. Host loopback is closed
  in filtered/isolated modes; `open` shares the host network. Loopback providers default to open.
- **`--egress-proxy` is the separately enforced option.** It requires host `ip(8)` and gives the
  box no direct route or working resolver. Allowed destinations can still carry out data or keys.
- **Namespaces share the host kernel and resources.** A microVM backend and resource quotas are
  not implemented. This is not a promise against kernel exploits or resource exhaustion.
- **`--backend container` is explicit rootless podman support.** It still uses a copied project.
  Hosted Ubuntu 22.04/24.04 pass real Pi task/budget/timeout/expiry/cleanup checks with an explicit
  open/loopback stub, plus separate filtered boot/checks. External filtered/proxied Pi container
  turns are not measured. Choosing it does not make macOS or native Windows supported.

The [`verification limits`](docs/VERIFICATION.md#not-verified) are part of the product, not fine
print. Read them before choosing how much to trust the box.

## Develop from a checkout

```bash
git clone https://github.com/nochinsky/moat.git
cd moat
npm ci
npm run moat -- demo                 # current sources, no API key
npm run typecheck
npm run test:unit                    # pure logic; runs on hosted CI
bash test/e2e-pi.sh                  # real Pi CLI, scripted model, sandbox acceptance
python3 test/pi-tui.py               # Pi's TUI on a real pty
bash test/pi-legacy.sh               # upgrade an actual 0.0.3 environment in place
bash test/pi-package.sh              # install the tarball and run its sandbox demo
bash test/e2e-extras.sh              # lifecycle, snapshots, expiry and state regressions
bash test/e2e-egress.sh              # datapath, loopback, allowlist and proxy
bash test/e2e-provider.sh
bash test/e2e-demo.sh
bash test/e2e-review.sh
# With a spend-capped DEEPSEEK_API_KEY in this shell:
bash test/pi-live.sh                 # bounded current-Pi provider smoke test
```

Development runs TypeScript directly through Node's type stripping. `npm run build` is for the
published tarball: it ships compiled `dist/` because Node cannot strip types inside `node_modules`.

Run sandbox suites **sequentially** on a host that supports user namespaces. The current hosted
Ubuntu 22.04/24.04 CI runs pass them after the workflow's capability setup/probe; other runner
policies may refuse namespaces. Absence is reported, not counted as a pass. See [`docs/CI.md`](docs/CI.md).
Suites write committed evidence under `test/evidence/`; regenerate it rather than editing it.

## Read more

- [`docs/TRUST.md`](docs/TRUST.md): generated suite verdicts and unverified claims.
- [`docs/SPEC.md`](docs/SPEC.md): the current contract.
- [`docs/PI.md`](docs/PI.md) / [`docs/SEAM.md`](docs/SEAM.md): customization and the host/agent boundary.
- [`docs/PROGRESS.md`](docs/PROGRESS.md): status and open work.
- [`docs/RELEASE.md`](docs/RELEASE.md) / [`CHANGELOG.md`](CHANGELOG.md): release gates and migration notes.
- [`docs/CI.md`](docs/CI.md): unattended tasks on capable hosted or self-hosted Linux runners.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) / [`AGENTS.md`](AGENTS.md): contributing and load-bearing constraints.
- [`SECURITY.md`](SECURITY.md): private vulnerability reporting and documented non-goals.

`docs/archive/`, `HISTORY.md` and `RUNTIMES.md` preserve earlier measurements; they do not describe
supported runtime switches. The npm name is **moat-sandbox**: `npx moat` and `npx moat-cli` fetch
unrelated packages.
