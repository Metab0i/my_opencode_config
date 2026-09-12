# Planning

## Clarify
Scale question quantity to breadth of impact, design complexity, security
concerns, and ambiguity. Cover:
- Scope: what changes; what must NOT change; affected areas.
- Behavior: current vs desired; backward-compat; state/data to preserve.
- Design: preferred patterns; constraints; allowed/forbidden dependencies.
- Security: auth/authz, validation, secrets, injection, data exposure — and handling.
- Testing: 
  - What needs to be tested, 
  - Surface potential edge-cases, 
  - Surface (potential) contradictions.
- Ambiguity: surface to, and clarify with, user anything that can be interpreted in many ways to avoid ambiguity.

## Boundaries
Read or request documentation for the tooling, API, language, and systems
involved before planning.

## Principles
- Implementation goes in contextually fitting parts of the codebase; group files
  and in-file logic by purpose and behavioral identity.
- Prefer the smallest targeted change
- Prefer existing source(s) of truth instead of inventing new ones or in parallel to existing ones
- Introduce something new only if reuse provably fails without regression
- Before proposing new structure, verify it's necessity by investigating:
  - current flow boundaries
  - candidate extension points
- Prioritise minimal extension of existing logic
- Check whether existing functionality qualifies for reuse or abstract for reuse. 
- Avoid complexity and intricacy, unless completely unavoidable:
  - In relationships
  - In proposed changes
  - In wording
  - In design
  - In systematic changes
