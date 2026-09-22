# The egress datapath: what is measured, and what is open

moat's egress policy today is a network namespace, the pinned slirp4netns datapath, and an nftables
default-deny allowlist over addresses resolved at boot. `AGENTS.md` names its three remaining holes
— the allowlist is an IP snapshot (a rotating CDN address falls out until the next `moat up`), it
cannot express per-host ports, and DNS to slirp's resolver is still an outbound channel — and says
what closing them means: **"a resolving proxy moat owns, not a bigger ruleset."**

This page records the measurements that decide whether that is the shape. It is a **measurement
record, not a design**, and it is the companion to `test/proxy-spike.sh`, which takes §1 on any
host that can boot a box. The v1 half of the same question — a microVM's datapath, which is a
different problem — is `docs/MICROVM.md` §4.

## 1. The reading the whole idea depends on: the runtimes do use a proxy

A terminating proxy is only an egress point if the agent's own HTTP client sends its traffic there.
Both runtimes are third-party binaries, so this is a fact about them rather than a choice moat makes:

| runtime | control, no proxy variables | with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` set |
| --- | --- | --- |
| codex | endpoint **30** requests, proxy **0** | endpoint **0**, proxy **33** — including `POST http://127.0.0.1:47421/v1/responses` |
| claude | endpoint **8** requests, proxy **0** | endpoint **0**, proxy **16** — including `POST http://127.0.0.1:47421/v1/messages?beta=true` |

Both run the same turn against a recording endpoint on the host's loopback, with a recording proxy
on another port; the two logs say which one received the model request. Both recorders answer 502,
so nothing is forwarded anywhere. The control is a **precondition**: if the runtime did not reach the
endpoint with no proxy set, the run measures nothing and says so.

So: **the standard variables are enough, for both runtimes, with no per-runtime integration for the
proxying itself.** A proxy moat owns is a viable egress point, and the work that remains is the
proxy and the policy rather than persuading the agent to use it.

## 2. What else the runtimes talk to, which a name-based allowlist has to decide about

The same recordings show connections that are not the model call. Naming them matters, because a
name-based policy will be asked about them and nobody has measured what happens if they are refused:

* **codex** → `github.com:443`, `api.github.com:443`, `chatgpt.com:443`
* **claude** → `api.anthropic.com:443` (its own default endpoint, and for Claude the model host) and
  **`http-intake.logs.us5.datadoghq.com:443`** — telemetry.

That last one is worth stating plainly: a runtime moat runs in the box ships usage data to Datadog.
Refusing it looked like a policy with an unknown cost, so it was measured — `test/proxy-spike.sh`
runs the same turn with the vendor hosts reachable, refused, and black-holed (a drop):

```
reachable    exit=0  9195ms  model requests=2  17280 tokens
refused      exit=0   973ms  model requests=2  17280 tokens
black-holed  exit=0   987ms  model requests=2  17280 tokens
```

Refusing **or** dropping them changes nothing about what the turn does and makes it roughly **8x
faster** — the ~8 seconds the control spends are the runtime's own vendor chatter. So a name-based
policy is free here rather than risky. Two things are not measured: this is a *keyless* turn against
the stub, so a real key's account traffic was never exercised, and Claude was not put through the
same three cases (its vendor set is `api.anthropic.com` and Datadog).

## 3. moat cannot set those variables today

`MOAT_SANDBOX_ENV` is the escape hatch for putting extra variables in the box, and it accepts only
`MOAT_`-prefixed names (`sandbox/launcher.ts`: *"only MOAT_ prefixed names may enter the sandbox"*).
`HTTP_PROXY` is not one, so a proxy cannot be configured in — it has to become part of the managed
environment on a boot. That is a small change, but it is a change to moat rather than to
configuration, and it is why this reading had to be taken with the variables set by hand inside the
box.

## 4. Where the proxy can live, and what is still open

