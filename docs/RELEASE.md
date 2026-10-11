# Releasing moat-sandbox

**The 0.1.0 release line is Pi-only.** A version bump or a local passing suite is not publication:
a matching `v*` tag triggers `.github/workflows/release.yml`, and the registry must confirm success.
Older 0.0.x packages keep their retired harnesses.

## Local gates

Run sequentially on a Linux x86-64 host with unprivileged user namespaces:

```bash
npm ci --no-audit --no-fund
npm run typecheck
bash test/ci-entrypoint.test.sh
bash test/e2e-pi.sh
python3 test/pi-tui.py
bash test/pi-legacy.sh
bash test/pi-package.sh
bash test/e2e-provider.sh
bash test/e2e-demo.sh
bash test/e2e-review.sh
bash test/e2e-egress.sh
bash test/e2e-extras.sh
# From a shell that already has a spend-capped DEEPSEEK_API_KEY:
bash test/pi-live.sh
node scripts/trust.mjs
npm run test:unit
node scripts/trust.mjs --check
git diff --check
```

`pi-live.sh` makes one small real-provider task with 180-second, 30000-token and $0.10
**reported-usage** ceilings. It independently verifies the fix, the commit and an unchanged host
fixture after review. No key value or raw provider conversation is committed as evidence. It
refuses an unset key before spending anything. Use provider-side limits too: usage may arrive only
after a request, and extensions may make unreported calls. Do not paste keys into chat or argv.

The default namespace backend must pass. If a usable rootless podman is available, also validate a
real Pi container turn. Otherwise keep that gap explicit in the README, changelog and verification
table; a skip is not a pass. Historical paid-model captures do not validate the current Pi adapter.
A failed current live check must be fixed or explicitly deferred, not relabeled as successful.

The installed-package gate verifies compiled CLI/lock assets, absence of stale retired adapters,
and a real in-box demo. The dependency lock and `PI_LOCK_SHA256` must change together. Never
re-provision over `/work` to make an upgrade test pass.

## Version, review and push

Choose an unpublished version; published versions cannot be reused. The owner selected **0.1.0**
for this migration. `npm version` updates both `package.json` and the root lockfile:

```bash
npm version 0.1.0 --no-git-tag-version --ignore-scripts
git diff --stat
git diff                         # review source, docs and generated evidence
git status --short               # include intended new files, not just tracked edits
git add <reviewed paths>
git diff --cached --check
git commit -m "0.1.0: run Pi exclusively inside the sandbox"
git tag v0.1.0
git push --atomic origin main v0.1.0
```

Do not force-push or move a published release tag. Check that the remote branch has not advanced
before pushing. Only push the tag once the owner has authorized publication and gates are complete.

## Publication and confirmation

The tag workflow runs typecheck/unit/CI-entrypoint/trust checks, builds and checks the packed assets,
and publishes **the checked tarball** with provenance. GitHub-hosted runners cannot rerun the
sandbox gates; local evidence is still required. Trusted publishing uses GitHub OIDC, not a stored
npm token. The configured npm trusted publisher is `nochinsky/moat`, workflow `release.yml`.

```bash
gh run list --workflow release.yml --limit 3
gh run watch <release-run-id> --exit-status
npm view moat-sandbox@0.1.0 version dist.integrity dist.attestations --json
npm view moat-sandbox dist-tags --json
```

Confirm both the workflow conclusion and npm's version/dist-tag. A successful push is not a
successful publish. If publication fails, diagnose the workflow first; do not request an npm token
or silently fall back to local publication. An already-published version needs a new version/tag,
not a retry under the same version.
