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
Refusing it is probably the right policy, and "probably" is the honest word until someone measures
whether the runtime degrades, retries, or gives up.

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

  The alternatives are worse or unavailable. **A host process cannot enter the box's network
  namespace**: `nsenter --target <pid> --net` answers `Operation not permitted`, and slirp4netns is
  not doing that either — measured, it runs in the *host's* namespace (`net:[4026531833]`) and
  creates the tap from outside. **A proxy inside the box** would be agent-visible and
  agent-killable, which is the thing invariant 6's reason forbids.
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

## 5. Three harness lessons, all of them bugs in this spike

Recorded because they are the failure modes a *measurement tool* has, and each one produced a
confident wrong answer before it was found:

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
  connection arrived.
* **A control has to be a precondition, not a footnote.** The Claude leg first ran the CLI without
  `ANTHROPIC_BASE_URL`, which moat's `run` path sets and `moat exec` does not — so Claude talked to
  its own default host and the run would have reported a confident result about nothing. The script
  now refuses to conclude anything unless the *no-proxy* leg reached the endpoint.

All three were found by running the thing and disbelieving the result, which is the only way any of
them is found.
