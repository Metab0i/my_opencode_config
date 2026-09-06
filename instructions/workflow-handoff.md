# Workflow Handoff

How to receive and act on the output of a declarative workflow (the `/workflow`
command or the `workflow-run.mjs` runner). General fundamentals live in
~/.config/opencode/AGENTS.md.

A workflow runs subagent steps (e.g. `plan-json` → `critic-json`, or `build` →
`reviewer-json`) in its own session. When it finishes, its deliverable is a terminal
JSON outcome block with `status: "complete"`. That block — and the artifacts it points
to — is the workflow's *result*, not a prompt to keep working.

## The relay contract

Once a workflow completes, you are the courier, not the executor:

1. **Summarize the outcome** in a few plain sentences: what the workflow decided,
   produced, or found. Surface every `verdict`, `foundIssues`, plan/prose field, and
   summary that matters. Do not bury or reinterpret them.

2. **Report the artifact locations.** The outcome block's `summary.artifactsDir` is the
   absolute directory holding the results: `result.json` (the full accumulated outputs) and
   `steps/<stepId>.json` (one file per step's structured output). Tell the user where it is
   so they — or a later agent — can read the outcomes directly. `result.json` also records
   `workDir` (the session's working directory, where any step agent wrote files).

3. **Take no further action.** Do not plan, implement, review, iterate, or chain into
   another workflow off the back of this output. End your turn and await the user's
   instruction.

## Reading artifacts you need

- To act on a workflow's result later, read the files under `summary.artifactsDir`
  (`result.json`, `steps/<stepId>.json`) rather than re-deriving them or guessing.
- These files are the authoritative record of what the workflow produced; the relayed
  summary is convenience, not a substitute.

## Exceptions

The relay contract is the default. Depart from it only when the user explicitly
instructs you to continue (e.g. "now build from that plan"). Presenting the outcome
verbatim and awaiting instruction is correct in all other cases.
