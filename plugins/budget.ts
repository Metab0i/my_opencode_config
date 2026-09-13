import { tool, type Plugin } from "@opencode-ai/plugin"
import { promises as fs, mkdirSync, writeFileSync, renameSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Session-budget awareness plugin.
 *
 * Injects a compact "budget block" into the system prompt of every LLM call for
 * every agent (primary + subagents), showing the task tree's spend against a
 * per-tree USD budget with escalating pressure tiers, plus concrete
 * token-efficiency directives.
 *
 * Behavior on exceeding the budget is controlled by OPENCODE_BUDGET_EXCEEDED:
 *   - "ask"      (default) agent wraps up, asks the user whether to continue,
 *                and applies an approved amount via the `budget_extend` tool.
 *   - "pressure" max-urgency text only; no ask, no tool.
 *   - "abort"    hard stop: aborts the tree root session.
 *
 * Env config (read once at load; restart opencode to change):
 *   OPENCODE_SESSION_BUDGET   USD per task tree (default 2.00)
 *   OPENCODE_BUDGET_EXCEEDED  ask | pressure | abort (default ask)
 *   OPENCODE_BUDGET_PLUGIN    "off" to disable entirely
 *   OPENCODE_BUDGET_TEMPLATE  optional full override of the block text
 *   OPENCODE_BUDGET_STATE_FILE path to persisted overrides (default
 *                              ~/.local/share/opencode/budget-overrides.json)
 */

type Spend = { cost: number; input: number; output: number; reasoning: number }

const DISABLED = process.env.OPENCODE_BUDGET_PLUGIN === "off"
const MODE = process.env.OPENCODE_BUDGET_EXCEEDED === "abort"
  ? "abort"
  : process.env.OPENCODE_BUDGET_EXCEEDED === "pressure"
    ? "pressure"
    : "ask"
const TEMPLATE = process.env.OPENCODE_BUDGET_TEMPLATE
const STATE_FILE =
  process.env.OPENCODE_BUDGET_STATE_FILE ??
  path.join(os.homedir(), ".local", "share", "opencode", "budget-overrides.json")

function defaultBudget(): number {
  const raw = parseFloat(process.env.OPENCODE_SESSION_BUDGET ?? "2")
  return Number.isFinite(raw) && raw > 0 ? raw : 2
}

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01"
  return `$${n.toFixed(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 10 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return `${Math.round(n)}`
}

export const BudgetPlugin: Plugin = async ({ client }) => {
  if (DISABLED) return {}

  const spend = new Map<string, Spend>()                       // sessionID -> live totals
  const msg = new Map<string, { sid: string; cost: number; input: number; output: number; reasoning: number }>()
  const parent = new Map<string, string | null>()              // sessionID -> parentID (null = root)
  const budget = new Map<string, number>()                     // rootSessionID -> extended budget
  const aborted = new Set<string>()                            // roots aborted in "abort" mode
  const treeCache = new Map<string, string[]>()                // root -> sessionIDs in tree
  const hydrated = new Set<string>()                           // sessions with known spend
  const createdLive = new Set<string>()                        // sessions created after plugin load

  // ---- Persistence of extended budgets (sidecar state file) ----
  const updatedAt = new Map<string, number>()                  // rootSessionID -> last extension time
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let dirty = false                                            // pending unsaved changes

  function snapshot(): string {
    const trees: Record<string, { budget: number; updatedAt: number }> = {}
    for (const [root, b] of budget) {
      trees[root] = { budget: b, updatedAt: updatedAt.get(root) ?? Date.now() }
    }
    return JSON.stringify({ version: 1, trees }, null, 2)
  }

  function writeStateSync(): void {
    try {
      mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      writeFileSync(`${STATE_FILE}.tmp`, snapshot(), "utf8")
      renameSync(`${STATE_FILE}.tmp`, STATE_FILE)
      dirty = false
    } catch {
      // best-effort; leave dirty so a later flush can retry
    }
  }

  async function writeState(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
      await fs.writeFile(`${STATE_FILE}.tmp`, snapshot(), "utf8")
      await fs.rename(`${STATE_FILE}.tmp`, STATE_FILE)
      dirty = false
    } catch {
      // best-effort
    }
  }

  function scheduleSave(immediate: boolean): void {
    dirty = true
    if (immediate) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
      writeStateSync() // user-initiated: must be durable before the tool returns
      return
    }
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; void writeState() }, 1000)
  }

  function isNotFoundSignal(e: any): boolean {
    if (e == null) return false
    const status = e?.status ?? e?.statusCode ?? e?.response?.status
    if (status === 404 || status === 410) return true
    const text = `${e?.code ?? ""} ${e?.message ?? ""}`
    return /not.?found|enoent|404/i.test(text)
  }

  async function isGone(id: string): Promise<boolean> {
    try {
      const res = (await client.session.get({ path: { id } })) as any
      const data = res?.data
      if (data && data.id) return false                      // exists -> keep
      return isNotFoundSignal(res?.error ?? res)             // no data -> maybe gone
    } catch (e) {
      return isNotFoundSignal(e)                              // thrown -> 404 only
    }
  }

  async function loadOverrides(): Promise<void> {
    let state: any = {}
    let corrupt = false
    try {
      const raw = await fs.readFile(STATE_FILE, "utf8")
      state = JSON.parse(raw)
    } catch (e: any) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return // missing -> fresh
      corrupt = true
    }

    if (corrupt) {
      try { await fs.rename(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`) } catch { /* ignore */ }
      return
    }

    const trees = state?.trees
    if (!trees || typeof trees !== "object" || Array.isArray(trees)) return

    for (const [root, entry] of Object.entries(trees)) {
      const b = (entry as any)?.budget
      if (typeof b === "number" && Number.isFinite(b) && b > 0 && !budget.has(root)) {
        budget.set(root, b)
        const t = (entry as any)?.updatedAt
        updatedAt.set(root, typeof t === "number" ? t : Date.now())
      }
    }

    // Reconcile: prune only definitively-gone roots; keep on transient errors.
    let changed = false
    for (const root of [...budget.keys()]) {
      if (await isGone(root)) {
        budget.delete(root)
        updatedAt.delete(root)
        changed = true
      }
    }
    if (changed) await writeState()
  }

  async function ensureSession(id: string): Promise<void> {
    if (hydrated.has(id)) return
    if (createdLive.has(id)) {
      hydrated.add(id)
      if (!spend.has(id)) spend.set(id, { cost: 0, input: 0, output: 0, reasoning: 0 })
      return
    }
    // Pre-existing session: hydrate from persisted history.
    try {
      const res = await client.session.messages({ path: { id } })
      let cost = 0
      let input = 0
      let output = 0
      let reasoning = 0
      for (const m of (res.data ?? []) as any[]) {
        const info = m?.info
        if (info?.role === "assistant") {
          cost += info.cost ?? 0
          input += info.tokens?.input ?? 0
          output += info.tokens?.output ?? 0
          reasoning += info.tokens?.reasoning ?? 0
        }
      }
      spend.set(id, { cost, input, output, reasoning })
    } catch {
      // ignore; fall through to zero
    }
    if (!spend.has(id)) spend.set(id, { cost: 0, input: 0, output: 0, reasoning: 0 })
    hydrated.add(id)
  }

  async function parentOf(id: string): Promise<string | null> {
    if (!parent.has(id)) {
      try {
        const res = await client.session.get({ path: { id } })
        parent.set(id, (res.data as any)?.parentID ?? null)
      } catch {
        parent.set(id, null)
      }
    }
    return parent.get(id) ?? null
  }

  async function rootOf(id: string): Promise<string> {
    let cur = id
    let guard = 0
    while (guard++ < 100) {
      const p = await parentOf(cur)
      if (!p) return cur
      cur = p
    }
    return cur
  }

  async function treeOf(root: string): Promise<string[]> {
    const cached = treeCache.get(root)
    if (cached) return cached
    const ids = new Set<string>([root])
    const queue: string[] = [root]
    while (queue.length) {
      const cur = queue.pop()!
      try {
        const res = await client.session.children({ path: { id: cur } })
        for (const child of (res.data ?? []) as any[]) {
          if (child?.id) {
            parent.set(child.id, child.parentID ?? cur)
            if (!ids.has(child.id)) {
              ids.add(child.id)
              queue.push(child.id)
            }
          }
        }
      } catch {
        // ignore
      }
    }
    const arr = [...ids]
    treeCache.set(root, arr)
    return arr
  }

  async function aggregate(id: string): Promise<{ root: string; cost: number; input: number; output: number; reasoning: number; own: Spend }> {
    const root = await rootOf(id)
    const tree = await treeOf(root)
    let cost = 0
    let input = 0
    let output = 0
    let reasoning = 0
    for (const sid of tree) {
      await ensureSession(sid)
      const s = spend.get(sid)
      if (s) {
        cost += s.cost
        input += s.input
        output += s.output
        reasoning += s.reasoning
      }
    }
    const own = spend.get(id) ?? { cost: 0, input: 0, output: 0, reasoning: 0 }
    return { root, cost, input, output, reasoning, own }
  }

  function buildBlock(a: Awaited<ReturnType<typeof aggregate>>, budgetLimit: number): string {
    const pct = budgetLimit > 0 ? a.cost / budgetLimit : 1

    const header = `[Budget] Task spend: ${fmtUsd(a.cost)} / ${fmtUsd(budgetLimit)} (${Math.min(999, Math.round(pct * 100))}%). Tokens: ${fmtTokens(a.input)} in / ${fmtTokens(a.output)} out.`

    let lines = [header]
    if (a.own !== undefined && a.cost !== a.own.cost) {
      lines.push(`Your session's spend: ${fmtUsd(a.own.cost)}.`)
    }

    if (pct < 0.6) {
      lines.push("Be frugal: minimal diffs, batch related tool calls, never re-read files, prefer grep/glob over full reads, answer without restating context.")
    } else if (pct < 0.85) {
      lines.push("Budget is depleting. Tighten responses, skip exploratory steps, commit to the most likely solution path.")
    } else if (pct < 1) {
      lines.push("Budget nearly exhausted. Wrap up now: produce the final answer/diff with no further tool calls unless strictly required.")
    } else {
      if (MODE === "ask") {
        lines.push("Budget exhausted. Wrap up your current work, produce your final answer, then ask the user via the question tool whether to continue with a new budget limit. If no question tool is available, ask in your final message instead.")
      } else {
        lines.push("Budget exhausted. Every additional call costs the user money. Stop all further tool calls now and produce your final answer with what you have.")
      }
    }

    return lines.join("\n")
  }

  function renderTemplate(a: Awaited<ReturnType<typeof aggregate>>, budgetLimit: number): string {
    const pct = budgetLimit > 0 ? a.cost / budgetLimit : 1
    return (TEMPLATE ?? "")
      .replaceAll("{cost}", fmtUsd(a.cost))
      .replaceAll("{budget}", fmtUsd(budgetLimit))
      .replaceAll("{pct}", String(Math.round(pct * 100)))
      .replaceAll("{tokens_in}", fmtTokens(a.input))
      .replaceAll("{tokens_out}", fmtTokens(a.output))
  }

  void loadOverrides()
  process.on("exit", () => {
    if (!dirty) return
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    try { writeStateSync() } catch { /* ignore */ }
  })

  return {
    event: async ({ event }) => {
      try {
        const type = (event as any)?.type
        const props = (event as any)?.properties ?? {}

        if (type === "message.updated") {
          const info = props.info
          if (info?.role !== "assistant") return
          const prev = msg.get(info.id)
          const cost = info.cost ?? 0
          const input = info.tokens?.input ?? 0
          const output = info.tokens?.output ?? 0
          const reasoning = info.tokens?.reasoning ?? 0
          msg.set(info.id, { sid: info.sessionID, cost, input, output, reasoning })
          const s = spend.get(info.sessionID) ?? { cost: 0, input: 0, output: 0, reasoning: 0 }
          spend.set(info.sessionID, {
            cost: s.cost + (cost - (prev?.cost ?? 0)),
            input: s.input + (input - (prev?.input ?? 0)),
            output: s.output + (output - (prev?.output ?? 0)),
            reasoning: s.reasoning + (reasoning - (prev?.reasoning ?? 0)),
          })
        } else if (type === "message.removed") {
          const sid = props.sessionID
          const mid = props.messageID
          const m = msg.get(mid)
          if (m && sid) {
            msg.delete(mid)
            const s = spend.get(sid)
            if (s) {
              spend.set(sid, {
                cost: s.cost - m.cost,
                input: s.input - m.input,
                output: s.output - m.output,
                reasoning: s.reasoning - m.reasoning,
              })
            }
          }
        } else if (type === "session.created") {
          const info = props.info
          if (info?.id) {
            createdLive.add(info.id)
            parent.set(info.id, info.parentID ?? null)
            treeCache.clear()
          }
        } else if (type === "session.updated") {
          const info = props.info
          if (info?.id) {
            parent.set(info.id, info.parentID ?? null)
          }
        } else if (type === "session.deleted") {
          const info = props.info
          const id = info?.id
          if (id) {
            spend.delete(id)
            hydrated.delete(id)
            createdLive.delete(id)
            parent.delete(id)
            const hadOverride = budget.has(id)
            budget.delete(id)
            updatedAt.delete(id)
            if (hadOverride) scheduleSave(false)
            for (const [mid, m] of msg) {
              if (m.sid === id) msg.delete(mid)
            }
            treeCache.clear()
          }
        }
      } catch {
        // event handling must never throw
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionID = (input as any)?.sessionID
        if (!sessionID) return

        const a = await aggregate(sessionID)
        const budgetLimit = budget.get(a.root) ?? defaultBudget()

        if (MODE === "abort" && a.cost >= budgetLimit && !aborted.has(a.root)) {
          aborted.add(a.root)
          try {
            await client.session.abort({ path: { id: a.root } })
          } catch {
            // ignore
          }
        }

        const block = TEMPLATE ? renderTemplate(a, budgetLimit) : buildBlock(a, budgetLimit)
        output.system.push(block)
      } catch {
        // never break the LLM request
      }
    },

    ...(MODE === "ask"
      ? {
          tool: {
            budget_extend: tool({
              description:
                "Set a new total budget (USD) for this task tree. Only call after the user has explicitly approved continuing past the budget limit and specified the new total budget.",
              args: {
                newBudget: tool.schema.number().positive(),
              },
              async execute(args, ctx) {
                try {
                  const a = await aggregate(ctx.sessionID)
                  const current = budget.get(a.root) ?? defaultBudget()
                  if (a.cost < current) {
                    return `Budget not yet exhausted (spent ${fmtUsd(a.cost)} of ${fmtUsd(current)}); no extension needed.`
                  }
                  const next = args.newBudget
                  if (next <= current) {
                    return `New budget ${fmtUsd(next)} is not greater than the current ${fmtUsd(current)}; the extension must increase the budget.`
                  }
                  budget.set(a.root, next)
                  updatedAt.set(a.root, Date.now())
                  scheduleSave(true)
                  return `Budget extended to ${fmtUsd(next)} for this task tree. Remaining: ${fmtUsd(Math.max(0, next - a.cost))}.`
                } catch (e) {
                  return `Failed to extend budget: ${String(e)}`
                }
              },
            }),
          },
        }
      : {}),
  }
}

export default BudgetPlugin
