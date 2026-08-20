## Summary

<!-- What does this change do, and why? Keep it focused. -->

## Related issue

<!-- e.g. Closes #123, or "none" -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior or the public API)
- [ ] Documentation only
- [ ] Refactor / internal (no behavior change)
- [ ] Build, CI, or tooling

## How it was tested

<!-- Describe how you verified the change. The gates are: -->

```bash
pnpm test        # Vitest over test/ (Postgres files skip themselves without DATABASE_URL)
pnpm typecheck   # tsc --noEmit on src/ + scripts
pnpm smoke       # end to end check against real SQLite files, always runnable
```

And, when you have a throwaway Postgres to point at:

```bash
DATABASE_URL=postgres://... pnpm swap-test   # creates & drops a swaptest schema
```

## Checklist

- [ ] Tests added or updated for the change
- [ ] Docs / TSDoc updated where relevant
- [ ] TypeDoc still builds at zero warnings (`pnpm docs`)
- [ ] Public API surface (`src/database/index.ts`) changes are intentional and called out above
- [ ] Follows the conventions in `CLAUDE.md` (comment mechanics, variable naming, tone)
