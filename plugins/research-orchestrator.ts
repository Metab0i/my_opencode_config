import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"

const TMP = join(homedir(), "tmp")
const STATE_PATH = join(TMP, "research_state.json")
const LOG_PATH = join(TMP, "research_pipeline.log")

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function loadState(): any {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"))
    if (raw && typeof raw === "object") return raw
  } catch {
    /* first run */
  }
  return { version: 1, sources: {}, reports: [] }
}

function saveState(state: any) {
  const tmp = STATE_PATH + ".tmp"
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, STATE_PATH)
}

function logStage(stage: string, detail: string) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, JSON.stringify({ stage, detail, ms: Date.now() }) + "\n")
  } catch {
    /* logging is best-effort */
  }
}

function extractContractLine(text: string, key: "LEDGER_PATH" | "REPORT_PATH"): string | null {
  if (!text) return null
  const re = new RegExp(`${key}:\\s*([^\\s\`"'<>]+)`, "m")
  const m = text.match(re)
  if (!m) return null
  return m[1].replace(/[.(),;]+$/, "").trim()
}

export default (async () => {
  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return

      const args: any = input.args ?? {}
      const subagent: string = args.subagent_type ?? args.agent ?? ""
      const resultText: string = output.output ?? ""

      if (subagent === "research-assistant") {
        const lp = extractContractLine(resultText, "LEDGER_PATH")
        if (!lp) {
          logStage("extract", "no LEDGER_PATH returned")
          return
        }
        const full = expandHome(lp)
        if (!existsSync(full)) {
          logStage("extract", `missing ledger file: ${lp}`)
          return
        }
        try {
          const data = JSON.parse(readFileSync(full, "utf8"))
          const url: string = data?.source?.url ?? lp
          const facts: any[] = Array.isArray(data?.facts) ? data.facts : []
          const state = loadState()
          state.sources[url] = {
            ledger_path: lp,
            fact_count: facts.length,
            status: facts.length > 0 ? "ok" : "empty",
            mtime: new Date().toISOString(),
          }
          saveState(state)
          logStage("extract", `ledger ${lp} (${facts.length} facts)`)
        } catch (e) {
          logStage("extract", `ledger parse error for ${lp}: ${e}`)
        }
        return
      }

      if (subagent === "deep-research") {
        const rp = extractContractLine(resultText, "REPORT_PATH")
        if (!rp) {
          logStage("synthesize", "no REPORT_PATH returned")
          return
        }
        const full = expandHome(rp)
        const ok = existsSync(full)
        const state = loadState()
        state.reports = state.reports ?? []
        state.reports.push({
          report_path: rp,
          status: ok ? "ok" : "missing",
          mtime: new Date().toISOString(),
        })
        saveState(state)
        logStage("synthesize", ok ? `report compiled @ ${rp}` : `REPORT_PATH missing: ${rp}`)
        return
      }
    },
  }
}) satisfies Plugin
