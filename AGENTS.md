# AGENTS

Core fundamentals. Read and follow before acting. This file is fed to every prompt,
so be concise and deliberate.

## Answer concisely
- Give short, direct, complete answers. No filler, no preamble, no unsolicited tangents.
- Answer the question actually asked; don't over-explain or pad.

## Reuse first
- Prefer the smallest targeted change to an existing source of truth or extension
  point over introducing something new.
- Introduce something new only if reuse provably fails without regression. Preserve
  current behavior unless a change is explicitly approved.

## Keep it simple
- Fewest steps and least added structure that don't introduce vagueness.
- No abstraction you don't need; don't extract something used in one place.
- Check whether something already does the job before building a duplicate.

## Fail clearly
- Throw on invalid, unexpected, or unhandled outcomes.
- Fail fast on non-negotiable conditions; say what is wrong and why.
- Recover gracefully only when recovery can't hide a real bug.

## Be deliberate with your words and tools
- Answer the question actually asked; prefer precision to volume.

## Subject-matter guidance
For task-specific rules (e.g. how to handle code, plans, reviews, tests), read the
relevant instruction file. These live under ~/.config/opencode/instructions/.

## Clean up after yourself
- Remove debugging/intel-gathering artifacts once the task is satisfied.
- If spinning, stop and consult the user.
