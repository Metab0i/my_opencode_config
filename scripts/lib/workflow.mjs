/**
 * Workflow framework core: JSON schema (zod) + loader + pure helpers.
 *
 * A workflow is a JSON file (pure data) describing a graph of steps. Each step names an
 * agent (referenced, NOT defined — the agent must already exist in the OpenCode config),
 * declares the JSON shape its response must have (via `format: json_schema`), and can
 * route to a next step based on a field in that structured output. This module is the
 * piece of the framework that has NO server dependency, so it is unit-testable in
 * isolation.
 *
 * Exports:
 *   WorkflowSchema      - zod schema for a workflow definition
 *   loadWorkflow(obj)   - validate + normalize a raw JSON object into a Workflow
 *   resolveWorkflowDir  - default workflows directory (~/.config/opencode/workflow)
 *   substitute(input)   - {{stepId.field}} template substitution (no code exec)
 *   evaluateRoute       - match a route's `when` against a step's structured output
 *   missingAgents       - which step.agent names are NOT in the config agent list
 */

import { z } from "zod"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, sep } from "node:path"

// ---------------------------------------------------------------------------
// Workflow JSON schema
// ---------------------------------------------------------------------------

const JsonSchema = z.record(z.string(), z.unknown())

// A step's output format. "text" means "no structured output" (read the text part);
// "json_schema" means the model must emit JSON matching `schema`.
const OutputFormat = z.discriminatedUnion("type", [
  z.object({ type: z.literal("json_schema"), schema: JsonSchema, retryCount: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("text") }),
])

const When = z.discriminatedUnion("op", [
  z.object({ op: z.literal("equals"), field: z.string().min(1), value: z.unknown() }),
  z.object({ op: z.literal("exists"), field: z.string().min(1) }),
])

const Route = z.object({
  when: When,
  next: z.string().min(1),
})

// Model override: either "provider/model" or { providerID, modelID }. Allows a step to pin
// a JSON-capable (non-thinking) model even when the referenced agent/default model is a
// thinking model that can't emit structured output.
const Model = z.union([
  z.string().min(1),
  z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }),
])

// A single step. Prompt may either be a literal string or a list of extra instruction
// strings (concatenated). The prompt is an ADDITIONAL instruction; the agent itself is
// already defined in the config.
const Step = z.object({
  id: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "step id must be a valid identifier"),
  agent: z.string().min(1),
  model: Model.optional(),
  prompt: z.union([z.string(), z.array(z.string())]).optional(),
  output: OutputFormat,
  routes: z.array(Route).optional(),
  // parallel group (prototype): sibling steps run concurrently in child sessions.
  // `mergeInto` names the step id under which the group's outputs are stored (each child
  // step id still stores its own output too).
  parallel: z.boolean().optional(),
})

const WorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input: OutputFormat.optional(),
  steps: z.array(Step).min(1),
  start: z.string().min(1),
  maxIterations: z.number().int().positive().optional().default(5),
})

/**
 * Normalize + validate a raw workflow JSON object into a Workflow.
 * Throws an AggregateError-ish Error with a clear message listing violations.
 * @param {unknown} raw
 */
export function loadWorkflow(raw) {
  const res = WorkflowSchema.safeParse(raw)
  if (!res.success) {
    const msg = res.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("\n  - ")
    throw new Error(`invalid workflow definition:\n  - ${msg}`)
  }
  return validateWorkflow(res.data)
}

/**
 * Cross-field validation that zod can't express (referential integrity).
 * @param {Workflow} wf
 */
function validateWorkflow(wf) {
  const ids = new Set(wf.steps.map((s) => s.id))
  const errors = []

  if (!ids.has(wf.start)) {
    errors.push(`start "${wf.start}" does not name any step`)
  }

  for (const step of wf.steps) {
    for (const r of step.routes ?? []) {
      if (!ids.has(r.next)) {
        errors.push(`step "${step.id}" routes to unknown step "${r.next}"`)
      }
    }
  }

  // Duplicate step ids (zod won't catch this).
  const seen = new Set()
  for (const s of wf.steps) {
    if (seen.has(s.id)) errors.push(`duplicate step id "${s.id}"`)
    seen.add(s.id)
  }

  if (errors.length) throw new Error(`invalid workflow definition:\n  - ${errors.join("\n  - ")}`)

  return wf
}

// ---------------------------------------------------------------------------
// Template substitution
// ---------------------------------------------------------------------------

