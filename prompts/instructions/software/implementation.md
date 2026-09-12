# Implementation

## Discovery 
- Discover and consult documentation of APIs, flags, or/and tooling before using them
- Never guess syntax or behavior

## Commenting
Comment concisely, communicating purpose:
- Functions: purpose, arguments, return value, what they throw and when.
- Modules: usage overview at the very top of the file.

## Verification
- No syntax errors or warnings.
- Try to run the code and tests you introduced; run headlessly where possible
  and maximize feedback when investigating.
- Before running the full system or non-trivial test runs, check in with the user.
- Remove debugging and intel-gathering code once the task is fulfilled.

## Error handling
- Throw on arguments outside strict expected boundaries.
- Throw when a step's outcome is invalid, unexpected, or unhandled.
- Fail fast on non-negotiable conditions; state explicitly what is wrong and why.
- Recover gracefully only when recovery cannot hide a real bug.

## Reuse & extend by default
- Reuse and extend existing sources of truth; no parallel logic, mappings, or
  state models unless explicitly justified.
- Before adding a new source of truth, record a reuse audit in implementation
  notes.
- Preserve existing behavior unless a scoped behavioral change is explicitly
  approved in the plan. Unapproved drift or a duplicate source-of-truth is a
  blocking issue.

## Security
- Never write secrets into files, logs, or commits.
