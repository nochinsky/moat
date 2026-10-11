import { PI_VERSION, RUNTIME_BINARY } from "../lib/pins.ts"
import { READY_MARKER } from "../sandbox/launcher.ts"
import { piExecBody, piTuiBody, parsePiEvents, createPiEventParser } from "./pi.ts"
import { describeTurn } from "./turn.ts"

/** Pi is the only harness. This is a CLI boundary, never an SDK running on the host. */
export const PI_RUNTIME = {
  label: "pi",
  binary: RUNTIME_BINARY,
  version: PI_VERSION,
  execBody: piExecBody,
  tuiBody: piTuiBody,
  parse: parsePiEvents,
  createParser: createPiEventParser,
  describe: describeTurn,
}

/** The persistent box owns the credential deadline; tasks/TUIs boot the same rootfs. */
export function keepaliveEntryScript(): string {
  return `#!/bin/sh
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
EXPIRES_EPOCH=\${MOAT_CREDENTIAL_EXPIRES_EPOCH:-0}
REMAIN=0
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  REMAIN=$((EXPIRES_EPOCH - $(date +%s)))
  if [ "$REMAIN" -le 0 ]; then
    echo "[moat] the injected credential expired before the box started; stopping"
    exit 0
  fi
fi
echo "${READY_MARKER} (pid $$)"
if [ "$EXPIRES_EPOCH" -gt 0 ]; then
  echo "[moat] the injected credential expires in \${REMAIN}s; the box stops then"
  sleep "$REMAIN"
  echo "[moat] injected credential expired; stopping the sandbox"
  exit 0
fi
exec sleep 2147483647
`
}
