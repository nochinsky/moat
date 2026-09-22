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

### The end-to-end reading: a real proxy carries real TLS

"Uses a proxy" and "a proxy can carry the traffic" are different claims, and the second is the one
that decides whether any of this works. Taken against the **real provider** with a deliberately
invalid key, so that a 401 from it is proof the request arrived:

```
$ moat exec -- sh -c 'MOAT_INJECTED_CREDENTIAL=fake timeout 40 codex exec --json "say hi"'      # control
unexpected status 401 Unauthorized: Authentication Fails, Your api key: fake is invalid, url: https://api.deepseek.com/...
proxy saw: 0 request(s)

$ ... HTTPS_PROXY=http://127.0.0.1:47971 codex exec --json "say hi"                              # through the proxy
unexpected status 401 Unauthorized: ... url: https://api.deepseek.com/...        (the same 401)
the proxy was asked to reach:  CONNECT api.deepseek.com:443, chatgpt.com:443, github.com:443
```

A ~30-line CONNECT proxy is enough: the model request went to the proxy, the tunnel carried the TLS,
the provider answered, and the proxy never saw the payload — it sees `host:port`, which is exactly the
granularity a name-and-port policy needs. Nothing here needs TLS interception, a certificate, or a
custom CA in the box.

This one is **not** in `test/proxy-spike.sh`, on purpose: that script is hermetic (a loopback endpoint
and recorders answering 502), and this reading has to reach a third party's API. Its command is the
four lines above.

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
  reach each other on `127.0.0.1` (measured).

  **What that placement costs is not a helper binary, and I said it was for one round.** Node has no
  `setns`, which is true and was beside the point: `nsenter` does it, and the reason my earlier
  attempt failed is a flag — `--user --net` dies on `setgroups`, and **`--preserve-credentials`** is
  the flag that skips that bookkeeping:

  ```
  nsenter --target <pid> --net                      -> reassociate to namespaces failed
  nsenter --target <pid> --user --net --preserve-credentials  -> net:[4026533192]  (the box)
  ```

  A listener started that way is reached by a peer in the same namespace (`HTTP/1.0 200 OK`), and the
  host's own loopback listener answers 200 as the control. So the mechanism is a **subprocess of
  util-linux** — the same package `unshare` and `chroot` already come from, and which moat's default
  path already assumes. Nothing new has to be shipped or pinned. The container backend answers the
  same way (`net:[4026533187]`, peer `HTTP/1.0 200 OK`), so this is one mechanism for both.

  One thing this placement has to respect: **every boot has its own network namespace.** The
  long-running box is a keepalive, and a task, a check and an `moat exec` are each their own boot
  with their own netns (the running box `net:[4026533202]` against an exec boot's
  `net:[4026533562]`, measured). A proxy pinned to the running box would serve none of the turns, so
  it attaches per boot — which is exactly the shape moat already uses for slirp4netns, pointed at
  each boot's pid.

  Under the **container** backend the same questions answer differently, and that is what narrows the
  choice. Measured with `--backend container --egress isolated`, `outbound=OK` as the control that the
  box has a network at all:

  ```
  host's loopback       : refused
  host's non-loopback   : refused        (under the unshare backend this was REACHED)
  setns (user, then net): IN net:[4026533557]
  ```

  So a host-side listener is **unshare-only** — a container box refuses the host's address on both
  routes — while a process inside the boot's own namespace works for **both** backends. That is a
  measurement rather than a preference, and it leaves one of the three shapes standing for a moat
  with more than one backend.

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
* **A false accusation, which is the worst thing a measurement can produce.** The agent-reach row
  placed its process with `$(nsenter … & echo $!)`, which captures a *wrapper* pid that is gone a
  moment later — so "did it survive the box's kill?" was `kill -0` on a process that never existed,
  and the row reported `BLOCKED: the agent CAN kill a process placed on its loopback` while its own
  rows in the same output said `signal=refused`. A standalone probe using `pgrep` on a uniquely-ported
  listener disagreed, and the disagreement is what caught it. Identify the thing you are measuring,
  and check that the survivor is the one you placed.
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
| **Host process, on the host's LAN address** | `isolated` (unshare): any port. `filtered` (default): 80/443 only, since the ruleset accepts `@allowed4 tcp dport { 80, 443 }` over `policy drop`. **Container backend: not reachable at all** | the listener is on the LAN, so it needs a deliberate bind address and caller authentication; `filtered` needs one ruleset entry naming the proxy's port — the "cannot express per-host ports" hole, narrowed to one entry; a rootless process cannot bind 443; and it is **unshare-only**, so it cannot be the design for a moat with two backends |
| **A host process in the boot's own network namespace**, placed by `nsenter --user --net --preserve-credentials` | the box's own loopback, in every mode, with nothing on the LAN | nothing new to ship: a subprocess of util-linux, the package `unshare`/`chroot` already come from. It attaches per boot, the shape moat already uses for slirp4netns. And the agent cannot reach it: not in its `/proc`, and its signals are refused (measured) |
| **A proxy inside the box** | its own loopback | agent-visible and agent-killable — the agent is root in there — which is what invariant 6's reason forbids ("the host is a terminal and a log reader") |

