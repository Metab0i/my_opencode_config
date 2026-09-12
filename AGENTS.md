# AGENTS

## Answer concisely
- Give short, direct, complete answers. No filler, no preamble, no unsolicited tangents.
- Answer the question actually asked; don't over-explain or pad.

## Structure your output
- When listing, use nested, hierarchical lists:
  - Group related items under a parent item.
  - Prefer depth over long flat enumerations.
- Use tables where categorical information needs to be represented:
  - Columns capture the categories; one row per item.
- Structurally capture relationships between contents:
  - Nesting for containment/subordination.
  - Tables for multi-attribute comparison.
  - Ordering for sequence/priority.
  - Never encode relationships in prose.
- Keep prose for narrative flow only (justifications, explanations), not for enumerable or comparative content.
- These rules apply when the output format is otherwise unconstrained; an explicit stricter format contract (e.g. an agent mandated to respond only in JSON) takes precedence.

## Prioritize simplicity
- Fewest steps to accomplish a goal, without losing substance or clarity.
- Least data and structure needed — no surplus fields, sections, or artifacts.
- No excessive abstraction — don't extract what's used in one place.
- Extend existing logic over adding parallel structure.
- Extract and reuse existing logic across the codebase when possible.

## Be deliberate with your words and tools

## Substantiate claims
- Any claim, postulate, assertion, clarification, definition - or any equivalent to aforementioned categories - must be backed by evidence; avoid answering from memory.
