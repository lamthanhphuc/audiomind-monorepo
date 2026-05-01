---
description: "Use when: editing React/TypeScript frontend code, feature flags, hooks, and FE tests in FE-Audiomind."
name: "TypeScript React Guidelines"
applyTo:
  - FE-Audiomind/src/**/*.ts
  - FE-Audiomind/src/**/*.tsx
  - FE-Audiomind/tests/**/*.ts
  - FE-Audiomind/tests/**/*.tsx
---
# TypeScript / React Guidelines

## React Hooks Rules
- Call hooks only at top-level of React function components or custom hooks.
- Do not call hooks inside loops, conditions, or nested functions.
- Keep hook dependency arrays explicit and stable.
- Prefer custom hooks for reusable side-effect logic.

## Component Rules
- Use functional components with TypeScript prop interfaces/types.
- Keep presentational and data-fetching concerns separated when possible.
- Avoid overly large components; split into focused subcomponents.
- Prefer explicit prop typing over `any`.

## Testing Rules
- Use Vitest as default FE test runner.
- Prefer React Testing Library patterns for user-visible behavior.
- Test feature-flag branches (enabled and disabled states) when changing flag-driven behavior.
- Keep tests deterministic: avoid network dependency in unit tests.

## Styling Rules
- Preserve existing project styling conventions.
- Do not introduce a new styling framework unless explicitly requested.
- Keep class names and component structure readable and maintainable.

## Realtime Feature Flag Rules
- Realtime behavior must be guarded by `VITE_REALTIME_WS_ENABLED`.
- Always keep polling fallback path functional when realtime is disabled.
- Document any new realtime env vars in `FE-Audiomind/README.md`.

## Validation Before Finish
- Run `cd FE-Audiomind && npm run test` for FE test updates.
- Run `cd FE-Audiomind && npm run build` for non-trivial FE changes.
