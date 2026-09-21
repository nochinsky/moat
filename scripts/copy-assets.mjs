// `tsc` emits JavaScript only, so any non-TypeScript file a module reads at runtime has to
// be carried into `dist/` by hand.
//
// This used to exist for exactly one asset: `bundle/deepseek-models.json`, the 38KB vendored
// model catalog that `bundle/codex.ts` read through `new URL(...)` at import time. Missing it
// from `dist/` killed the compiled CLI with ENOENT, which only CI saw, because local runs strip
// types and read the file straight out of `bundle/`.
//
// That file is gone. The model metadata is rendered per boot (`bundle/model-catalog.ts`) and the
// prompt it has to carry is a source constant (`bundle/codex-prompt.ts`), so there are no
// runtime assets left under `bundle/`. The script stays because the failure it prevents is a
// silent, CI-only one and the next runtime asset will need it; it prints nothing to copy, which
// is the honest state rather than a reason to delete the guard.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, extname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function assetsIn(dir) {
  if (!existsSync(dir)) return []
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
console.log(
  copied.length === 0
    ? "no runtime assets under bundle/ to copy (the model catalog is rendered, not vendored)"
    : `copied ${copied.length} asset(s) into dist/: ${copied.join(", ")}`,
)
