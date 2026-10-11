/** The broker's own timestamp, not a fresh TTL counted from this ephemeral boot. */
export function credentialDeadline(env: Record<string, string | undefined> | undefined): number | null {
  const value = env?.MOAT_CREDENTIAL_EXPIRES_EPOCH
  if (value === undefined || value === "" || value === "0") return null
  const ms = Number(value) * 1000
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("invalid MOAT_CREDENTIAL_EXPIRES_EPOCH; refusing the boot")
  return ms
}

/** Host-owned: an agent cannot disable this timer by killing a watchdog in its namespace. */
export function watchCredentialExpiry(deadline: number | null, expired: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const check = () => {
    if (stopped || deadline === null) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) { stopped = true; expired(); return }
    // Re-check wall time, and avoid Node's overflow for credentials lasting over 24 days.
    timer = setTimeout(check, Math.min(remaining, 1000))
  }
  check()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
