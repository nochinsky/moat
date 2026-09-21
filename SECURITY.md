# Reporting a security issue

moat runs an untrusted coding agent on your machine, and it handles your provider key. Those two
facts make some reports much more valuable than others, so this file says up front what counts as
a vulnerability here and what is a documented design decision.

Please report privately rather than opening an issue: use GitHub's
[private vulnerability reporting](https://github.com/nochinsky/moat/security/advisories/new), or
email the maintainer if you would rather not use GitHub.

## What would be a real vulnerability

Anything that breaks a promise `docs/SPEC.md` makes. The ones that matter most:

- **A way out of the sandbox.** The agent is root inside its own rootfs. Reaching the host
  filesystem, the host's other processes, or the host's loopback from inside a `filtered` or
  `isolated` box would be serious.
- **A host-side code execution path.** The sandbox's git repository is agent-controlled, and moat
  shells out to git against it. `core.fsmonitor`, `hooksPath`, `filter.*`, `diff.external` and
  aliases are all ways to make the host run something the agent wrote; they are swapped out by
  `lib/git.ts`, and a way around that is a vulnerability.
- **A write outside the project directory.** `moat apply` merges the agent's work into your
  working tree and is supposed to stay inside it, including through symlinks.
- **Surviving a snapshot or a `down`/`up` cycle in a way that changes what `moat doctor` reports.**
  The doctor's job is to describe the box the agent actually gets. A box that can make itself
  look safer than it is defeats the only measurement a user has.
- **A credential reaching the image or a boot artifact.** The key is passed as an environment
  variable and is never written to a file by moat. Finding it in a cached image, a rendered
  config, or a log would be a vulnerability.

## What is not a vulnerability

These are deliberate, and `docs/SPEC.md` §1.2 and `docs/VERIFICATION.md`'s closing table describe
each one, including what it costs you:

- **The agent can read your project and the key.** It has to, to do its job. moat is not a
  confidentiality boundary and never claims to be one.
- **The egress allowlist is a policy, not a jail.** The sandbox owns its network namespace, so
  root inside it can flush the ruleset. moat re-applies it on every boot and `moat doctor`
  re-measures it, which is detection on the next run rather than prevention.
- **Data can leave through an allowlisted host or through DNS.** Narrowing where the agent can
  send things is not the same as stopping it, and the docs say so in those words.
- **Isolation is Linux namespaces, not a virtual machine.** A kernel bug is a sandbox escape;
  that is what the planned v1 microVM is for.
- **The copy-out credential scan has bounds.** It compares against the values the host holds at
  fetch time, searches the most recent 50 commits, and skips files above a size limit. Each bound
  is named when it is reached.

If your report is that one of those is worse than documented, that *is* worth sending — a
measurement that contradicts the docs is a documentation bug at minimum.

## What to expect

This is a small project maintained by one person, so there is no formal SLA and no bounty. What
you get is an honest answer: whether it reproduces, what the fix would involve, and a note in the
journal either way. If it reproduces, the fix gets a test that fails without it, because a check
that cannot fail is not a check.
