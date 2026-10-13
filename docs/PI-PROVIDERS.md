# Pi-native providers and authentication — approved direction

**Status: design, not implemented.** The published package remains 0.1.0 and current code still
uses DeepSeek by default. This document records the owner's next request, not a claim that every
provider/account already works.

## Owner decisions

After the focused copy-in/doctor/container/MCP batch, the owner requested Pi's native provider
breadth, including supported subscriptions, instead of DeepSeek-first behavior. They explicitly
chose **provider selection on first use**, with the choice remembered, not DeepSeek as the default.
Authentication details were delegated to the implementer.

The recommended implementation is environment-only API-key injection plus **explicit sandbox-local
Pi login** for subscriptions/OAuth. No host Pi authentication/configuration is imported automatically;
opt-in host-token reuse is not part of this work. Native provider choice remains explicit and is
never inferred from credentials found in the environment.

## Boundary to preserve and amend deliberately

- Pi, provider implementations, login/refresh, extensions, MCP and all tools stay in the box.
  No host-side agent SDK, host-executed credential commands or ambient cloud/SSH credentials.
- API-key mode retains environment references, never literal keys in moat-written model/settings
  files or argv. Credentials must come from the selected provider or an explicit override, not a
  fallback to another provider's key.
- OAuth login is a deliberate exception to environment-only storage: Pi writes its own sandbox
  `auth.json`. Explain before login that access/refresh tokens can persist in rootfs snapshots and
  can be read by the agent/extensions. Logout removes local credentials, not provider authorization.
- Do not silently use stored subscription credentials in API-key mode, or a host API key in
  subscription mode. The selected account/method must be visible and remembered.
- API-key and OAuth authentication need separate lifecycle/reporting paths. Local task/credential
  deadlines stop processes; they do not revoke a refresh token or cancel already-accepted requests.
- Default egress is not changed to open. Provider API, login and refresh destinations must be
  explicitly represented; extra extension/server endpoints remain approved configuration.
- No repair, configuration change or failed login re-provisions over `/work`. Session and branch
  preservation, guarded rootfs operations and explicit review/apply remain load-bearing.

## Implementation shape

1. Describe the pinned Pi catalog, transports and auth methods once, using reviewed data derived
   from the pinned runtime. Any helper that executes Pi's model/provider code runs **inside a
   sandbox**, not on the host. Ship the needed data with the compiled package and test its provenance
   against the Pi pin; do not invent endpoints or guess from a provider's name.
2. Resolve explicit CLI choice, existing environment configuration, then an explicitly saved user
   default. On first interactive use ask; in headless use refuse a missing selection before
   provisioning and name the flags/setup command. Preserve existing configured/legacy environments.
3. Let Pi's native provider registry handle supported transports and auth; do not recast Anthropic,
   Google, Azure, Bedrock or subscription requests as OpenAI Responses. Keep configured compatible
   endpoints and in-box provider extensions as escape hatches.
4. Render consistent model facts and provider-qualified identities. Unknown limits/prices are
   unknown, never another provider's defaults. Subscription quotas are not API-dollar billing;
   `--max-cost` must not imply a reliable monetary ceiling for them.
5. Add explicit sandbox login/logout/status with no token values in host output, captured evidence
   or diagnostic argv. Handle browser/device-code flows through Pi, including manual code/redirect
   paste for a remote callback. Cancellation and failed refresh must fail clearly without data loss.
6. Update the contract/invariants, brief, doctor, help, onboarding, examples and migration guidance
   together. Do not claim broad native-provider support merely because a enum accepts more strings.

## Required validation

- Pure resolver/security tests: no implicit provider/key selection; no cross-provider credential
  fallback; no DeepSeek model/effort/pricing default for another provider; explicit auth-mode
  precedence; legacy state retained; unconfigured/headless first-use refusal before boot.
- Real pinned Pi turns against local protocol stubs (at least OpenAI, Anthropic and Google), asserting
  on receiving-end headers/payloads, model/tool execution, usage/error/abort behavior and host-tree
  preservation. This establishes transport plumbing, not paid-provider quality.
- A sandbox-local test OAuth provider: login, persisted/resumed auth, refresh, cancellation/error,
  logout and reported task deadlines. Include a receiving-end check and a host-auth canary that must
  never be imported. Test snapshot/restore exposure explicitly rather than implying secrets vanish.
- Re-run namespace acceptance, customization/MCP, container stop/cleanup, TUI, actual legacy upgrade,
  installed-package graph/assets and full hosted CI. Regenerate evidence/trust from executed gates.
- No paid-provider or actual subscription-account flow without fresh bounded authorization. Local
  fixtures can establish mechanics; real provider/account compatibility remains a named gap until
  measured. No release/version/tag is implied by starting this implementation.

Cloud providers requiring multiple values/files need explicit sandbox configuration; forwarding
ambient host SDK chains would break the boundary. Image/classifier models and arbitrary provider
extensions are Pi capabilities but are not promises that moat can universally account for their
spend. Resource quotas, aggregate budgets, default-egress changes and a production microVM backend
remain out of scope.
