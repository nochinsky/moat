import fs from "node:fs"

import * as log from "./log.ts"
import { run } from "./shell.ts"

/**
 * Host capability probe. moat refuses to run on a host that cannot support the
 * sandbox, rather than silently degrading to running the agent on the host
 * (there is no such mode by design).
 */
export type Doctor = {
  linux: boolean
  wsl: boolean
  virt: string
  userns: boolean
  mountns: boolean
  pidns: boolean
  kvm: boolean
  unshare: string | null
  chroot: string | null
  mount: string | null
  chown: boolean
  problems: string[]
  notes: string[]
}

async function which(bin: string): Promise<string | null> {
  const r = await run("sh", ["-c", `command -v '${bin}'`], { allowFailure: true })
  return r.code === 0 ? r.stdout.trim() || null : null
}

export async function probeHost(): Promise<Doctor> {
  const problems: string[] = []
  const notes: string[] = []

  const linux = process.platform === "linux"
  if (!linux) problems.push(`unsupported platform ${process.platform}: moat is Linux-only (WSL2 via the container path)`)

  let virt = "none"
  try {
    virt = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").includes("microsoft")
      ? "wsl"
      : fs.readFileSync("/sys/class/dmi/id/product_name", "utf8").trim() || "unknown"
  } catch {
    /* best effort */
  }
  const wsl = virt === "wsl"

  // Real capability probe: attempt a user+mount+pid namespace and a tmpfs mount.
  const unshare = await which("unshare")
  const chroot = await which("chroot")
  const mount = await which("mount")
  if (!unshare) problems.push("missing `unshare` (util-linux): cannot create namespaces")
  if (!chroot) problems.push("missing `chroot`: cannot enter the rootfs")
  if (!mount) problems.push("missing `mount`: cannot build the sandbox mount table")

  let userns = false
  let mountns = false
  let pidns = false
  if (unshare) {
    const r = await run(
      unshare,
      ["--user", "--map-root-user", "--mount", "--pid", "--fork", "sh", "-c", "mkdir -p /tmp/.moat-probe && mount -t tmpfs none /tmp/.moat-probe && echo USERNS_OK && echo PIDNS_OK"],
      { allowFailure: true },
    )
    const combined = r.stdout + r.stderr
    userns = combined.includes("USERNS_OK")
    mountns = userns
    pidns = combined.includes("PIDNS_OK")
    if (!userns) {
      problems.push(
        "unprivileged user namespaces are unavailable: `unshare --user --map-root-user` could not mount a tmpfs. " +
          "moat has no host fallback, so it cannot run here.",
      )
      if (wsl) notes.push("WSL2: enable user namespaces in /etc/wsl.conf and restart the distro.")
    }
    if (userns && !pidns) problems.push("PID namespaces unavailable")
  }

  const kvmDevice = fs.existsSync("/dev/kvm")
  let kvm = false
  let kvmDetail = "absent"
  if (kvmDevice) {
    try {
      fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK)
      kvm = true
      kvmDetail = "present and accessible"
    } catch {
      const stat = fs.statSync("/dev/kvm")
      kvmDetail = `present but not accessible to uid ${process.getuid?.() ?? "?"} (mode ${(stat.mode & 0o777).toString(8)}, gid ${stat.gid})`
    }
  }
  notes.push(
    kvm
      ? "/dev/kvm usable: the v1 microVM path is available on this host"
      : `no usable /dev/kvm (${kvmDetail}): v1 microVM unavailable here; the v0 container path is the supported mode`,
  )

  // Device-node creation is impossible in an unprivileged user namespace; we
  // detect it so the mount plan can be reported accurately.
  let chown = false
  if (userns && unshare) {
    const r = await run(unshare, ["--user", "--map-root-user", "sh", "-c", `mknod /tmp/.moat-node c 1 3 2>/dev/null && echo MKNOD_OK || echo MKNOD_FAIL`], {
      allowFailure: true,
    })
    chown = (r.stdout + r.stderr).includes("MKNOD_OK")
  }
  notes.push(
    chown
      ? "mknod permitted in userns: /dev is built entirely inside the sandbox"
      : "mknod denied in userns (kernel policy): /dev nodes are bind-mounted read-only from the host's device nodes. No host *data* is mounted.",
  )

  return { linux, wsl, virt, userns, mountns, pidns, kvm, unshare, chroot, mount, chown, problems, notes }
}

export async function assertHostUsable(): Promise<Doctor> {
  const doctor = await probeHost()
  if (doctor.problems.length > 0) {
    for (const p of doctor.problems) log.warn(p)
    log.fail("host cannot support the moat sandbox")
  }
  return doctor
}

export function describeHost(d: Doctor): string {
  const parts: string[] = [process.platform, process.arch]
  if (d.wsl) parts.push("wsl2")
  parts.push(`userns=${d.userns ? "yes" : "no"}`, `kvm=${d.kvm ? "yes" : "no"}`)
  return parts.join(" ")
}
