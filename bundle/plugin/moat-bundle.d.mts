export type MoatBundleInput = {
  worktree?: string
  directory?: string
  serverUrl?: string
}

export type MoatBundleHooks = {
  config?: (config: { permission?: Record<string, string>; tools?: Record<string, boolean> }) => Promise<void>
  "permission.ask"?: (input: unknown, output: { status?: string }) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID?: string; callID?: string },
    output: { args?: Record<string, unknown> },
  ) => Promise<void>
  "tool.execute.after"?: (input: unknown, output: { title?: string; output?: unknown }) => Promise<void>
  "shell.env"?: (input: unknown, output: { env: Record<string, string> }) => Promise<void>
  dispose?: () => Promise<void>
}

export declare function MoatBundle(input: MoatBundleInput): Promise<MoatBundleHooks>
export default MoatBundle
