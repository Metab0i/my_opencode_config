# Workflows

A minimal, declarative workflow framework for OpenCode. A **workflow** is a JSON file
describing a graph of steps; each step names an existing agent and declares what JSON shape
its response must have. Steps route to the next step based on a field in their output, which
is how loops (`plan → critic → plan`) and branching are expressed.

The workflow runner is a single Node script that talks to an OpenCode server over the SDK;
agents and their prompts stay in your normal OpenCode config, so a workflow never redefines
an agent — it only references one by name.

## Directory layout

```
~/.config/opencode/
├── workflow/                 # workflow DEFINITIONS (JSON data)
│   ├── plan-critic.json
│   └── build-review.json
├── workflows/
│   ├── README.md             # this file
│   └── src/                  # framework CODE (the runner + libraries)
│       ├── workflow-run.mjs  # the runner (entry point)
│       └── lib/
│           ├── workflow.mjs  # schema, loading, routing, template substitution
│           ├── progress.mjs  # live stage/token output + loop detection
│           └── approver.mjs  # headless permission auto-approver
```

- **Definitions** live in `workflow/` (one `.json` per workflow).
- **Framework code** lives in `workflows/src/`. You normally don't touch it; you just run it.

---

## Running a workflow

There are two ways to run one.

### Via the `/workflow` command (recommended inside a session)

```
/workflow plan-critic Plan a small feature that adds a dark-mode toggle
```

The `/workflow` command hands off to the `workflow` agent, which invokes the runner for you.
The command defaults to the current workflow definitions in `workflow/`.

### Directly with Node (headless, shell, or CI)

```bash
node ~/.config/opencode/workflows/src/workflow-run.mjs \
  --workflow plan-critic \
  --request "Plan a small feature that adds a dark-mode toggle" \
  --auto --stream
```

### Options

| Flag | Meaning |
|------|---------|
| `--workflow <name>` | Workflow definition (basename without `.json`). **Required.** |
| `--request "<text>"` | User input line — convenient when the input schema has a single `request` string. |
| `--input '<json>'` | Full JSON input object, validated against the workflow's `input` schema. |
| `--auto` | Auto-approve permission/question requests (headless). Required for unattended runs. |
| `--stream` | Stream token-level output to stderr. |
| `--dir <path>` | Session directory (default: current working directory). |
| `--url <baseUrl>` | Connect to an **already-running** OpenCode server (client-only). Also read from `OPENCODE_SERVER_URL`. Preferred inside an existing session — avoids spawning a second server. |
| `--port <n>` | When no `--url`: server port to spawn on (`0` = random). |
| `--strict` | Treat warnings (e.g. a primary interactive agent) as errors. |

Exit codes: `0` = completed (reached a terminal step), `1` = fatal, `2` = usage error.

---

## Writing a workflow

A workflow file is JSON (JSONC tolerated — `//` and `/* */` comments are stripped). Here is
the full shape:

```jsonc
{
  "name": "plan-critic",            // basename; file is <name>.json
  "description": "Plan, critique, loop until PASS.",
  "input": {                        // OPTIONAL: validates what the caller passes in
    "type": "json_schema",
    "schema": {
      "type": "object",
      "properties": { "request": { "type": "string" } },
      "required": ["request"]
    }
  },
  "start": "plan",                  // id of the first step
  "maxIterations": 5,               // cap on route transitions (loop bound)
  "steps": [                        // see "Steps" below
    {
      "id": "plan",
      "agent": "plan-json",         // an agent from your OpenCode config
      "thinking": "off",            // OPTIONAL: see "Thinking-mode control"
      "prompt": "Plan this:\n{{input.request}}",
      "output": {
        "type": "json_schema",
        "schema": {
          "type": "object",
          "properties": { "plan": { "type": "string" } },
          "required": ["plan"]
        }
      },
      "routes": [
        { "when": { "op": "exists", "field": "plan" }, "next": "critic" }
      ]
    }
    // ...more steps
  ]
}
```

### Steps

Each step declares:

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | Unique identifier (valid JS identifier — `[A-Za-z_][A-Za-z0-9_]*`). |
| `agent` | string | Name of an agent already defined in your OpenCode config. |
| `model` | string \| object | Optional per-step model override. Either `"provider/model"` or `{ "providerID": "...", "modelID": "..." }`. |
| `thinking` | string | Optional. `"off"`, `"on"`, or a literal variant id. See "Thinking-mode control". |
| `prompt` | string \| string[] | Additional instruction for the step (templated; see "Templating"). |
| `output` | object | The shape of the step's response (below). |
| `routes` | array | Rules that choose the next step (below). |
| `maxToolCalls` | number | Optional loop guard: abort if the step exceeds this many tool calls (default 40). |
| `maxRepeat` | number | Optional loop guard: abort if the step repeats the same `(tool, input)` this many times in a row (default 8). |

