// Verifies OPENCODE_BUDGET_EXCEEDED modes + OPENCODE_BUDGET_PLUGIN=off (fresh process per mode).
// Run: OPENCODE_BUDGET_EXCEEDED=abort node --experimental-strip-types ~/.config/opencode/tests/budget/mode-test.mjs
import { BudgetPlugin } from "../../plugins/budget.ts"

const client = {
  session: {
    get: async ({ path }) => ({ data: { id: path.id } }),
    messages: async () => ({ data: [{ info: { role: "assistant", id: "m", sessionID: "r", cost: 5, tokens: { input: 1, output: 1, reasoning: 0 } } }] }),
    children: async () => ({ data: [] }),
    abort: async () => { globalThis.__aborted = true; return { data: {} } },
  },
}

// mode depends on env at import time
const mode = process.env.OPENCODE_BUDGET_EXCEEDED ?? "ask"

if (process.env.OPENCODE_BUDGET_PLUGIN === "off") {
  const p = await BudgetPlugin({ client })
  console.log("DISABLED hooks keys:", Object.keys(p).join(",") || "(empty)")
} else {
  const p = await BudgetPlugin({ client })
  const out = { system: [] }
  await p["experimental.chat.system.transform"]({ sessionID: "r" }, out)
  console.log(`MODE=${mode} tool present:`, "budget_extend" in (p.tool ?? {}), "| aborted:", globalThis.__aborted === true, "| block tail:", out.system[0].split("\n").slice(-1)[0])
}