* **Where the proxy can live — measured.** The §1 reading uses `--egress open`, the one mode where
  the host's loopback is reachable from the box. Under `isolated` (the stricter of the other two),
  taken from `test/proxy-spike.sh` with a listener on the host's own address as the control:

  ```
  outbound to 1.1.1.1     : OK          the box has a working uplink
  host's loopback         : refused    127.0.0.1 and slirp's 10.0.2.2 gateway, both
  host's non-loopback     : REACHED    192.168.1.236:47421 — the LAN address
  ```

  So the loopback really is closed and a host-side proxy is still reachable — on the host's
  **non-loopback** address. `filtered` — the **default** mode — narrows that in a way worth stating
  exactly, read from the box's own `nft list ruleset`:

  ```
  type filter hook output priority filter; policy drop;
  ip daddr @allowed4 tcp dport { 80, 443 } accept      the allowlisted address IS in @allowed4
  ```

  so the allowlist entry lands and only ports **80 and 443** are accepted; a connection to any other
  port is *dropped*, which reads as a timeout rather than a refusal (my first probe used port 47622
  and concluded "refused" — the wrong word for the right outcome). Two consequences, both concrete:

  * A rootless host-side proxy cannot bind 443, so under the default mode a host-side proxy needs
    moat to name *its* port in the ruleset. That is the "it cannot express per-host ports" hole
    `AGENTS.md` already names, narrowed here to one deliberate entry rather than a general feature.
  * The listener is on the LAN, so it has to be bound to a deliberate address and authenticate its
    callers instead of trusting that only the box can reach it.

  And the box can reach the host as a LAN machine at all, which is a property of `isolated` worth
  saying out loud — it was never a LAN firewall, and SPEC §7.3 already says the filter is a policy
  rather than a jail.

  The alternative placement — a host process inside the box's **own** network namespace, listening
  on the box's loopback, which keeps the listener off the LAN — turns out to be available, and my
  first reading of it was **wrong**. `nsenter --target <pid> --net` answers `Operation not permitted`
  and I wrote "an ordinary process cannot" on the strength of it; that is nsenter's own bookkeeping
  (it wants to write `gid_map`) rather than the kernel refusing. Joining the box's **user** namespace
  first and its network namespace second works — it is the mechanism slirp4netns is built on — and a
  plain `setns` in that order lands in the box's netns (`net:[4026533202]`), where two processes
  reach each other on `127.0.0.1` (measured). What moat lacks is a way to *call* it: Node has no
  `setns`, so this shape needs a small helper binary to ship and pin. That is the cost, and it is not
  zero — which is why the shape is not simply free.

  One thing this placement has to respect: **every boot has its own network namespace.** The
  long-running box is a keepalive, and a task, a check and an `moat exec` are each their own boot
  with their own netns (the running box `net:[4026533202]` against an exec boot's
  `net:[4026533562]`, measured). A proxy pinned to the running box would serve none of the turns, so
  it attaches per boot — which is exactly the shape moat already uses for slirp4netns, pointed at
  each boot's pid.

  **A proxy inside the box** — in the agent's own filesystem and process namespace — would be
  agent-visible and agent-killable, which is the thing invariant 6's reason forbids.
* **The same question under the other backends.** This is all the `unshare` backend. Whether a
  container backend's default network or a microVM's datapath can carry a host-side proxy is
  `docs/MICROVM.md` §4–§5, where a passt-backed box has a real uplink and a closed host loopback.
* **The proxy's own threat model.** A terminating proxy sees every request and holds the credential
  it injects. That is a new class of component in moat — the first that terminates egress on the
  host — and `AGENTS.md` invariant 6 ("there is no server in the box and nothing is proxied") would
  need amending **in writing, by a named phase**, the way invariants 7 and 8 were. Nothing in §1
  requires that amendment yet, and this page does not make it.
* **What happens to a request the policy refuses.** "The agent cannot reach that host" is a policy;
  what the agent *does* about it — surface an error, retry, abandon the turn — is unmeasured.

## 5. Harness lessons, all of them bugs in this spike

Recorded because they are the failure modes a *measurement tool* has, and each one produced a
confident wrong answer before it was found. (No count in this heading on purpose: it grew twice
while writing it, which is the same reason no count is kept in a status table.)

* **A check that fails on success.** `grep -c` prints `0` *and exits 1* when nothing matches, so
  `$(grep -c . log || echo 0)` produced two lines, every comparison against `"0"` was true, and the
  first version reported `UNKNOWN — the control is not a control` for a control whose log was
  empty. Verbatim the trap `AGENTS.md` records for the checks runner; the fix is a `count()` that
  keeps grep's printed zero and only falls back for a missing file.
