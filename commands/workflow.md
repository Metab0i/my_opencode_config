---
description: Run a declarative workflow (JSON under ~/.config/opencode/workflow/)
agent: workflow
---

Run the named workflow on the following request:

$ARGUMENTS

If the request is empty, ask the user which workflow to run and what the input should be.

Run it exactly like this (substitute the two quoted arguments):

    node ~/.config/opencode/workflows/src/workflow-run.mjs --workflow WORKFLOW_NAME --request "$ARGUMENTS" --auto --stream

Where WORKFLOW_NAME is the workflow to run (e.g. `plan-critic`), or if the user named it
inline, use that name.

When the runner finishes it prints a terminal JSON outcome block (`status: "complete"`).
That is the workflow's deliverable. Relay it to the user verbatim and take no further action:

1. Summarize the important outcome in a few sentences (verdicts, issues found, plan text).
2. Tell the user the artifact directory (`summary.artifactsDir`) so they can read the results.
3. Do not plan, build, review, or run anything off the back of this output. Stop and await
   the user's instruction.