What is settled by measurement and does not depend on the choice: both runtimes send their model
traffic through a proxy without per-runtime integration (§1); the hosts they call besides the model
can be refused or dropped for free, and doing so makes a turn ~8x faster (§2); moat cannot set the
proxy variables today, so any shape needs a `managedEnv` change (`sandbox/launcher.ts` accepts only
`MOAT_` names through `MOAT_SANDBOX_ENV`); that every boot has its own network namespace, so a proxy
attaches per boot rather than to the running box; that the in-namespace placement is the only one of
the three both backends allow, with no new artefact needed; and that whatever is built terminates
egress on the host, which invariant 6 would need amended for, in writing, by a named phase.

The question this placement raises is whether the agent can reach the process — "the agent can kill
the proxy" is precisely shape 3's failure mode — and it is measured, with the box's root doing the
asking:

```
the box sees 4 pids              its own namespace, and /proc/<the placed pid> does not exist
the box signals its own child    yes  (control: `kill` works in there)
kill -0 <placed pid>             not permitted
kill -TERM <placed pid>          refused — and the placed process survived
```

So the placement does **not** inherit shape 3's failure mode. The reason is the **pid namespace**, and
my first explanation of it was wrong: `nsenter --user --preserve-credentials` does not leave the
process unmapped, it lands it on **uid 0** — measured, `id -u` through this exact invocation prints 0,
and so does the box's own root. What stops the agent is that the pid does not exist in the box's pid
namespace, so `kill` answers **ESRCH** (no such process) rather than refusing for permission — my
earlier probe's `kill -0 … || echo "not permitted (or no such pid)"` conflated the two.

That is not a footnote: two principals with the same uid mean **no ruleset can separate the proxy's
traffic from the box's** (§7).

## 7. What is built, and what this first increment does not cover

`--egress-proxy` on `up`/`run` makes moat start the proxy (`sandbox/proxy.ts`) and place it on the
boot's own loopback, by the same seam slirp4netns is started by — and the box is told to use it, in
its managed environment, because `MOAT_SANDBOX_ENV` accepts only `MOAT_` names. Measured end to end
against the real provider, on a `filtered` box with a deliberately invalid key:

```
2026-09-22T21:30:08Z listening on 127.0.0.1:41417 allowing api.deepseek.com:443 registry.npmjs.org:80 …
2026-09-22T21:30:08Z REFUSED chatgpt.com:443
2026-09-22T21:30:09Z ALLOWED CONNECT api.deepseek.com:443
```

and the turn came back with the provider's own `401 Unauthorized … url: https://api.deepseek.com/…`.
A host outside the policy is refused **by name**, which is the thing a dropped packet could never say.

What that increment deliberately does **not** cover, so nobody reads the above as more than it is:

