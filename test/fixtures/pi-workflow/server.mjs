// A real stdio MCP server for project documentation. Only its model peer is
// scripted: initialize, discovery, calls, resources and shutdown use Pi's MCP client.
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import picomatch from "picomatch"

const witness = (event, extra = {}) => fs.appendFileSync("/opt/moat-mcp-events.jsonl", JSON.stringify({
  event, uid: process.getuid(), cwd: process.cwd(),
  sandbox: process.env.MOAT_SANDBOX ?? null,
  hostCanary: process.env.HOST_ONLY_MCP_CANARY ?? null,
  hostPathVisible: fs.existsSync(process.argv[2]), ...extra,
}) + "\n")
const document = () => fs.readFileSync("docs/arithmetic.md", "utf8")
const input = readline.createInterface({ input: process.stdin })
const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
input.on("line", line => {
  const request = JSON.parse(line)
  if (request.id === undefined) {
    if (request.method === "notifications/initialized") witness("initialized")
    return
  }
  switch (request.method) {
    case "initialize":
      respond(request.id, { protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "moat-project-docs", version: "1.0.0" },
        instructions: "Read the project's arithmetic documentation before editing." })
      break
    case "ping": respond(request.id, {}); break
    case "tools/list":
      respond(request.id, { tools: [{ name: "search_docs", description: "Search project documentation by file glob",
        inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] })
      break
    case "tools/call": {
      if (request.params.name !== "search_docs") throw new Error("unexpected fixture tool")
      const pattern = request.params.arguments.pattern
      const matches = fs.readdirSync("docs").filter(picomatch(pattern)).map(name => ({ name, text: fs.readFileSync(path.join("docs", name), "utf8") }))
      witness("search", { pattern, matches: matches.length })
      respond(request.id, { content: [{ type: "text", text: JSON.stringify(matches) }] })
      break
    }
    case "resources/list": respond(request.id, { resources: [{ uri: "docs://project/arithmetic", name: "Arithmetic specification", mimeType: "text/markdown" }] }); break
    case "resources/templates/list": respond(request.id, { resourceTemplates: [] }); break
    case "resources/read":
      if (request.params.uri !== "docs://project/arithmetic") throw new Error("unexpected fixture resource")
      witness("resource")
      respond(request.id, { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: document() }] })
      break
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not supported by the fixture" } }) + "\n")
  }
})
input.on("close", () => { witness("stdin closed"); process.exit(0) })