### Output format

- **`"json_schema"`** — the model must emit JSON matching `schema`. Fields:
  - `schema` (required) — the expected shape.
  - `retryCount` (optional) — how many times the runner retries on invalid JSON.
  - `fallback` (optional) — always `"text"`, and **on by default**. See "The text fallback".
- **`"text"`** — no structured output; the step's raw text is stored (and can be templated
  via `{{stepId}}`). A `text` step **cannot** declare `routes` (routing needs structured
  output).

### Routing

Routing is fully **deterministic** — no LLM decides the next step. After a step runs, the
runner matches each route's `when` against the step's structured output; the first (and
only) matching route's `next` selects the following step.

```jsonc
"routes": [
  { "when": { "op": "equals", "field": "verdict", "value": "REVISION" }, "next": "plan" }
]
```

Supported operators:

- `"equals"` — the field equals `value` (deep equality).
- `"exists"` — the field is present and non-null.

A step **with no matching route is terminal** — the workflow ends there. **Loops are just
routing back to an earlier step** (e.g. `critic → plan`), bounded by `maxIterations`.
Exactly one route may match; if more than one matches the runner errors (ambiguous workflow)
rather than guessing.

### Templating prompts

Prompts use `{{stepId.field}}` placeholders resolved against accumulated step outputs,
with dot-notation for nested fields and an optional `|| fallback` for missing values:

```
Original request: {{input.request}}
Plan to critique: {{plan.plan}}
Prior findings: {{critic.foundIssues || "(none yet — first pass)"}}
```

- `{{input.request}}` is how you read input back.
- Referencing an output that never ran (without a `|| fallback`) is an error — fail fast.

---

## What makes any model work

The runner is designed so a step can run on **any** model, not just ones that natively
produce structured output:

1. **Typed output first.** A `json_schema` step first prompts with `format: json_schema`.
2. **The text fallback (default-on).** If that fails — the model returns a
   `StructuredOutputError`, produces no structured payload, or rejects the forced structured
   call (some "thinking" models do this) — the runner re-prompts the model with the schema
   pasted in as plain text ("Respond with ONLY a JSON object matching this schema…") and
   parses the JSON out of the reply. Only if **both** attempts fail does the step error, and
   the error includes the diagnostics from both.
3. **Loop detection (deterministic).** Each step has a tool-call budget and a repeated-call
   detector. If a step degenerates (e.g. a thinking model that endlessly re-reads the same
   file), the runner aborts that session and falls back to the text path instead of hanging.
   This is a cheap counter over the event stream — not an LLM "observer".

### Thinking-mode control

A step can request a thinking mode via `"thinking": "off" | "on" | "<variant>"`. The runner
inspects the model's **available variants** (via the provider config) and only applies the
request if a matching variant exists:

- `"off"` — prefer a non-thinking variant (matched by name e.g. `none`/`no-reasoning`/`fast`,
  or by config that disables reasoning).
- `"on"` — prefer a thinking variant (e.g. `high`/`max`/`thinking`).
- `"<variant>"` — that exact variant id.

If no matching variant exists, the runner logs a warning **listing what is available** and
proceeds — the text fallback and loop detection still cover the model.

---

## Example: a critique loop

The shipped `workflow/plan-critic.json` is the canonical example. In prose:

1. `plan` (agent `plan-json`) writes a plan → routes to `critic` whenever `plan` exists.
2. `critic` (agent `critic-json`) reviews it and outputs `{ verdict, foundIssues }`.
   - `verdict === "REVISION"` → route back to `plan` (which templates the prior findings).
   - `verdict === "PASS"` → no matching route → terminal, workflow ends.

`workflow/build-review.json` is the same shape for implement-then-review.

---

## How to add one

1. Define the agent(s) you need in `opencode.json` (a `mode: "subagent"` agent with
   `question: "deny"` is ideal for headless steps).
2. Create `workflow/<name>.json` describing the steps and routes.
3. Run it: `/workflow <name> <input>` from a session, or
   `node ~/.config/opencode/workflows/src/workflow-run.mjs --workflow <name> --request "<input>" --auto --stream`.