* **The ruleset used to govern the proxy's own dial — fixed, and the fix is §7a.** The proxy sat in
  the box's network namespace, so its outbound traffic passed the box's ruleset, whose accept
  addresses were resolved at boot. The same provider on a port the ruleset never opens:

  ```
  before: egress isolated (no ruleset):  ALLOWED POST 192.168.1.236:8443
          egress filtered (the default): FAILED 192.168.1.236:8443 no response within 10s
  after:  egress filtered, proxied:      ALLOWED POST 192.168.1.236:8443, 7 requests reached the endpoint
          egress filtered, direct:       hung for its whole timeout, 0 requests — the backstop, intact
  ```

  I said the next step would be to split the ruleset — admit the proxy's traffic by uid, confine the
  box to its loopback. **That could not work**: the proxy is uid **0** inside the box, the same
  principal as the box's root (§4), so there is nothing for a ruleset to match on. The split is
  structural instead, and it is built — §7a.

### 7a. The structural split: built, with one deliberate exception

The proxy gets a network namespace of its own (`sandbox/proxy-netns.ts`), with slirp attached to *that*
namespace rather than the box's, and no ruleset at all — the proxy is the policy. The box reaches it
across a veth pair, and **the box keeps its own datapath and ruleset as the backstop** for traffic
that ignores the proxy. What had to be true first is that a rootless moat can build the topology, and
it can, measured on a live box:

```
# the second namespace, created from inside the box's USER namespace so that one userns owns both
nsenter -t <boxPid> --user --net --preserve-credentials -- sh -c 'exec unshare --net -- sleep 300'
  holder netns net:[4026533547]   userns user:[4026533187]
  box    netns net:[4026533192]   userns user:[4026533187]      # same userns: the move is permitted

# the pair, created through the box's namespaces (the host's ip, uid 0 there) and split
nsenter -t <boxPid> … -- ip link add vethp type veth peer name vethb     # exit 0
nsenter -t <boxPid> … -- ip link set vethb netns <holderPid>             # exit 0
nsenter -t <boxPid> … -- sh -c 'ip addr add 10.0.9.1/30 dev vethp; ip link set vethp up'
nsenter -t <holderPid> … -- sh -c 'ip addr add 10.0.9.2/30 dev vethb; ip link set vethb up'

# and it carries traffic, with a control
from inside the box's namespace -> 10.0.9.2:49003 : REACHED (HTTP/1.0 200 OK)
from inside the box's namespace -> 10.0.9.2:49004 : ConnectionRefusedError   (nothing behind it)
```

What that costs and what it does not settle:

* **`ip` (iproute2) becomes a host requirement.** It is invoked through the box's namespaces rather
  than installed in the image, so the image is unchanged — but the host's default path stops being
  "util-linux and nothing else", and `moat doctor` should report it the way it reports `unshare` and
  `chroot`. That is a deliberate, reportable change rather than a hidden one.
* **Built, verified, and one thing learned the hard way.** `sandbox/proxy-netns.ts` builds the
  namespace, the link and the addressing, and the launcher attaches slirp to the *holder* and places
  the proxy there with the box's resolver (`slirp-proxy.log` beside `slirp.log`). Verified on a
  `filtered` box: the proxy dialed a port the ruleset never opens (`ALLOWED POST …:8443`, seven
  requests to the endpoint), the same port *without* the proxy still hung with zero requests, and the
  real provider still answered `401` through the tunnel.
  The thing learned: **the box's own ruleset then drops the box's SYN to the proxy** — the link's
  address is in no allowlist and the port is not 80/443 — and the failure is *silent*. Measured before
  the exception was added: the turn hung for its whole 45-second timeout with **no** error and nothing
  in the proxy's log, because a dropped packet reads as a slow network rather than a refusal. The
  ruleset therefore carries one deliberate accept rule naming the proxy's address and port, and
  `test/unit/egress.test.ts` pins it — including that it admits nothing else beyond the allowlist.
