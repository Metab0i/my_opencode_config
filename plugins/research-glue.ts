import { homedir } from "node:os"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"

function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

function slugify(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, "")
  return slug || "report"
}

export const ResearchGlue: Plugin = async () => {
  return {
    tool: {
      make_report_path: tool({
        description:
          "Compute the deterministic report file path for a research query. Returns an absolute path under <home>/research/<slug>.md, where <slug> is the lowercased, hyphen-separated form of the query.",
        args: {
          query: tool.schema.string().describe("The user's research query"),
        },
        async execute(args) {
          const slug = slugify(args.query)
          const path = join(homedir(), "research", `${slug}.md`)
          return { output: path, metadata: { report_path: path, slug } }
        },
      }),
      validate_ledger_paths: tool({
        description:
          "Validate a list of claim-ledger file paths. Checks that each path exists, is a file, parses as JSON, and contains a `source` object and a `facts` array. Returns JSON `{ valid: [{path, facts}], invalid: [{path, reason}] }`.",
        args: {
          paths: tool.schema.array(tool.schema.string()).describe("Ledger file paths (may start with ~)"),
        },
        async execute(args) {
          const valid: Array<{ path: string; facts: number }> = []
          const invalid: Array<{ path: string; reason: string }> = []
          for (const p of args.paths) {
            const abs = expandHome(p)
            try {
              const s = await stat(abs)
              if (!s.isFile()) {
                invalid.push({ path: p, reason: "not a file" })
                continue
              }
              const raw = await readFile(abs, "utf8")
              const data: any = JSON.parse(raw)
              if (
                data &&
                typeof data === "object" &&
                "source" in data &&
                Array.isArray(data.facts)
              ) {
                valid.push({ path: p, facts: data.facts.length })
              } else {
                invalid.push({ path: p, reason: "missing `source` object or `facts` array" })
              }
            } catch (e) {
              invalid.push({ path: p, reason: e instanceof Error ? e.message : String(e) })
            }
          }
          return {
            output: JSON.stringify({ valid, invalid }, null, 2),
            metadata: { valid, invalid },
          }
        },
      }),
    },
  }
}