/**
 * Substitute {{stepId.field}} placeholders in a prompt from accumulated step outputs.
 *
 * Pure string interpolation over structured outputs only. No `eval`, no code paths.
 * Nested field access supports dot-notation (a.b.c) via a safe walk.
 *
 * A `||fallback` suffix makes a variable OPTIONAL: if the path is missing, the fallback
 * text is used instead (useful for loop-carried data that only exists on later iterations,
 * e.g. {{critic.foundIssues || "(no prior findings yet)"}}). Without a fallback, a missing
 * var is an error (fail fast — referencing an output that never ran is flawed).
 *
 * @param {string} text - prompt template
 * @param {Record<string, unknown>} outputs - accumulated stepId -> structured output
 * @returns {string}
 */
export function substitute(text, outputs) {
  return String(text).replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\|\s*([^{}]*?))?\s*\}\}/g,
    (match, path, fallback) => {
      const value = lookup(path, outputs)
      if (value !== undefined) return value
      if (fallback !== undefined) return fallback.trim()
      throw new Error(
        `template variable "{{${path}}}" not found in accumulated outputs ` +
          `(available: ${Object.keys(outputs).join(", ") || "(none)"})`,
      )
    },
  )
}

/** Walk dotted path (e.g. "critic.foundIssues"). Returns the value, or undefined if absent. */
function lookup(path, outputs) {
  const parts = path.split(".")
  let cur = outputs
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) return undefined
    cur = cur[p]
  }
  if (typeof cur === "string") return cur
  return JSON.stringify(cur, null, 2)
}

/**
 * Normalize a per-step model override ("provider/model" or {providerID, modelID}) into the
 * SDK's { providerID, modelID } shape. Returns undefined if no model is set.
 * @param {string|{providerID:string,modelID:string}|undefined} model
 */
export function normalizeModel(model) {
  if (model == null) return undefined
  if (typeof model === "string") {
    const slash = model.indexOf("/")
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(`invalid model "${model}": expected "provider/model"`)
    }
    return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
  return { providerID: model.providerID, modelID: model.modelID }
}

// ---------------------------------------------------------------------------
// Route evaluation
// ---------------------------------------------------------------------------

/**
 * Find the route whose `when` matches the given structured output.
 * Returns the matched route, or null if none matches.
 * Throws if more than one route matches (ambiguous workflow).
 *
 * @param {Array<Route>|undefined} routes
 * @param {unknown} output - the step's structured output
 */
export function evaluateRoute(routes, output) {
  if (!routes || routes.length === 0) return null
  const matched = routes.filter((r) => whenMatches(r.when, output))
  if (matched.length > 1) {
    throw new Error(
      `ambiguous routes: ${matched.length} routes matched output ${JSON.stringify(output)}`,
    )
  }
  return matched[0] ?? null
}

function whenMatches(when, output) {
  if (output == null || typeof output !== "object") return false
  const value = output[when.field]
  if (when.op === "exists") return value !== undefined && value !== null
  if (when.op === "equals") return deepEqual(value, when.value)
  return false
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

/**
 * Which step.agent names do NOT appear in `agentNames`.
 * @param {Workflow} wf
 * @param {string[]} agentNames
 * @returns {string[]} distinct missing agent names
 */
export function missingAgents(wf, agentNames) {
  const avail = new Set(agentNames)
  const missing = new Set()
  for (const s of wf.steps) {
    if (!avail.has(s.agent)) missing.add(s.agent)
  }
  return [...missing]
}

// ---------------------------------------------------------------------------
// Workflow loading from disk
// ---------------------------------------------------------------------------

/** Default workflows directory: ~/.config/opencode/workflow */
export function workflowDir() {
  return process.env.OPENCODE_WORKFLOW_DIR || join(homedir(), ".config", "opencode", "workflow")
}

/**
 * Load + validate a workflow definition by name from its JSON file.
 * @param {string} name - workflow name (file basename without .json)
 * @param {string} [dir] - workflows directory (defaults to workflowDir())
 * @returns {Promise<Workflow>}
 */
export async function loadWorkflowByName(name, dir = workflowDir()) {
  // Guard path traversal: names must be a single basename, no separators.
  if (name !== String(name).trim() || name.includes(sep) || name.includes("/") || name.includes("\\")) {
    throw new Error(`invalid workflow name "${name}"`)
  }
  const file = join(dir, `${name}.json`)
  let text
  try {
    text = await readFile(file, "utf8")
  } catch (e) {
    if (e?.code === "ENOENT") {
      throw new Error(`unknown workflow "${name}" (no file at ${file})`)
    }
    throw e
  }
  let raw
  try {
    raw = JSON.parse(stripComments(text))
  } catch (e) {
    throw new Error(`workflow "${name}" is not valid JSON: ${e.message}`)
  }
  return loadWorkflow(raw)
}

/** Strip // line comments and /* block comments from JSON text (lenient JSONC). */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])?\/\/.*$/gm, (_m, pre) => (pre ?? ""))
}