* **The state-driven boots are not proxied, and that is deliberate for now.** `moat exec`, `verify`,
  `take` and the doctor's probe read egress from `state.json`; the proxy's policy is per-invocation, so
  those boots are built without it. Wiring it — recording the policy and building the topology for
  every boot of the environment, which is how `egress`, `egressAllow`, `backend` and `runtime` already
  work — was written and **reverted**, because it hung: with the same code and the same environment,
  `moat exec -- sh -c 'echo hi'` completed on one run and sat for its whole 60-second timeout on
  another. The one failure the runs did produce was explainable and fixed (the topology is built after
  the boot starts, so a fast boot was gone before the link existed — `cannot open /proc/<pid>/ns/user`
  — and the boot now waits for its link the way it already waits for slirp's tap). The hang is not, and
  a hang in `exec` is worse than an unproxied check, so the state does not record a policy it is not
  honouring. **This is the next thing to settle**, with the reproduction above.
* **Still open.** The box's own datapath is a *backstop*, not a second policy: the box can still reach
  the allowlist directly on 80/443 and resolve through slirp, so the proxy governs clients that honour
  it and the ruleset governs the rest. Making the proxy the *only* path means removing the box's
  slirp, which changes the boot's readiness wait, the doctor's network probes and the egress suite —
  a step of its own. Also open: `ip` is now a real host requirement (checked before provisioning, and
  it should appear in `moat doctor` beside `unshare` and `chroot`); the topology's lifecycle is reaped
  through `stopDatapath` but has not been tested against a box that dies out of band; `exec`, `verify`
  and `take` still read egress from state and are not proxied; and the container backend is refused.
* One trap worth repeating, because I hit it twice taking these readings: **every boot has its own
  network namespace** (§4). Building the topology in the keepalive's namespace and then dialing from
  `moat exec` measures two different namespaces, and the honest answer there is "refused" for a
  topology that works.
* **`moat exec`, `moat verify` and `moat take` are not proxied.** The policy arrives as a flag on
  `up`/`run`; those commands read egress from `state.json`, so the policy has to become an
  environment property (recorded, like `egress` and `egressAllow`) before they can carry it. Until
  then a check that makes a network call does so under the ruleset alone.
* **The container backend is refused, not ignored** — `--egress-proxy` says so, and attaching to a
  container's namespace needs the runtime's pid (§4 measured that the mechanism works).
* **A proxy is not a jail.** It governs clients that honour a proxy setting; a raw socket under
  `isolated`/`filtered` still reaches what the ruleset admits. SPEC §7.3 already says the filter is a
  policy rather than a jail, and this narrows where traffic *goes* without pretending otherwise.

## 8. Two pre-existing defects this increment ran into

Both were hit while taking §7's reading, and neither was introduced by it:

* **A second turn on an environment is refused by the credential guard.** Codex writes a shell
  snapshot into `/root/.codex/shell_snapshots/` containing the environment it was given, which
  includes `MOAT_INJECTED_CREDENTIAL`; `scanRootfsForCredential` runs at the next boot, finds the
  value on disk, and refuses with *"the credential was found on disk inside the sandbox"*. Measured
  with no proxy involved at all — turn 1 fine, turns 2 and 3 refused:

  ```
  plain    turn 1: exit=1  unexpected status 401
  plain    turn 2: exit=1  the credential was found on disk
  plain    turn 3: exit=1  the credential was found on disk
  ```

  The guard is right about the principle and wrong about this file: it is the agent's own runtime
  writing its own environment, not the image carrying a credential. It also makes an environment
  unusable after one turn, and the message reads as a moat refusal with no way out.
* **The proxy read the host's resolver.** A host process in the box's network namespace reads the
  *host's* `/etc/resolv.conf`, whose nameserver a `filtered` ruleset drops (it admits DNS only to
  slirp's `10.0.2.3`). Every dial failed `EAI_AGAIN`. Fixed here by passing slirp's resolver
  explicitly — but it is the same lesson §5 keeps recording: the placement changes what the process
  can see, and reading the environment it inherited is not reading the one it is in.
