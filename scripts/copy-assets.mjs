// `tsc` emits JavaScript only. `bundle/deepseek-models.json` is read from disk at runtime
// (`bundle/codex.ts`, through `new URL("./deepseek-models.json", import.meta.url)`) and is
// written into the sandbox byte for byte, so the build has to carry it into `dist/` too.
// Without this the compiled CLI dies at import time with ENOENT for
// `dist/bundle/deepseek-models.json`, which is a failure only CI sees: local runs strip
// types and read the file straight out of `bundle/`.
import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function assetsIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return assetsIn(path)
    return extname(entry.name) === ".ts" ? [] : [path]
  })
}

const copied = []
for (const asset of assetsIn(join(root, "bundle"))) {
  const destination = join(root, "dist", relative(root, asset))
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(asset, destination)
  copied.push(relative(root, asset))
}
console.log(`copied ${copied.length} asset(s) into dist/: ${copied.join(", ")}`)
