// Functional verification harness for the session-id plugin (mock client, no live opencode).
// Run: node --experimental-strip-types ~/.config/opencode/tests/session-id/session-id-test.mjs
import { SessionIdPlugin } from "../../plugins/session-id.ts"

const sessions = {
  root: { id: "root", parentID: undefined },
  child: { id: "child", parentID: "root" },
  grand: { id: "grand", parentID: "child" },
}
const client = {
  session: { get: async ({ path }) => ({ data: sessions[path.id] ?? { id: path.id } }) },
}
const plugin = await SessionIdPlugin({ client })

// 1. root resolves to itself, not truncated
const r = await plugin.tool.session_id.execute({}, { sessionID: "root" })
if (r.output !== "root" || r.metadata.truncated) throw new Error("root should resolve to itself: " + JSON.stringify(r))

// 2. grandchild walks parentID up to root
const g = await plugin.tool.session_id.execute({}, { sessionID: "grand" })
if (g.output !== "root") throw new Error("grand should walk to root, got " + g.output)

// 3. transient API error returns best-effort id with truncated flag
const broken = await SessionIdPlugin({
  client: { session: { get: async () => { throw new Error("boom") } } },
})
const e = await broken.tool.session_id.execute({}, { sessionID: "child" })
if (e.output !== "child" || e.metadata.truncated !== true) throw new Error("error path should return truncated best-effort: " + JSON.stringify(e))

console.log("ALL CHECKS PASSED")
