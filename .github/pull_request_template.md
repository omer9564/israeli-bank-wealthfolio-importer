## What does this change do, and why?

<!-- One or two sentences. Link an issue if there is one. -->

## How was this verified?

<!--
Paste the actual output (or a summary of it) for whichever of these apply:
  bun test
  bunx ultracite check
  bunx tsc --noEmit
  docker build -t ibw:dev .
-->

## Checklist

- [ ] `bun test` passes
- [ ] `bunx ultracite check` passes
- [ ] `bunx tsc --noEmit` passes
- [ ] If this adds or changes a provider: a fixture-based test was added
      (`schema.test.ts` and/or `map-transaction.test.ts` /
      `rules.test.ts`) — **no live bank credential was used**
- [ ] If this changes mapping (`packages/core/src/mapping`, `rules.ts`,
      `map-transaction.ts`): the change is covered by a table-driven test,
      and I checked it against the mapping table in the README, since
      Wealthfolio's classifier silently ignores anything not on that list
- [ ] Commit messages follow [Conventional
      Commits](https://www.conventionalcommits.org/)
- [ ] No credential, account number, or real transaction description was
      committed anywhere (fixtures, docs, or otherwise)
