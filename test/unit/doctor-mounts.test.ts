import assert from "node:assert/strict"
import { test } from "node:test"

import { MOUNT_FIELDS_AWK, analyseMounts } from "../../sandbox/isolation.ts"

const DEVICES = ["null", "zero", "full", "random", "urandom", "tty"].map(
  (node) => "/dev/" + node + "||/" + node + "||rw,nosuid,relatime||devtmpfs none rw,size=3945424k",
)

test("the mount check renders the root field, without which a host bind is invisible", () => {
  // Field 4 of mountinfo is the root: for a bind mount it names the host path
  // the mount came from. The old awk printed the mount point and the source
  // (a device name), so a host bind rendered as /work||ext4 /dev/sdd and the
  // check could never fail.
  assert.ok(MOUNT_FIELDS_AWK.includes("a[4]"), "the rendering must include the root field")
})

test("a host bind is flagged, moat's own rootfs and the six devices are not", () => {
  const stateRoot = "/home/me/.moat"
  const hostBind = "/work||/home/victim/secrets||rw,relatime||ext4 /dev/sdd rw,discard"
  const ownRootfs = "/||/home/me/.moat/envs/abc/rootfs||rw,relatime||ext4 /dev/sdd rw"
  const proc = "/proc||/||rw,relatime||proc proc rw"

  const analysis = analyseMounts([hostBind, ownRootfs, proc, ...DEVICES], stateRoot)
  assert.deepEqual(analysis.suspicious, [hostBind])
  assert.equal(analysis.deviceBinds.length, 6)

  // What the check used to see for the same bind, once the root field was
  // dropped. It carries no host path, which is the bug this test pins down.
  const oldShape = "/work||ext4 /dev/sdd rw"
  assert.deepEqual(analyseMounts([oldShape], stateRoot).suspicious, [])

  // A missing device must not pass silently either: the caller checks 6/6.
  assert.equal(analyseMounts([...DEVICES.slice(0, 5)], stateRoot).deviceBinds.length, 5)
})

test("a bind of the host root is flagged, while a pseudo-filesystem mounted at one is not", () => {
  // The hole this closes: proc, tmpfs and devpts legitimately have "/" as their root field, so
  // the check exempted root === "/" outright -- which also exempted `mount --bind / $N/mnt`, the
  // one mount that would hand the box every host file. The exemption is by filesystem now.
  const stateRoot = "/home/me/.moat"
  const hostRoot = "/mnt||/||rw,relatime||ext4 /dev/sdd rw,discard"
  const proc = "/proc||/||rw,relatime||proc proc rw"
  const devTmpfs = "/dev||/||rw,nosuid||tmpfs tmpfs rw,mode=755"
  const devpts = "/dev/pts||/||rw,relatime||devpts devpts rw,mode=620"
  const devShm = "/dev/shm||/||rw,nosuid,nodev||tmpfs tmpfs rw,mode=1777"
  const analysis = analyseMounts([hostRoot, proc, devTmpfs, devpts, devShm, ...DEVICES], stateRoot)
  assert.deepEqual(analysis.suspicious, [hostRoot])
  assert.equal(analysis.deviceBinds.length, 6)
})
