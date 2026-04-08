# diagrams-api.ts follows the standard factory pattern

## Decision

~~Inline the diagrams TRPC procedure logic directly in `app-router.ts`.~~

**Reversed.** Use the same `createDiagramsApi()` factory pattern as the other `*-api.ts` files. The `CreateDiagramsApiDependencies` interface starts empty but will grow.

## Rationale for reversal

The code-viz client (`src/diagram/code-viz-client.ts`) is a real dependency — it's a stateless HTTP client today, but as diagram features grow (e.g., broadcasting, worktree-aware paths, extension lifecycle), injected deps will be needed. Setting up the DI plumbing now avoids a refactor later.

Consistency with the existing pattern also reduces cognitive load when navigating the codebase.

## What this means

- `diagramsApi` field on `RuntimeTrpcContext` with 4 methods.
- `createDiagramsApi({})` called in `runtime-server.ts` context creation.
- `src/trpc/diagrams-api.ts` owns all domain logic.
- `src/diagram/code-viz-client.ts` is imported by `diagrams-api.ts`.
- Router procedures delegate to `ctx.diagramsApi.*`.
