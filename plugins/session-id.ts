import { tool, type Plugin } from "@opencode-ai/plugin"

/**
 * Root session-id plugin.
 *
 * Exposes a `session_id` tool that returns the ROOT session id of the current
 * task tree by walking `parentID` to the top (the same walk used by
 * `plugins/budget.ts` rootOf). On best-effort failure (transient API error or
 * a circular/over-long chain) the result carries `truncated: true` in metadata
 * so callers can tell it apart from an authoritative root resolution.
 */

export const SessionIdPlugin: Plugin = async ({ client }) => ({
  tool: {
    session_id: tool({
      description:
        "Return the root session id of the current task tree (walk parentID to the top). On best-effort failure the result carries `truncated: true` in metadata.",
      args: {},
      async execute(_args, ctx) {
        let cur = ctx.sessionID
        for (let i = 0; i < 100; i++) {
          try {
            const res = (await client.session.get({ path: { id: cur } })) as any
            const pid = res?.data?.parentID
            if (!pid) return { output: cur, metadata: { session_id: cur } }
            cur = pid
          } catch {
            return { output: cur, metadata: { session_id: cur, truncated: true } }
          }
        }
        return { output: cur, metadata: { session_id: cur, truncated: true } }
      },
    }),
  },
})

export default SessionIdPlugin
