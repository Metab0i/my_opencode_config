# Software Production Principles

Read and follow before acting.

## Reuse-first
- Prefer small, targeted adjustments to existing sources of truth and extension
  points over new logic, mappings, or state models.
- Introduce something new only if reuse provably fails without regression. Preserve
  current behavior unless a change is explicitly approved.
- Any new structure requires a reuse audit: what was evaluated, why it's
  insufficient, what would regress if reused, why the new thing is the smallest safe change.
- A plan introducing a parallel source of truth without this audit is incomplete.

## Simplicity
- Fewest steps and least data that don't add vagueness or obfuscation.
- No excessive abstraction; don't extract something used in only one place.
- Reuse existing functionality over reimplementing it.
- Check whether planned functionality already exists to avoid duplicate/redundant computation.
- Place code in contextually fitting parts of the codebase.

## Plan template
1. Requirements — the clarified ask.
2. Impact Areas — exact files/functions to change.
3. Reuse Audit — per Reuse-first.
4. Design — decisions and rejected alternatives.
5. Security — concerns and how they're handled.
6. Test Plan — what to test, including proposed edge cases.

## Error handling
- Throw on arguments outside the expected boundaries.
- Throw on an invalid, unexpected, or unhandled step outcome.
- Fail fast on non-negotiable conditions; say what is wrong and why.
- Recover gracefully only when recovery can't hide a latent bug.

## Comments
- Comment functions: purpose, arguments, returns, and what they throw / when.
- Comment modules with a usage overview at the top.

## Cleanup
- Remove debugging/intel-gathering code once the task is satisfied.

## Feedback
- Check in before running the system or tests you introduced.
- Run headlessly where possible. When investigating, maximize your own feedback:
  verbose/strict flags + stderr and exit codes; temporary logging around the failure;
  a minimal reproduction; if headless isn't possible, say what you'd run and what you expect.
- If spinning, stop and consult the user.

## Scope rule (review)
- If `git diff --name-only` works, list changed files not declared in the plan's
  Impact Areas, and declared areas left untouched. Degrade gracefully with no repo.
