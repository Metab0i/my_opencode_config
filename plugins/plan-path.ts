import { tool, type Plugin } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

export const PlanPath: Plugin = async () => ({
  tool: {
    plan_path: tool({
      description:
        "Return the canonical plan file path for the current session: <tmp>/<session_id>/plan.md. Ensures the directory exists.",
      args: {},
      async execute(_args, ctx) {
        const dir = join(tmpdir(), ctx.sessionID)
        await mkdir(dir, { recursive: true })
        return { output: join(dir, "plan.md"), metadata: { session_id: ctx.sessionID } }
      },
    }),
  },
})
