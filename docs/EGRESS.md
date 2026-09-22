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

## 4. What this does not decide

* **Whether a proxy is reachable from a box whose egress is `filtered` or `isolated`.** The reading
  above uses `--egress open`, the one mode where the host's loopback is reachable from the box.
  Both other modes close it, deliberately — that is the property being bought — so a proxy in the
  host's namespace would be unreachable from them, and a proxy *in the box's namespace* is a
  different design. This is the first thing to measure next.
* **The v1 half.** A microVM's datapath is `libkrun`'s, with its own gateway, and `docs/MICROVM.md`
  §4–§5 has what is measured and what is not.
* **The proxy's own threat model.** A terminating proxy sees every request and holds the credential
  it injects. That is a new class of component in moat — the first that terminates egress on the
  host — and `AGENTS.md` invariant 6 ("there is no server in the box and nothing is proxied") would
  need amending **in writing, by a named phase**, the way invariants 7 and 8 were. Nothing in §1
  requires that amendment yet, and this page does not make it.
* **What happens to a request the policy refuses.** "The agent cannot reach that host" is a policy;
  what the agent *does* about it — surface an error, retry, abandon the turn — is unmeasured.

## 5. Two harness lessons, both of which were bugs in this spike

Recorded because they are the failure modes a measurement tool has, not the ones a probe has:

* **A check that fails on success.** `grep -c` prints `0` *and exits 1* when nothing matches, so
  `$(grep -c . log || echo 0)` produced two lines, every comparison against `"0"` was true, and the
  first version of the script reported `UNKNOWN — the control is not a control` for a control whose
  log was empty. That is verbatim the trap `AGENTS.md` records for the checks runner; the fix is a
  `count()` that keeps grep's printed zero and only falls back for a missing file.
* **A control has to be a precondition, not a footnote.** The Claude leg first ran the CLI without
  `ANTHROPIC_BASE_URL`, which moat's `run` path sets and `moat exec` does not — so Claude talked to
  its own default host and the run would have reported a confident result about nothing. The
  script now refuses to conclude anything unless the *no-proxy* leg reached the endpoint.

Both were found by running the thing, which is the only way either is found.
