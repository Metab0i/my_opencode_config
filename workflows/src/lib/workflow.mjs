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
 *   loadWorkflow(obj)       - validate + normalize a raw JSON object into a Workflow
 *   loadWorkflowByName      - load + validate a workflow JSON file by name
 *   workflowDir()           - default workflows directory (~/.config/opencode/workflow)
 *   substitute(text,..)     - {{stepId.field}} template substitution (no code exec)
 *   evaluateRoute           - match a route's `when` against a step's structured output
 *   missingAgents           - which step.agent names are NOT in the config agent list
 *   normalizeModel          - "provider/model" | {providerID,modelID} -> SDK shape
 *   extractJson(text)       - pull a JSON object/array out of free-form text (fallback)
 *   validateAgainstSchema   - lightweight structural schema check (fallback-path safety)
 *   pickVariant(thinking)   - choose a variant id for a step's thinking request
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
// "json_schema" means the model must emit JSON matching `schema`. json_schema steps get a
// text fallback by DEFAULT (fallback: "text" is accepted but optional); see runStep.
const OutputFormat = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("json_schema"),
    schema: JsonSchema,
    retryCount: z.number().int().nonnegative().optional(),
    fallback: z.enum(["text"]).optional().default("text"),
    // Fallback fix-loop: after the structured path fails and the text fallback produces
    // invalid JSON, re-prompt the model (feeding back what was wrong) up to N times.
    // Default (from the runner) is 3; a step can override with an explicit positive int.
    fixRetries: z.number().int().positive().optional(),
  }),
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
// a model even when the referenced agent/default model differs.
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
  // Thinking-mode control: "off" prefers a non-thinking variant, "on" prefers a thinking
  // variant, or a literal variant id. The runner checks the model's available variants and
  // only applies this if a matching variant exists (see pickVariant).
  thinking: z.string().min(1).optional(),
  prompt: z.union([z.string(), z.array(z.string())]).optional(),
  output: OutputFormat,
  routes: z.array(Route).optional(),
  // Loop-detection overrides (defaults live in the runner): abort the step if it makes more
  // than maxToolCalls total tool calls or repeats the same (tool, input) maxRepeat times.
  maxToolCalls: z.number().int().positive().optional(),
  maxRepeat: z.number().int().positive().optional(),
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
// JSON extraction (text fallback)
// ---------------------------------------------------------------------------

/**
 * Extract a JSON value (object or array) from a free-form text response.
 *
 * The model may wrap valid JSON in markdown code fences or prefix it with prose. This
 * strips ```json fences, then finds the first balanced `{...}` or `[...]` span and parses
 * it. Only safe `JSON.parse` — no `eval`, ever. Returns the parsed value, or throws with a
 * clear message when no valid JSON object/array is found.
 *
 * @param {string} text - the raw assistant text
 * @param {number} maxLen - upper bound on characters scanned (guard against runaway input)
 */
export function extractJson(text, maxLen = 200_000) {
  const s = String(text ?? "").slice(0, maxLen)
  const stripped = s.replace(/```(?:json)?/gi, "```").replace(/```/g, "")
  for (const open of ["{", "["]) {
    const idx = stripped.indexOf(open)
    if (idx === -1) continue
    const close = open === "{" ? "}" : "]"
    const end = matchBalanced(stripped, idx, open, close)
    if (end === -1) continue
    const candidate = stripped.slice(idx, end + 1)
    try {
      const val = JSON.parse(candidate)
      if (val !== null && typeof val === "object") return val
    } catch {
      // keep scanning for the next opener
      continue
    }
  }
  throw new Error(`extractJson: no valid JSON object/array found in response`)
}

/**
 * Lightweight structural validation of a parsed JSON value against a (subset of) a JSON
 * Schema. Dependency-free; this is deliberately NOT a full JSON Schema validator. It
 * enforces exactly what routing + templating depend on:
 *
 *   - required fields are present (recursively), and
 *   - present values' types match the declared `type` (string/number/integer/boolean/
 *     object/array), recursing into object `properties` and array `items`.
 *
 * Ignored (by design): enum/const, min/max*, pattern/format, additionalProperties,
 * oneOf/anyOf/allOf. Extra keys are tolerated — only missing/wrong-shaped fields fail.
 *
 * @param {unknown} value - the parsed JSON (from extractJson) to check
 * @param {Record<string, unknown>} schema - the step's declared json_schema
 * @returns {{ok: true} | {ok: false, errors: string[]}} - errors are plain-language,
 *   human-readable messages like `required field ".verdict" missing` or
 *   `"foundIssues" expected array, got string` (paths are JSON-pointer-ish, prefixed sorry ".").
 */
export function validateAgainstSchema(value, schema) {
  const errors = []
  validateNode(value, schema, "", errors)
  return errors.length ? { ok: false, errors } : { ok: true }
}

function validateNode(value, schema, path, errors) {
  if (schema == null || typeof schema !== "object") return

  const type = schema.type
  const present = value !== undefined && value !== null

  // Missing/null against a declared type.
  if (!present) {
    if (type) errors.push(`expected ${type} at ${atPath(path)}, got ${describe(value)}`)
    return
  }

  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`expected object at ${atPath(path)}, got ${describe(value)}`)
      return
    }
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined || value[key] === null) {
        errors.push(`required field ${JSON.stringify(atPath(`${path}.${key}`))} missing`)
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      // Skip null/missing values: `required` (above) already flags the missing-required
      // case, and recursing here would double-report a null that failed a required check.
      if (value[key] === undefined || value[key] === null) continue
      validateNode(value[key], sub, `${path}.${key}`, errors)
    }
    return
  }

  if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`expected array at ${atPath(path)}, got ${describe(value)}`)
      return
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => validateNode(item, schema.items, `${path}[${i}]`, errors))
    }
    return
  }

  // Scalar types.
  const t = typeof value
  const ok =
    type === "string"
      ? t === "string"
      : type === "number"
        ? t === "number"
        : type === "integer"
          ? t === "number" && Number.isInteger(value)
          : type === "boolean"
            ? t === "boolean"
            : true // unknown/untyped -> accept anything
  if (!ok) errors.push(`expected ${type} at ${atPath(path)}, got ${describe(value)}`)
}

