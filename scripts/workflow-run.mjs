#!/usr/bin/env node
/**
 * workflow-run.mjs — generic declarative workflow runner over @opencode-ai/sdk (v2).
 *
 * Executes a workflow definition (JSON under ~/.config/opencode/workflow/<name>.json).
 * The workflow is pure data: it references agents (which must already exist in the
 * OpenCode config) and declares, per step, the JSON shape the step's response must have.
 * A step can route to a next step based on a field in its structured output — this is
 * how loops (e.g. plan -> critic -> revise) and branching are expressed declaratively.
 *
 * Usage:
 *   node workflow-run.mjs --workflow <name> --request "<input>"
 *        [--input <json-object>] [--auto] [--stream] [--dir <path>]
 *        [--url <baseUrl> | --port <n>] [--strict]
 *
 *   --workflow <name>   workflow definition (basename, no .json) — required
 *   --request <text>    user input line (convenience for an input schema expecting a request)
 *   --input <json>      full JSON input object (validated against the workflow `input` schema)
 *   --auto              auto-approve permissions/questions (headless)
 *   --stream            stream token-level output to stderr
 *   --dir <path>        session directory (default cwd)
 *   --url <baseUrl>     connect to an ALREADY-RUNNING opencode server (client-only mode)
 *                       instead of spawning one (e.g. http://127.0.0.1:4096). Also read
 *                       from OPENCODE_SERVER_URL. This is the preferred mode inside an
 *                       existing opencode session — no second server is spun up.
 *   --port <n>          when no --url is given: server port to spawn on (0 = random)
 *   --strict            treat warnings (e.g. primary interactive agent) as errors
 *
 * Exit codes:
 *   0 = workflow completed (reached a terminal step with no routes)
 *   1 = fatal (error during run, loop exhausted, missing agent, structured-output failure)
 *   2 = usage (bad/missing args, invalid workflow or input)
 */

import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2"
import { startAutoApprover } from "./lib/approver.mjs"
import { ProgressReporter } from "./lib/progress.mjs"
import { loadWorkflowByName, substitute, evaluateRoute, missingAgents, normalizeModel, workflowDir } from "./lib/workflow.mjs"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function usage() {
  return `usage: node workflow-run.mjs --workflow <name> --request "<input>" [options]
  --workflow <name>    workflow definition (basename, no .json) — required
  --request <text>     user input (for workflows whose input schema has a "request" field)
  --input <json>       full JSON input object (validated against the workflow input schema)
  --auto               auto-approve permissions/questions (headless)
  --stream             stream token-level output
  --dir <path>         session directory (default cwd)
  --url <baseUrl>      connect to an existing server (client-only, preferred in-session)
  --port <n>           server port to spawn when no --url (default 0 = random)
  --strict             treat warnings as errors (exit 1)
`
}

