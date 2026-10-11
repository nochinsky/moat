// `tsc` emits JavaScript only, so any non-TypeScript file a module reads at runtime has to
// be carried into `dist/` by hand.
//
// Pi's package manifest and complete pinned dependency lock are runtime assets. Ship them
// beside the compiled installer; never ship node_modules or a host Pi configuration.
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
    ? "no runtime assets under bundle/ to copy"
    : `copied ${copied.length} asset(s) into dist/: ${copied.join(", ")}`,
)
