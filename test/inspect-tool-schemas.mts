#!/usr/bin/env node
/**
 * Print the model-facing JSON schema of every tool the sandbox's opencode server
 * advertises, for the provider/model the bundle is configured with.
 *
 * This exists because opencode's *internal* tool schemas and its *model-facing*
 * schemas disagree in a way that silently breaks integrations: `read`, `write`
 * and `edit` declare `path` internally (packages/core/src/tool/{read,write,edit}.ts)
 * but are presented to the model as `filePath`. moat's mutation guard checks the
 * model-facing names, so those names are read back from the running server rather
 * than assumed.
 *
 * Usage: node test/inspect-tool-schemas.mts [projectDir]
 */
import { envPaths } from "../lib/paths.ts"
import { readPassword, readState } from "../sandbox/state.ts"
import { connect } from "../cmd/client.ts"

const projectDir = process.argv[2] ?? process.cwd()
const paths = envPaths(projectDir)
const state = readState(paths)
if (!state) {
  console.error(`no moat environment for ${paths.projectDir}; run \`moat up\` first`)
  process.exit(1)
}
if (!state.port || !state.pid) {
  console.error("the sandbox is not running")
  process.exit(1)
}

const client = await connect(state, readPassword(paths)!)
const model = state.model ?? "moat/mock-model"
const [, modelID = "mock-model"] = model.split("/")

const response = await client.tool.list({ query: { provider: "moat", model: modelID } as never })
const data = response.data as unknown
const list: Record<string, unknown>[] = Array.isArray(data)
  ? (data as Record<string, unknown>[])
  : Object.entries((data ?? {}) as Record<string, Record<string, unknown>>).map(([id, value]) => ({ id, ...value }))

console.log(`provider/model: moat/${modelID}`)
console.log("")
console.log(`${"tool".padEnd(14)} parameters (model-facing, authoritative)`)
console.log(`${"-".repeat(14)} ${"-".repeat(60)}`)
for (const tool of list) {
  const id = String(tool.id ?? tool.name ?? "?")
  const schema = (tool.jsonSchema ?? tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] }
  const properties = schema.properties ? Object.keys(schema.properties) : []
  const required = new Set(schema.required ?? [])
  const rendered = properties.map((name) => (required.has(name) ? name : `${name}?`)).join(", ")
  console.log(`${id.padEnd(14)} ${rendered}`)
}
