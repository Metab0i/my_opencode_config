// Functional verification harness for the budget plugin (mock client, no live opencode).
// Run: OPENCODE_BUDGET_STATE_FILE=/tmp/opencode/bt-state.json \
//        node --experimental-strip-types ~/.config/opencode/tests/budget/budget-test.mjs
import { BudgetPlugin, shouldBlock, gateMessage, ALLOW_OVER_BUDGET } from "../../plugins/budget.ts"

const sessions = {
  root: { id: "root", parentID: undefined },
  child: { id: "child", parentID: "root" },
}
const msgs = {
  // root has one assistant message with known cost
  root: [{ info: { role: "assistant", id: "m1", sessionID: "root", cost: 0.6, tokens: { input: 6000, output: 500, reasoning: 0 } } }],
  child: [{ info: { role: "assistant", id: "m2", sessionID: "child", cost: 0.08, tokens: { input: 800, output: 50, reasoning: 0 } } }],
}
const aborts = []

const client = {
  session: {
    get: async ({ path }) => ({ data: sessions[path.id] ?? { id: path.id } }),
    messages: async ({ path }) => ({ data: msgs[path.id] ?? [] }),
    children: async ({ path }) => ({ data: path.id === "root" ? [sessions.child] : [] }),
    abort: async ({ path }) => { aborts.push(path.id); return { data: {} } },
  },
}

const plugin = await BudgetPlugin({ client })

// 1. system.transform on root: should hydrate root (0.6) + child (0.08) = 0.68 aggregate
const out1 = { system: [] }
await plugin["experimental.chat.system.transform"]({ sessionID: "root" }, out1)
console.log("ROOT BLOCK:\n" + out1.system[0] + "\n")
if (!out1.system[0].includes("$0.68") || !out1.system[0].includes("$2.00")) throw new Error("root aggregate wrong")

// 2. subagent transform: same aggregate, plus own-spend line
const out2 = { system: [] }
await plugin["experimental.chat.system.transform"]({ sessionID: "child" }, out2)
console.log("CHILD BLOCK:\n" + out2.system[0] + "\n")
if (!out2.system[0].includes("$0.68")) throw new Error("child aggregate wrong")
if (!out2.system[0].includes("Your session's spend: $0.08")) throw new Error("child own-spend missing")

// 3. live message event updates root spend (delta)
await plugin.event({ event: { type: "message.updated", properties: { info: { role: "assistant", id: "m3", sessionID: "root", cost: 0.05, tokens: { input: 100, output: 20, reasoning: 0 } } } } })
const out3 = { system: [] }
await plugin["experimental.chat.system.transform"]({ sessionID: "root" }, out3)
console.log("AFTER LIVE EVENT:\n" + out3.system[0] + "\n")
if (!out3.system[0].includes("$0.73")) throw new Error("live delta not applied (expected $0.73)")

// 4. budget_extend tool: should reject when not exhausted, then set NEW TOTAL (not increment)
const ext1 = await plugin.tool.budget_extend.execute({ newBudget: 4 }, { sessionID: "root" })
console.log("EXTEND (not exhausted):", ext1)
if (!ext1.includes("not yet exhausted")) throw new Error("extend should reject below budget")

// push spend over $2
await plugin.event({ event: { type: "message.updated", properties: { info: { role: "assistant", id: "m4", sessionID: "root", cost: 2.0, tokens: { input: 1000, output: 100, reasoning: 0 } } } } })
const ext2 = await plugin.tool.budget_extend.execute({ newBudget: 3.5 }, { sessionID: "root" })
console.log("EXTEND (exhausted):", ext2)
if (!ext2.includes("$3.50")) throw new Error("extend did not set $3.50")

// 4b. re-extending to a LOWER amount must be rejected (extension only increases)
// first push spend past the extended $3.50 so the tree is exhausted
await plugin.event({ event: { type: "message.updated", properties: { info: { role: "assistant", id: "m5", sessionID: "root", cost: 1.0, tokens: { input: 0, output: 0, reasoning: 0 } } } } })
const ext3 = await plugin.tool.budget_extend.execute({ newBudget: 3.0 }, { sessionID: "root" })
console.log("EXTEND (lower, rejected):", ext3)
if (!ext3.includes("must increase")) throw new Error("lowering budget should be rejected")

// 5. tier escalation to exhausted (ask mode) — spend now $3.73 vs budget $3.50
const out5 = { system: [] }
await plugin["experimental.chat.system.transform"]({ sessionID: "root" }, out5)
console.log("EXHAUSTED BLOCK:\n" + out5.system[0] + "\n")
if (!out5.system[0].includes("question tool")) throw new Error("ask-mode exhausted text missing")

// 6. gate: over budget -> non-exempt tool blocked (spend $3.73 vs budget $3.50)
if (typeof plugin["tool.execute.before"] !== "function") throw new Error("gate hook not registered in ask mode")
let gateBlocked = false
try {
  await plugin["tool.execute.before"]({ tool: "bash", sessionID: "root", callID: "c1" })
} catch (e) {
  gateBlocked = true
  if (!String(e.message).includes("blocked")) throw new Error("gate message wrong: " + e.message)
}
if (!gateBlocked) throw new Error("bash should be blocked over budget")

// 7. gate: exempt recovery tools still run over budget
await plugin["tool.execute.before"]({ tool: "question", sessionID: "root", callID: "c2" })
await plugin["tool.execute.before"]({ tool: "budget_extend", sessionID: "root", callID: "c3" })

// 8. gate: below budget -> allowed (fresh plugin + fresh session)
const freshClient = {
  session: {
    get: async ({ path }) => ({ data: { id: path.id } }),
    messages: async () => ({ data: [] }),
    children: async () => ({ data: [] }),
  },
}
const freshPlugin = await BudgetPlugin({ client: freshClient })
await freshPlugin["tool.execute.before"]({ tool: "bash", sessionID: "fresh", callID: "c4" }) // must not throw

// 9. pure policy: >= semantics, allowlist, message contents, mode tails
if (shouldBlock(1.0, 2, "bash", "ask") !== null) throw new Error("below limit should not block")
if (typeof shouldBlock(2.0, 2, "bash", "ask") !== "string") throw new Error("cost === limit should block")
const overMsg = shouldBlock(2.5, 2, "bash", "ask")
if (typeof overMsg !== "string") throw new Error("cost > limit should block")
if (!overMsg.includes("$2.50") || !overMsg.includes("$2.00") || !overMsg.includes("bash")) throw new Error("gate message missing figures/tool")
if (shouldBlock(9, 2, "budget_extend", "ask") !== null) throw new Error("budget_extend should be exempt")
if (shouldBlock(9, 2, "question", "ask") !== null) throw new Error("question should be exempt")
if (shouldBlock(9, 2, "question", "pressure") !== null) throw new Error("question should be exempt in pressure")
const askTail = gateMessage(3, 2, "read", "ask")
const pressureTail = gateMessage(3, 2, "read", "pressure")
if (!askTail.includes("budget extension via the question tool")) throw new Error("ask tail wrong")
if (!pressureTail.includes("No further tool calls") || pressureTail.includes("budget extension")) throw new Error("pressure tail wrong")
if (ALLOW_OVER_BUDGET.size !== 2 || !ALLOW_OVER_BUDGET.has("budget_extend") || !ALLOW_OVER_BUDGET.has("question")) throw new Error("allowlist not exact")

console.log("ALL CHECKS PASSED")