function parseArgs(argv) {
  const out = {
    workflow: null,
    request: "",
    input: null,
    auto: false,
    stream: false,
    dir: process.cwd(),
    url: process.env.OPENCODE_SERVER_URL || null,
    port: 0,
    strict: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => (i + 1 < argv.length ? argv[++i] : null)
    switch (a) {
      case "--workflow":
        out.workflow = next()
        break
      case "--request":
        out.request = next() ?? ""
        break
      case "--input":
        out.input = next()
        break
      case "--auto":
        out.auto = true
        break
      case "--stream":
        out.stream = true
        break
      case "--dir":
        out.dir = next() ?? out.dir
        break
      case "--url":
        out.url = next() ?? out.url
        break
      case "--port": {
        const n = Number(next())
        if (Number.isInteger(n) && n >= 0) out.port = n
        else {
          console.error("error: --port must be an integer >= 0")
          process.exit(2)
        }
        break
      }
      case "--strict":
        out.strict = true
        break
      case "-h":
      case "--help":
        process.stdout.write(usage())
        process.exit(0)
      default:
        // bare argument = additional request text
        if (!a.startsWith("--")) out.request += (out.request ? " " : "") + a
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Structured-input construction
// ---------------------------------------------------------------------------

/** Build the workflow input object from --request / --input. */
function buildInput(args, wf) {
  if (args.input) {
    try {
      return JSON.parse(args.input)
    } catch (e) {
      throw new UsageError(`--input is not valid JSON: ${e.message}`)
    }
  }
  if (args.request) return { request: args.request }
  // No input at all: only valid if the workflow declares no input schema.
  if (!wf.input) return {}
  throw new UsageError(
    `workflow "${wf.name}" declares an input schema; provide --request "<text>" or --input '<json>'`,
  )
}

class UsageError extends Error {}
class WorkflowError extends Error {}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/** Substitute + concatenate a step's prompt (string or string[]) against outputs. */
function buildPrompt(step, outputs) {
  const source = step.prompt
  if (source == null) return undefined
  const parts = Array.isArray(source) ? source : [source]
  return parts.map((p) => substitute(p, outputs)).join("\n\n")
}

/**
 * Run one step: prompt the step's agent with the step's output format, and return the
 * structured (validated) output. Falls back to the last text part for `type:"text"` steps.
 */
async function runStep(client, ctx, step, outputs) {
  const promptText = buildPrompt(step, outputs)
  const model = normalizeModel(step.model)
  if (step.output.type === "text") {
    const res = await client.session.prompt({
      sessionID: ctx.sessionID,
      directory: ctx.dir,
      agent: step.agent,
      model,
      parts: promptText ? [{ type: "text", text: promptText }] : [],
    })
    checkHttpError(res, step)
    const info = res.data.info
    checkAssistantError(info, step)
    const text = lastTextPart(res.data.parts)
    return { structured: undefined, text }
  }

  const res = await client.session.prompt({
    sessionID: ctx.sessionID,
    directory: ctx.dir,
    agent: step.agent,
    model,
    format: { type: "json_schema", schema: step.output.schema, retryCount: step.output.retryCount },
    parts: promptText ? [{ type: "text", text: promptText }] : [],
  })
  checkHttpError(res, step)
  const info = res.data.info
  checkAssistantError(info, step)
  if (info.structured === undefined || info.structured === null) {
    throw new WorkflowError(
      `step "${step.id}" returned no structured output despite json_schema format`,
    )
  }
  return { structured: info.structured, text: undefined }
}

/** Surface HTTP-level failures (400/404/etc.) clearly instead of a `res.data` TypeError. */
function checkHttpError(res, step) {
  if (res.error) {
    const e = res.error
    const status = e?.statusCode != null ? ` (HTTP ${e.statusCode})` : ""
    throw new WorkflowError(
      `step "${step.id}" request failed${status}: ${e?.data?.message ?? e?.message ?? JSON.stringify(e)}`,
    )
  }
  if (!res.data) {
    throw new WorkflowError(`step "${step.id}" returned an empty response`)
  }
}

/** Surface StructuredOutputError / other assistant errors clearly, not as a crash. */
function checkAssistantError(info, step) {
  if (!info.error) return
  const err = info.error
  const name = err?.name ?? "Error"
  const extra = err?.data?.retries != null ? ` (after ${err.data.retries} retries)` : ""
  throw new WorkflowError(
    `step "${step.id}" failed: ${name}${extra}: ${err?.data?.message ?? JSON.stringify(err)}`,
  )
}

/** Extract the last text part (with a clear error, fixing the old lastTextPart crash). */
function lastTextPart(parts) {
  const list = Array.isArray(parts) ? parts : []
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === "text") return list[i].text
  }
  throw new WorkflowError("assistant response contained no text part")
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

async function resolveAgents(client, ctx, wf) {
  const res = await client.app.agents({ directory: ctx.dir })
  const agentNames = (res.data ?? []).map((a) => a.name)

  const missing = missingAgents(wf, agentNames)
  if (missing.length) {
    throw new WorkflowError(
      `workflow "${wf.name}" references agent${missing.length > 1 ? "s" : ""} ` +
        `not defined in the OpenCode config: ${missing.join(", ")}. ` +
        `Available agents: ${agentNames.join(", ") || "(none)"}`,
    )
  }

  // Warn (or error under --strict) about primary interactive agents, which would have
  // their clarify questions auto-answered in headless --auto mode.
  const primaryInteractive = []
  for (const a of res.data ?? []) {
    const used = wf.steps.some((s) => s.agent === a.name)
    if (!used) continue
    const mode = a.mode
    if (mode === "primary" || mode === "all") {
      // An agent's permission rules are an array of {permission, pattern, action}. The
      // `question: deny` config surfaces as a rule with permission === "question" and
      // action === "deny". If no such deny rule exists, the agent can (or may) ask.
      const questionDenied = (a.permission ?? []).some(
        (r) => r.permission === "question" && r.action === "deny",
      )
      if (!questionDenied) primaryInteractive.push(a.name)
    }
  }
  if (primaryInteractive.length) {
    const msg =
      `workflow "${wf.name}" uses primary interactive agent(s) ` +
      `${primaryInteractive.join(", ")} (question not denied); in headless --auto mode their ` +
      `clarify questions would be auto-answered. Prefer a subagent (mode: subagent).`
    if (ctx.strict) throw new WorkflowError(msg)
    console.error(`[warn] ${msg}`)
  }

  return new Map((res.data ?? []).map((a) => [a.name, a]))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.workflow) {
    console.error(usage())
    console.error("error: --workflow <name> is required")
    process.exit(2)
  }

  let server = null
  let approver = null
  try {
    // Load + validate the workflow definition (usage error on invalid/unknown).
    let wf
    try {
      wf = await loadWorkflowByName(args.workflow, workflowDir())
    } catch (e) {
      if (e instanceof WorkflowError) throw e
      throw new UsageError(e.message)
    }
    console.error(`[workflow] ${wf.name} (${wf.steps.length} steps)`)

    // Build + normalize the input.
    const input = buildInput(args, wf)

    // Connect to an existing server (client-only) when --url/OPENCODE_SERVER_URL is set;
    // otherwise spawn a fresh server. Client-only is preferred inside an opencode session.
    let client
    if (args.url) {
      client = createOpencodeClient({ baseUrl: args.url, directory: args.dir })
      console.error(`[client] connected to existing server at ${args.url}`)
    } else {
      const created = await createOpencode({ port: args.port })
      client = created.client
      server = created.server
      console.error(`[server] spawned at ${created.server.url}`)
    }

    const agents = await resolveAgents(client, { dir: args.dir, strict: args.strict }, wf)

    if (args.auto) {
      approver = startAutoApprover(client, args.dir)
      console.error("[auto] permission auto-approval enabled")
    }

    const sess = await client.session.create({ title: `workflow:${wf.name}`, directory: args.dir })
    const sessionID = sess.data.id
    console.error(`[session] ${sessionID}`)

    const reporter = new ProgressReporter(client, { sessionID, directory: args.dir, stream: args.stream })
    const ctx = { sessionID, dir: args.dir, strict: args.strict }
    const outputs = { input }

    // Execute the step graph: follow routes until a step has no matching route (terminal).
    // Loops are expressed by routing BACK to an earlier step (e.g. critic -> revise ->
    // critic); revisiting a step is expected, not an error. `maxIterations` caps the total
    // number of route transitions so a non-converging graph fails fast instead of forever.
    let current = wf.start
    let iterations = 0
    let stepOrdinal = 0
    const stepMap = new Map(wf.steps.map((s) => [s.id, s]))

    try {
      while (current) {
        const step = stepMap.get(current)
        if (!step) throw new WorkflowError(`unknown step "${current}"`)
        if (step.parallel) {
          throw new WorkflowError(
            `step "${step.id}" declares "parallel: true" but parallel execution is not ` +
              `implemented yet (prototype open question, see plan §4.4)`,
          )
        }

        stepOrdinal++
        const stepModel = normalizeModel(step.model) ?? normalizeModel(agents.get(step.agent)?.model)
        await reporter.start({
          label: `${step.id}`,
          agent: step.agent,
          model: stepModel,
          index: stepOrdinal,
          total: wf.steps.length,
        })
        const { structured, text } = await runStep(client, ctx, step, outputs)
        if (structured !== undefined) {
          outputs[step.id] = structured
        } else {
          // Text step: store the raw text so later steps can template it via {{stepId}}.
          outputs[step.id] = text
          if (step.routes?.length) {
            throw new WorkflowError(
              `step "${step.id}" has output type "text" but declares routes; ` +
                `declarative routing requires a json_schema output`,
            )
          }
        }
        reporter.done()

        // Route.
        const route = evaluateRoute(step.routes, structured)
        if (!route) {
          current = null // terminal step
          break
        }
        current = route.next
        iterations++
        if (iterations > wf.maxIterations) {
          throw new WorkflowError(
            `workflow "${wf.name}" exceeded maxIterations (${wf.maxIterations}); ` +
              `did not reach a terminal step`,
          )
        }
      }

      reporter.summary()
      const summary = {
        workflow: wf.name,
        sessionID,
        iterations,
        outputs: Object.fromEntries(
          Object.entries(outputs).filter(([k]) => k !== "input"),
        ),
      }
      console.log(JSON.stringify(summary, null, 2))
    } finally {
      reporter.close()
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`usage error: ${e.message}`)
      process.exitCode = 2
    } else {
      console.error(`fatal: ${e?.message ?? e}`)
      process.exitCode = 1
    }
  } finally {
    if (approver) approver.stop()
    if (server) {
      // Best-effort close with a bound; we hard-exit below regardless so a lingering
      // child session (or a nested runner the agent spawned) can't hold the process open.
      await Promise.race([
        Promise.resolve(server.close()).catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ])
      console.error("[done] server closed")
    }
  }

  // Guarantee termination: a workflow runner must not outlive its run. Set exitCode from
  // the summary path (success) or the catch path above; force the process to exit now.
  process.exit(process.exitCode ?? 0)
}

main()