* **Reachability inferred from an HTTP status.** The placement listener answered 502, and busybox
  `wget` exits **8** for an error response — so a box that *did* reach the host's address was
  recorded as `refused`. The run contradicted a standalone probe using `python3 -m http.server`
  (which answers 200), and the contradiction is what exposed it. The recorder now takes its status
  code as an argument, and only the placement listener answers 200, so `wget` exiting 0 means the
  connection arrived. The cousin of this one: a **dropped** packet reads as a timeout, not a
  refusal, so `filtered`'s default-deny looked like "the address is unreachable" until the box's own
  `nft list ruleset` was read (§4).
* **A control has to be a precondition, not a footnote.** The Claude leg first ran the CLI without
  `ANTHROPIC_BASE_URL`, which moat's `run` path sets and `moat exec` does not — so Claude talked to
  its own default host and the run would have reported a confident result about nothing. The script
  now refuses to conclude anything unless the *no-proxy* leg reached the endpoint.
* **A credential value that is a common word cannot boot a box.** The vendor-host probe used
  `MOAT_MOCK_CREDENTIAL=probe` and every boot was refused with *"the credential was found on disk
  inside the sandbox"*. The guard is right and the message is clear — `moat` scans the rootfs for the
  credential's value, and the agent brief rendered for an **open**-egress box contains "Do not
  **probe** the host's …" (`bundle/instructions.ts`). It is a substring scan, so a short or shared
  value makes such a boot impossible; real keys are long and random, and a test fixture's value must
  be too. Worth knowing because the symptom is an `up exit=1` that looks like a moat bug.
* **The harness's own state made two runs incomparable.** `stub/mock-responses.mjs` serves its
  scripted turns *in sequence per process*, so one stub across two turns gives the second turn an
  exhausted script — the first comparison showed "1 request, 0 tools" for the second turn and read
  as an effect of the policy. The script now starts a fresh stub per turn. The same family: the
  fixture mutates as turns run (a scripted `git commit` has nothing to commit on the second pass),
  which is why the turn footer shows a failed tool and why the readings rely on requests and tokens
  rather than tool counts.

Every one was found by running the thing and disbelieving the result, which is the only way any of
them is found.

## 6. The shapes a proxy could take, with what each one costs

Not a recommendation and not a decision — the three placements the measurements above leave open,
each with the cost that was measured rather than assumed. Whoever picks one should be able to say
which reading justified it.

| shape | reachable from the box | what it costs |
| --- | --- | --- |
| **Host process, on the host's LAN address** | `isolated`: any port. `filtered` (default): 80/443 only, since the ruleset accepts `@allowed4 tcp dport { 80, 443 }` over `policy drop` | the listener is on the LAN, so it needs a deliberate bind address and caller authentication; and `filtered` needs one ruleset entry naming the proxy's port — the "cannot express per-host ports" hole, narrowed to one entry. A rootless process cannot bind 443 |
| **A host process in the box's own network namespace** (`setns` into the box's user namespace, then its network namespace — measured to work) | the box's own loopback, in every mode, with nothing on the LAN | moat cannot call `setns` from Node, so it needs a small helper binary to ship and pin. The attach-by-pid shape is the one moat already uses for slirp4netns; the artefact is new |
| **A proxy inside the box** | its own loopback | agent-visible and agent-killable — the agent is root in there — which is what invariant 6's reason forbids ("the host is a terminal and a log reader") |

What is settled by measurement and does not depend on the choice: both runtimes send their model
traffic through a proxy without per-runtime integration (§1); the hosts they call besides the model
can be refused or dropped for free, and doing so makes a turn ~8x faster (§2); moat cannot set the
proxy variables today, so any shape needs a `managedEnv` change (`sandbox/launcher.ts` accepts only
`MOAT_` names through `MOAT_SANDBOX_ENV`); that every boot has its own network namespace, so a proxy
attaches per boot rather than to the running box; and that whatever is built terminates egress on
the host, which invariant 6 would need amended for, in writing, by a named phase.
