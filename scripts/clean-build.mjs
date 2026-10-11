// A rebuilt tarball must not retain JavaScript from deleted runtime adapters.
import fs from "node:fs"
fs.rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true })