/**
 * Render an internal path ("" for root, else like ".detail.n" or ".issues[0]") as a
 * JSON-path label: root -> "$", nested -> "$.detail.n" / "$.issues[0]".
 */
function atPath(path) {
  return path ? `$${path}` : "$"
}

/** Short, readable description of a JS value for diagnostic messages. */
function describe(value) {
  if (value === undefined) return "missing"
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Find the index of the balanced close for the opener at `start`, or -1. */
function matchBalanced(s, start, open, close) {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// Thinking-mode / variant selection
// ---------------------------------------------------------------------------

/**
 * Choose a model variant to apply for a step's `thinking` request, given the model's
 * capabilities and the set of variants the provider exposes.
 *
 * The runner is expected to resolve the model via `config.providers()` (each Provider
 * exposes `models[key]` with `capabilities.reasoning` and `variants`). This helper decides:
 *   - `thinking: "off"`  -> prefer a variant that disables/`none` reasoning, else undefined.
 *   - `thinking: "on"`   -> prefer a variant that enables/high reasoning, else undefined.
 *   - `thinking: "<id>"` -> that exact variant id if it exists, else undefined.
 *
 * Returns `{ variant }` (the id to pass as `model.variant`) or `{ variant: undefined,
 * reason }` when no matching variant exists so the caller can log a clear message listing
 * what WAS available.
 *
 * @param {string|undefined} thinking - the step's `thinking` request
 * @param {{reasoning?: boolean}} capabilities - the model's capability flags
 * @param {Record<string, unknown>|undefined} variants - the model's variant map
 */
export function pickVariant(thinking, capabilities, variants) {
  const variantMap = variants && typeof variants === "object" ? variants : {}
  const names = Object.keys(variantMap)
  const isReasoningModel = !!capabilities?.reasoning

  if (!thinking) return { variant: undefined }

  // Literal variant id: use it only if it actually exists.
  if (thinking !== "off" && thinking !== "on") {
    if (names.includes(thinking)) return { variant: thinking }
    return {
      variant: undefined,
      reason:
        `variant "${thinking}" does not exist for this model` +
        (names.length ? ` (available: ${names.join(", ")})` : ` (no variants available)`),
    }
  }

  // "off" / "on": match by name, then by config heuristics.
  const wantOff = thinking === "off"

  // 1) Name match first (e.g. OpenAI "none"/"minimal"/"low", Anthropic "high"/"max").
  const offNames = ["none", "no-reasoning", "noreasoning", "fast", "minimal", "low"]
  const onNames = ["high", "max", "xhigh", "thinking"]
  const namePool = wantOff ? offNames : onNames
  for (const name of namePool) {
    if (names.includes(name)) return { variant: name }
  }

  // 2) Config heuristic: inspect each variant's options for reasoning-disabling/enabling.
  for (const name of names) {
    const v = variantMap[name]
    const opts = v && typeof v === "object" ? v : {}
    const disables = signalReasoning(opts) === false
    const enables = signalReasoning(opts) === true
    if (wantOff && disables) return { variant: name }
    if (!wantOff && enables) return { variant: name }
  }

  // No matching variant. "off" on an already-non-reasoning model is a no-op success.
  if (wantOff && !isReasoningModel) return { variant: undefined, reason: null }
  return {
    variant: undefined,
    reason: names.length
      ? `no ${wantOff ? "non-thinking" : "thinking"} variant available (available: ${names.join(", ")})`
      : `no variants available for this model`,
  }
}

/**
 * Heuristic: does a variant's options disable or enable reasoning? Inspects the common
 * option shapes: `reasoningEffort` (OpenAI), `thinking.type`/`thinking.disabled` (Anthropic),
 * and a top-level `reasoning` boolean. Returns true (enables), false (disables), or null.
 */
function signalReasoning(opts) {
  if (opts.reasoning === false || opts.reasoning?.type === "disabled") return false
  if (opts.reasoning === true || opts.reasoning?.type === "enabled") return true
  if (typeof opts.reasoningEffort === "string") {
    const e = opts.reasoningEffort.toLowerCase()
    if (["none", "off", "minimal", "low"].includes(e)) return false
    if (["medium", "high", "xhigh", "max"].includes(e)) return true
  }
  if (opts.thinking != null && typeof opts.thinking === "object") {
    if (opts.thinking.type === "disabled") return false
    if (opts.thinking.type === "enabled") return true
  }
  return null
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
