## Summary

<!-- One or two sentences: what does this PR do and why? Link the issue: Closes #123 -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Refactor, docs, tests or CI only (no behavior change)

## How was this tested?

<!-- Commands you ran, scenarios you checked in the UI, fixtures or databases used.
     New behavior needs new tests; bug fixes need a regression test. -->

## Checklist

- [ ] `pnpm lint` and `pnpm format:check` pass
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes (integration tests need `DATABASE_URL_TEST`)
- [ ] `pnpm coverage` still meets the enforced thresholds (server ≥ 80% lines)
- [ ] New/changed behavior is covered by tests
- [ ] API changes: `pnpm openapi` re-run and `docs/api.md` updated
- [ ] New environment variables documented in `.env.example` and `docs/configuration.md`
- [ ] UI changes: checked in light and dark mode, keyboard-accessible, screenshots attached
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]` (user-visible changes)
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)

## Screenshots / recordings

<!-- Required for UI changes. Drag images in here. -->

## Notes for reviewers

<!-- Design decisions, trade-offs, anything that needs extra attention. -->
