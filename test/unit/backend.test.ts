import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { DEFAULT_BACKEND, containerPlan, resolveBackend } from "../../sandbox/backend.ts"
import { envPaths } from "../../lib/paths.ts"

/**
 * The backend seam.
 *
 * What these pin is the mapping, not the plumbing: which network a boot gets, that the container
 * command runs the *inner* script against the rootfs directory rather than an image, and that a
 * backend moat does not ship is refused by name instead of silently becoming the default.
 *
 * The measured basis is in `docs/PORTABILITY.md` §2 and `test/evidence/portability-podman.txt`: the
 * host's loopback is refused from a default rootless container, which is why `isolated` needs no
 * datapath of moat's own and why `needsSlirp` is false here.
 */

function fixture(): { paths: ReturnType<typeof envPaths>; inner: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moat-backend-"))
  const project = path.join(root, "project")
  fs.mkdirSync(project, { recursive: true })
  const paths = envPaths(project)
  fs.mkdirSync(path.join(paths.rootfs, ".moat"), { recursive: true })
  const inner = path.join(paths.rootfs, ".moat", "entry-1-abc.sh")
  fs.writeFileSync(inner, "#!/bin/sh\necho hi\n", { mode: 0o755 })
  return { paths, inner }
}

test("a backend moat does not ship is refused by name", () => {
  assert.equal(DEFAULT_BACKEND, "unshare", "the backend that needs nothing stays the default")
  assert.equal(resolveBackend("container"), "container")
  assert.equal(resolveBackend("unshare"), "unshare")
  // Falling back to unshare for `--backend docker` would be a guess about what the user meant.
  for (const wrong of ["docker", "podman", "lxc", ""]) {
    assert.throws(() => resolveBackend(wrong), /unknown backend/, `${wrong} must be refused`)
  }
})

test("the container plan runs the inner script against the rootfs directory", () => {
  const { paths, inner } = fixture()
  const plan = containerPlan(paths, inner, { egress: "isolated" })
  assert.ok(plan.args.includes("--rm"))
  // Ephemeral boots are NOT named: moat runs them alongside the long-running box, so a name derived
  // from the environment id collides with the keepalive (measured: podman exit 125 mid-task).
  assert.ok(!plan.args.includes("--name"), "an ephemeral boot must not claim a stable name")
  const named = containerPlan(paths, inner, { egress: "isolated", name: "moat-abc" })
  assert.equal(named.args[named.args.indexOf("--name") + 1], "moat-abc", "the long-running box is named")
  assert.ok(plan.args.includes("--rootfs"))
  // The rootfs is the directory itself — the measured property the whole backend rests on.
  assert.equal(plan.args[plan.args.indexOf("--rootfs") + 1], paths.rootfs)
  // The script is named by its path *inside* the box, not the host path it was written to.
  assert.equal(plan.args[plan.args.length - 1], "/.moat/entry-1-abc.sh")
  // `--rootfs` is a boolean whose *positional* is the rootfs path, so nothing may follow it except
  // the command. An option after it becomes part of the command — measured: crun was asked to exec
  // `--env`, and the box died during boot with "executable file `--env` not found in $PATH".
  const rootfsAt = plan.args.indexOf("--rootfs")
  assert.notEqual(rootfsAt, -1)
  for (const later of plan.args.slice(rootfsAt + 2)) {
    assert.ok(
      later === "/bin/sh" || later === "/.moat/entry-1-abc.sh",
      `${later} came after the rootfs path, where only the command belongs`,
    )
  }
  assert.ok(plan.args.includes("/bin/sh"))
  // A container runtime brings the datapath: moat must not start slirp beside it.
  assert.equal(plan.needsSlirp, false)
  assert.doesNotMatch(plan.args.join(" "), /slirp/)
  fs.rmSync(path.dirname(path.dirname(paths.rootfs)), { recursive: true, force: true })
})

test("open shares the host's network, and nothing else does", () => {
  const { paths, inner } = fixture()
  const open = containerPlan(paths, inner, { egress: "open" })
  assert.ok(open.args.includes("--network=host"), "open means the host's namespace, as it does today")
  for (const egress of ["isolated", "filtered"] as const) {
    const plan = containerPlan(paths, inner, { egress })
    assert.doesNotMatch(
      plan.args.join(" "),
      /--network/,
      `${egress} must use the runtime's default network, where the host's loopback is refused`,
    )
  }
  // `filtered` additionally applies moat's ruleset, and `nft` needs CAP_NET_ADMIN *in the box's own
  // netns*: a rootless container's root does not have it, and the boot died with "Operation not
  // permitted (you must be root)" / "netlink: Error: cache initialization failed". The capability is
  // granted for that one mode, and only that mode.
  assert.ok(containerPlan(paths, inner, { egress: "filtered" }).args.includes("--cap-add=net_admin"))
  assert.ok(!containerPlan(paths, inner, { egress: "isolated" }).args.includes("--cap-add=net_admin"))
  assert.ok(!containerPlan(paths, inner, { egress: "open" }).args.includes("--cap-add=net_admin"))
  fs.rmSync(path.dirname(path.dirname(paths.rootfs)), { recursive: true, force: true })
})

test("the box's environment travels as --env, never as the runtime's own", () => {
  const { paths, inner } = fixture()
  const plan = containerPlan(paths, inner, { env: { MOAT_PROVIDER_BASE_URL: "http://127.0.0.1:1", MOAT_MODEL_ID: "m" } })
  const joined = plan.args.join(" ")
  assert.match(joined, /--env MOAT_PROVIDER_BASE_URL=http:\/\/127\.0\.0\.1:1/)
  assert.match(joined, /--env MOAT_MODEL_ID=m/)
  // An undefined value is a variable that is not set, not one set to the string "undefined".
  const sparse = containerPlan(paths, inner, { env: { PRESENT: "1", ABSENT: undefined } })
  assert.doesNotMatch(sparse.args.join(" "), /ABSENT/)
  fs.rmSync(path.dirname(path.dirname(paths.rootfs)), { recursive: true, force: true })
})
