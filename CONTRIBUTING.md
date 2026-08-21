# Contributing

Thanks for taking a look. This is a small project, so the workflow is light.

## Getting set up

```bash
git clone https://github.com/creative-softworks/sql-switch.git
cd sql-switch
pnpm install
```

Package manager is pnpm (10.26.1). Node >=22 (18 and 20 are past EOL), the dev runtime is Node 24.

## The gates

Before you claim a change works, run these:

```bash
pnpm test        # Vitest over test/ (Postgres files skip themselves without DATABASE_URL)
pnpm typecheck   # tsc --noEmit on src/ + scripts
pnpm smoke       # end to end check against real SQLite files, always runnable
```

And when you have a throwaway Postgres to point at:

```bash
DATABASE_URL=postgres://... pnpm swap-test
```

`swap-test` is the engine swap integration test => it **creates & drops** a
`swaptest` schema, so only aim it at a database where that's safe (a local
throwaway, not anything you care about).

There's no linter wired up yet. The gates above are what CI enforces.

## Docs

```bash
pnpm docs         # TypeDoc HTML into docs/
pnpm docs:serve   # serve them on :3000
```

TypeDoc must stay at zero warnings. `@internal` symbols are excluded from the
docs, so don't `{@link}` one from a public comment.

## Pull requests

- Keep the public API surface deliberate. The public API is only what
  `src/database/index.ts` re-exports (that's what the package.json exports map
  points at). Widening it should be an intentional choice, not a side effect =>
  call it out in the PR if you do.
- Keep changes focused, and make sure the gates pass.

## Code style

The house conventions (comment mechanics, variable naming, tone) live in
`CLAUDE.md`. Have a skim before writing comments so yours match what's already
there rather than restating them here.
