// Persistence verification harness for the budget plugin's sidecar state file.
// Run: OPENCODE_BUDGET_STATE_FILE=/tmp/opencode/budget-persist-test.json \
//        node --experimental-strip-types ~/.config/opencode/tests/budget/persist-test.mjs
import { BudgetPlugin } from "../../plugins/budget.ts"
import { promises as fs } from "node:fs"
import path from "node:path"

const STATE = process.env.OPENCODE_BUDGET_STATE_FILE
if (!STATE) throw new Error("set OPENCODE_BUDGET_STATE_FILE to a temp path")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return true
    await sleep(50)
  }
  return false
}
async function readState() {
  try { return JSON.parse(await fs.readFile(STATE, "utf8")) } catch { return null }
}

function makeClient({ throwGet = false } = {}) {
  return {
    session: {
      get: async ({ path }) => {
        if (throwGet) throw Object.assign(new Error("network down"), { status: 500 })
        return { data: { id: path.id } }
      },
      messages: async () => ({ data: [{ info: { role: "assistant", id: "m", sessionID: "root", cost: 3, tokens: { input: 1, output: 1, reasoning: 0 } } }] }),
      children: async () => ({ data: [] }),
      abort: async () => ({ data: {} }),
    },
  }
}

// clean slate
try { await fs.unlink(STATE) } catch { /* ignore */ }

// 1. extend writes synchronously (durable before tool returns)
const p1 = await BudgetPlugin({ client: makeClient() })
await sleep(50)
const ext = await p1.tool.budget_extend.execute({ newBudget: 5 }, { sessionID: "root" })
console.log("EXTEND:", ext)
let saved = await readState()
if (saved?.trees?.root?.budget !== 5) throw new Error("1. file not written with $5 on extend")
console.log("1. extend persisted synchronously: OK")

// 2. reload restores the budget
const p2 = await BudgetPlugin({ client: makeClient() })
await sleep(50)
const out2 = { system: [] }
await p2["experimental.chat.system.transform"]({ sessionID: "root" }, out2)
console.log("RELOADED:\n" + out2.system[0])
if (!out2.system[0].includes("/ $5.00")) throw new Error("2. budget not restored to $5")
console.log("2. reload restored $5: OK")

// 4. transient get error must NOT prune the override
const p3 = await BudgetPlugin({ client: makeClient({ throwGet: true }) })
await sleep(50)
const out4 = { system: [] }
await p3["experimental.chat.system.transform"]({ sessionID: "root" }, out4)
if (!out4.system[0].includes("/ $5.00")) throw new Error("4. transient error incorrectly pruned override")
console.log("4. transient error kept override: OK")

// 3. delete root -> override removed (debounced write)
await p2.event({ event: { type: "session.deleted", properties: { info: { id: "root" } } } })
const removed = await waitFor(async () => {
  const s = await readState()
  return s !== null && !s.trees?.root
})
if (!removed) throw new Error("3. root override not removed after delete")
console.log("3. delete removed override: OK")

// 5. corrupt file -> backed up, fresh start
await fs.writeFile(STATE, "{ not valid json", "utf8")
await BudgetPlugin({ client: makeClient() })
await sleep(50)
const dir = path.dirname(STATE)
const files = await fs.readdir(dir)
const backup = files.find((f) => f.startsWith(path.basename(STATE) + ".corrupt-"))
if (!backup) throw new Error("5. corrupt file not backed up")
console.log("5. corrupt file backed up:", backup)

console.log("ALL PERSISTENCE CHECKS PASSED")
