# Israeli Bank → Wealthfolio Importer (Engine) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless importer that scrapes Israeli bank and credit-card transactions and pushes them into a self-hosted Wealthfolio, runnable as a Docker container or a reusable GitHub Actions workflow.

**Architecture:** A bun workspace splitting a puppeteer-free `core` (config, mapping, transfer detection, balance anchoring, Wealthfolio client, sinks) from `scraper` (israeli-bank-scrapers + puppeteer), driven by a `cli` that ships as a GHCR image. The sync is stateless: Wealthfolio computes an idempotency key server-side, so every run rescans a trailing window and lets the server discard what it already has.

**Tech Stack:** Bun 1.3.10 (runtime, package manager, test runner), TypeScript, Zod, israeli-bank-scrapers 6.9.0, Biome via ultracite, Docker (multi-arch), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-30-israeli-bank-wealthfolio-importer-design.md`

**Scope:** This plan covers the engine only. The Wealthfolio addon control panel (spec §11) is a second plan; it consumes `packages/core` and nothing here depends on it.

## Refinements to the spec

Two mechanics changed while working out the details. Both are deliberate and supersede the spec text where they conflict:

1. **Balance anchoring needs no valuation endpoint** (spec §8). On an account's first sync Wealthfolio's computed balance is zero, and we know exactly what we are about to import — so the anchor is `scrapedBalance - net(mapped activities)`. This removes the spec's dependency on an unverified valuation API. First-sync detection uses `POST /activities/search` with `pageSize: 1`.

2. **Card payments are declared, not guessed** (spec §6). The spec matched issuer patterns heuristically. Instead the user declares `cardPayments: [{ pattern, wealthfolioAccountId }]`, because in practice the card-side leg usually *does not exist*: Isracard/Max/Cal report the individual purchases, while only the bank reports the monthly חיוב. Pairing therefore synthesizes the counterpart `TRANSFER_IN` on the declared card account when no matching card-side credit is found. Synthesis is only safe because the user declared the target explicitly — this is the difference between correct netting and inventing a transaction.

Spec §16's first open question is resolved: `/activities/link` is called after import, correlating rows by the `lineNumber` we assign before the check pass and read back off the import response.

## Global Constraints

- Bun `1.3.10`; `packageManager: "bun@1.3.10"` in the root manifest.
- Node `22` must also be installed in CI — ultracite/biome resolve `#!/usr/bin/env node`.
- `israeli-bank-scrapers` pinned to `6.9.0`.
- `packages/core` and (later) `apps/addon` MUST NOT import `puppeteer`, `israeli-bank-scrapers`, `packages/scraper`, or any `node:*` builtin. Enforced by a test, not convention (Task 2).
- All amounts sent to Wealthfolio are unsigned magnitudes; direction is carried by the activity type.
- Never emit `DEPOSIT` on a `CREDIT_CARD` account, and never emit a subtype-less `CREDIT` on a `CASH` account. Both are silently ignored by Wealthfolio's spending classifier.
- Credentials must never reach logs, error messages, or run reports.
- `TZ` defaults to `Asia/Jerusalem`.
- Wealthfolio API base path is `/api/v1`.
- Every GitHub Action reference is pinned by commit SHA.
- Conventional Commits for all commit messages.

---

### Task 1: Workspace scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.jsonc`, `.gitignore`, `.node-version`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces: a `bun test` / `bunx ultracite check` / `bunx tsc --noEmit` toolchain, and the `@ibw/core` workspace package other tasks import from.

- [ ] **Step 1: Create the root manifest**

`package.json`:

```json
{
  "name": "israeli-bank-wealthfolio-importer",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.10",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "check": "ultracite check",
    "fix": "ultracite fix",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.6",
    "@types/bun": "^1.3.10",
    "typescript": "^5.9.3",
    "ultracite": "7.2.5"
  }
}
```

- [ ] **Step 2: Create TypeScript and Biome config**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "paths": { "@ibw/core": ["./packages/core/src/index.ts"] },
    "baseUrl": "."
  },
  "include": ["packages/**/*.ts", "apps/**/*.ts"]
}
```

`biome.jsonc`:

```jsonc
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "extends": ["ultracite/core"],
  "files": { "includes": ["**/*", "!**/fixtures/**", "!docs"] }
}
```

`.node-version` containing `22`, and `.gitignore` containing `node_modules`, `dist`, `.env`, `*.local`, `out`.

- [ ] **Step 3: Create the core package**

`packages/core/package.json`:

```json
{
  "name": "@ibw/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^4.1.12" }
}
```

`packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.json", "include": ["src/**/*.ts"] }
```

`packages/core/src/index.ts` containing `export const VERSION = "0.0.0";`

- [ ] **Step 4: Install and verify the toolchain**

Run: `bun install && bunx tsc --noEmit && bun test && bunx ultracite check`
Expected: install succeeds; typecheck passes; `bun test` reports 0 tests (not an error); ultracite passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun workspace with biome, typescript and bun test"
```

---

### Task 2: Core types and the import boundary test

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/boundary.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: Task 1's workspace
- Produces: `ScrapedTransaction`, `ScrapedAccount`, `ActivityImport`, `ActivityType`, `WealthfolioAccountType` — the vocabulary every later task uses.

- [ ] **Step 1: Write the failing boundary test**

This guards the constraint that makes the addon buildable. It scans core's own source rather than trusting convention.

`packages/core/src/boundary.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const FORBIDDEN = [
  /from\s+["']puppeteer["']/,
  /from\s+["']israeli-bank-scrapers/,
  /from\s+["']@ibw\/scraper["']/,
  /from\s+["']node:/,
];

describe("core import boundary", () => {
  test("no source file imports puppeteer, the scraper, or node builtins", async () => {
    const glob = new Glob("**/*.ts");
    const offenders: string[] = [];

    for await (const file of glob.scan({ cwd: import.meta.dir, absolute: true })) {
      if (file.endsWith("boundary.test.ts")) continue;
      const source = await Bun.file(file).text();
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it passes on an empty core**

Run: `bun test packages/core/src/boundary.test.ts`
Expected: PASS (nothing to violate yet). It will start earning its keep the moment someone adds an import.

- [ ] **Step 3: Write the types**

`packages/core/src/types.ts`:

```ts
export type WealthfolioAccountType = "CASH" | "CREDIT_CARD";

export type ActivityType =
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "CREDIT"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

/** Mirrors israeli-bank-scrapers' `Transaction`, restated so core stays free of that dependency. */
export interface ScrapedTransaction {
  type: "normal" | "installments";
  identifier?: string | number;
  date: string;
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: "completed" | "pending";
  installments?: { number: number; total: number };
  category?: string;
}

/** Mirrors israeli-bank-scrapers' `TransactionsAccount`. */
export interface ScrapedAccount {
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  currency?: string;
  txns: ScrapedTransaction[];
}

/** Result of one provider scrape. Declared here so `core` and `scraper` share one definition. */
export type ScrapeOutcome =
  | { ok: true; accounts: ScrapedAccount[] }
  | { ok: false; errorType: string; errorMessage: string };

/** The subset of Wealthfolio's `ActivityImport` this importer writes. */
export interface ActivityImport {
  id?: string;
  accountId: string;
  activityType: ActivityType;
  subtype?: string;
  date: string;
  amount: number;
  currency: string;
  fee: number;
  comment: string;
  isDraft: boolean;
  isValid?: boolean;
  duplicateOfId?: string;
  lineNumber?: number;
}
```

- [ ] **Step 4: Re-export and verify**

Set `packages/core/src/index.ts` to `export * from "./types";` then run:
`bunx tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add domain types and the puppeteer-free import boundary test"
```

---

### Task 3: Mapping rules and activity-type resolution

This is the correctness heart of the project. Wealthfolio's spending classifier *ignores* combinations it does not recognise rather than rejecting them, so a wrong choice here produces no error — just transactions missing from every report.

**Files:**
- Create: `packages/core/src/mapping/rules.ts`
- Create: `packages/core/src/mapping/rules.test.ts`

**Interfaces:**
- Consumes: `ActivityType`, `WealthfolioAccountType` from Task 2
- Produces:
  - `type MappingRule = { pattern: string; activityType: ActivityType; subtype?: string }`
  - `DEFAULT_RULES: MappingRule[]`
  - `directionOf(type: ActivityType, account: WealthfolioAccountType): "inflow" | "outflow" | null`
  - `isTypeValidForAccount(type: ActivityType, account: WealthfolioAccountType, subtype?: string): boolean`
  - `resolveActivityType(description: string, isInflow: boolean, account: WealthfolioAccountType, rules: MappingRule[]): { activityType: ActivityType; subtype?: string }`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/mapping/rules.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RULES,
  directionOf,
  isTypeValidForAccount,
  resolveActivityType,
} from "./rules";

describe("isTypeValidForAccount", () => {
  test("rejects DEPOSIT on a credit card - Wealthfolio silently ignores it", () => {
    expect(isTypeValidForAccount("DEPOSIT", "CREDIT_CARD")).toBe(false);
  });

  test("rejects a subtype-less CREDIT on cash - also silently ignored", () => {
    expect(isTypeValidForAccount("CREDIT", "CASH")).toBe(false);
    expect(isTypeValidForAccount("CREDIT", "CASH", "REFUND")).toBe(true);
  });

  test("accepts a subtype-less CREDIT on a credit card", () => {
    expect(isTypeValidForAccount("CREDIT", "CREDIT_CARD")).toBe(true);
  });
});

describe("directionOf", () => {
  test("INTEREST is income on cash but a charge on a credit card", () => {
    expect(directionOf("INTEREST", "CASH")).toBe("inflow");
    expect(directionOf("INTEREST", "CREDIT_CARD")).toBe("outflow");
  });
});

describe("resolveActivityType", () => {
  test("falls back to sign on an unmatched cash transaction", () => {
    expect(resolveActivityType("סופרמרקט", false, "CASH", [])).toEqual({
      activityType: "WITHDRAWAL",
    });
    expect(resolveActivityType("משכורת", true, "CASH", [])).toEqual({
      activityType: "DEPOSIT",
    });
  });

  test("falls back to CREDIT with a REFUND subtype for a card inflow", () => {
    expect(resolveActivityType("זיכוי", true, "CREDIT_CARD", [])).toEqual({
      activityType: "CREDIT",
      subtype: "REFUND",
    });
  });

  test("applies a matching rule", () => {
    expect(resolveActivityType("עמלת שורה", false, "CASH", DEFAULT_RULES)).toEqual({
      activityType: "FEE",
    });
  });

  test("ignores a rule whose direction contradicts the transaction sign", () => {
    // "ריבית חובה" is a charge, not income. The INTEREST rule is inflow-only on
    // cash, so an outflow must not be typed INTEREST and counted as income.
    const result = resolveActivityType("ריבית חובה", false, "CASH", DEFAULT_RULES);
    expect(result.activityType).not.toBe("INTEREST");
  });

  test("ignores a rule that is invalid for the account type", () => {
    const rules = [{ pattern: "החזר", activityType: "DEPOSIT" as const }];
    expect(resolveActivityType("החזר", true, "CREDIT_CARD", rules)).toEqual({
      activityType: "CREDIT",
      subtype: "REFUND",
    });
  });

  test("user rules take precedence over defaults in order", () => {
    const rules = [
      { pattern: "עמלת", activityType: "TAX" as const },
      ...DEFAULT_RULES,
    ];
    expect(resolveActivityType("עמלת", false, "CASH", rules).activityType).toBe("TAX");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/mapping/rules.test.ts`
Expected: FAIL — cannot resolve `./rules`.

- [ ] **Step 3: Implement**

`packages/core/src/mapping/rules.ts`:

```ts
import type { ActivityType, WealthfolioAccountType } from "../types";

export interface MappingRule {
  /** Case-insensitive substring matched against the transaction description. */
  pattern: string;
  activityType: ActivityType;
  subtype?: string;
}

/**
 * Which activity types move money in or out, per account type. Taken from
 * Wealthfolio's `classify_activity` — on a credit card, INTEREST is a charge
 * rather than income, so direction is not a property of the type alone.
 */
const DIRECTIONS: Record<
  WealthfolioAccountType,
  { inflow: ActivityType[]; outflow: ActivityType[] }
> = {
  CASH: {
    inflow: ["DEPOSIT", "CREDIT", "INTEREST", "TRANSFER_IN"],
    outflow: ["WITHDRAWAL", "FEE", "TAX", "TRANSFER_OUT"],
  },
  CREDIT_CARD: {
    inflow: ["CREDIT", "TRANSFER_IN"],
    outflow: ["WITHDRAWAL", "FEE", "INTEREST", "TRANSFER_OUT"],
  },
};

/** Subtypes that make a CREDIT visible to the spending classifier on a cash account. */
const CASH_CREDIT_SUBTYPES = new Set(["BONUS", "REFUND", "REBATE", "REIMBURSEMENT"]);

export const DEFAULT_RULES: MappingRule[] = [
  { pattern: "ריבית חובה", activityType: "FEE" },
  { pattern: "ריבית", activityType: "INTEREST" },
  { pattern: "עמלת", activityType: "FEE" },
  { pattern: "עמלה", activityType: "FEE" },
  { pattern: "דמי ניהול", activityType: "FEE" },
  { pattern: "דמי כרטיס", activityType: "FEE" },
];

export function directionOf(
  type: ActivityType,
  account: WealthfolioAccountType,
): "inflow" | "outflow" | null {
  const table = DIRECTIONS[account];
  if (table.inflow.includes(type)) return "inflow";
  if (table.outflow.includes(type)) return "outflow";
  return null;
}

export function isTypeValidForAccount(
  type: ActivityType,
  account: WealthfolioAccountType,
  subtype?: string,
): boolean {
  if (directionOf(type, account) === null) return false;
  if (account === "CASH" && type === "CREDIT") {
    return subtype !== undefined && CASH_CREDIT_SUBTYPES.has(subtype);
  }
  return true;
}

export function resolveActivityType(
  description: string,
  isInflow: boolean,
  account: WealthfolioAccountType,
  rules: MappingRule[],
): { activityType: ActivityType; subtype?: string } {
  const wanted = isInflow ? "inflow" : "outflow";
  const haystack = description.toLowerCase();

  for (const rule of rules) {
    if (!haystack.includes(rule.pattern.toLowerCase())) continue;
    if (directionOf(rule.activityType, account) !== wanted) continue;
    if (!isTypeValidForAccount(rule.activityType, account, rule.subtype)) continue;
    return rule.subtype === undefined
      ? { activityType: rule.activityType }
      : { activityType: rule.activityType, subtype: rule.subtype };
  }

  if (account === "CREDIT_CARD") {
    return isInflow
      ? { activityType: "CREDIT", subtype: "REFUND" }
      : { activityType: "WITHDRAWAL" };
  }
  return isInflow ? { activityType: "DEPOSIT" } : { activityType: "WITHDRAWAL" };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/mapping/rules.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): resolve activity types from sign, account type and rules"
```

---

### Task 4: Transaction mapping and comment construction

**Files:**
- Create: `packages/core/src/mapping/comment.ts`, `packages/core/src/mapping/map-transaction.ts`
- Create: `packages/core/src/mapping/map-transaction.test.ts`

**Interfaces:**
- Consumes: Task 3's `resolveActivityType`, `MappingRule`
- Produces:
  - `buildComment(txn: ScrapedTransaction): string`
  - `mapTransaction(txn, ctx: MapContext): ActivityImport | null` where
    `MapContext = { accountId: string; accountType: WealthfolioAccountType; fallbackCurrency: string; rules: MappingRule[] }`
  - Returns `null` for pending transactions.

- [ ] **Step 1: Write the failing tests**

`packages/core/src/mapping/map-transaction.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ScrapedTransaction } from "../types";
import { DEFAULT_RULES } from "./rules";
import { buildComment, mapTransaction } from "./map-transaction";

function txn(over: Partial<ScrapedTransaction> = {}): ScrapedTransaction {
  return {
    type: "normal",
    date: "2026-08-01T00:00:00.000Z",
    processedDate: "2026-08-01T00:00:00.000Z",
    originalAmount: -120.5,
    originalCurrency: "ILS",
    chargedAmount: -120.5,
    chargedCurrency: "ILS",
    description: "שופרסל דיל",
    status: "completed",
    ...over,
  };
}

const cash = {
  accountId: "acc-1",
  accountType: "CASH" as const,
  fallbackCurrency: "ILS",
  rules: DEFAULT_RULES,
};

describe("buildComment", () => {
  test("keeps the Hebrew description intact", () => {
    expect(buildComment(txn())).toBe("שופרסל דיל");
  });

  test("appends memo, installment counter and asmachta", () => {
    const comment = buildComment(
      txn({ memo: "סניף 42", installments: { number: 2, total: 12 }, identifier: 998877 }),
    );
    expect(comment).toBe("שופרסל דיל · סניף 42 · תשלום 2/12 · אסמכתא 998877");
  });

  test("records the original amount when the charge was converted", () => {
    const comment = buildComment(
      txn({ originalAmount: -30, originalCurrency: "USD", chargedCurrency: "ILS" }),
    );
    expect(comment).toBe("שופרסל דיל · 30 USD");
  });
});

describe("mapTransaction", () => {
  test("maps a cash outflow to an unsigned WITHDRAWAL", () => {
    const activity = mapTransaction(txn(), cash);
    expect(activity).toMatchObject({
      accountId: "acc-1",
      activityType: "WITHDRAWAL",
      amount: 120.5,
      currency: "ILS",
      fee: 0,
      isDraft: false,
    });
  });

  test("maps a cash inflow to DEPOSIT", () => {
    expect(mapTransaction(txn({ chargedAmount: 9000, description: "משכורת" }), cash))
      .toMatchObject({ activityType: "DEPOSIT", amount: 9000 });
  });

  test("skips pending transactions", () => {
    expect(mapTransaction(txn({ status: "pending" }), cash)).toBeNull();
  });

  test("skips zero-amount transactions", () => {
    expect(mapTransaction(txn({ chargedAmount: 0 }), cash)).toBeNull();
  });

  test("falls back to the account currency when the charge has none", () => {
    const activity = mapTransaction(txn({ chargedCurrency: undefined }), {
      ...cash,
      fallbackCurrency: "USD",
    });
    expect(activity?.currency).toBe("USD");
  });

  test("maps a card refund to CREDIT, never DEPOSIT", () => {
    const activity = mapTransaction(txn({ chargedAmount: 55, description: "זיכוי" }), {
      ...cash,
      accountType: "CREDIT_CARD",
    });
    expect(activity?.activityType).toBe("CREDIT");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/mapping/map-transaction.test.ts`
Expected: FAIL — cannot resolve `./map-transaction`.

- [ ] **Step 3: Implement**

`packages/core/src/mapping/comment.ts`:

```ts
import type { ScrapedTransaction } from "../types";

/**
 * The comment is the only place the Hebrew merchant string survives, and it is
 * what Wealthfolio's categorization rules match against. The asmachta is
 * appended because it feeds the server's idempotency key, which materially
 * improves dedup stability across reprocessed statements.
 */
export function buildComment(txn: ScrapedTransaction): string {
  const parts: string[] = [txn.description.trim()];

  const memo = txn.memo?.trim();
  if (memo) parts.push(memo);

  const chargedCurrency = txn.chargedCurrency ?? txn.originalCurrency;
  if (txn.originalCurrency !== chargedCurrency) {
    parts.push(`${Math.abs(txn.originalAmount)} ${txn.originalCurrency}`);
  }

  if (txn.installments) {
    parts.push(`תשלום ${txn.installments.number}/${txn.installments.total}`);
  }

  const identifier = txn.identifier === undefined ? "" : String(txn.identifier).trim();
  if (identifier) parts.push(`אסמכתא ${identifier}`);

  return parts.join(" · ");
}
```

`packages/core/src/mapping/map-transaction.ts`:

```ts
import type { ActivityImport, ScrapedTransaction, WealthfolioAccountType } from "../types";
import { buildComment } from "./comment";
import type { MappingRule } from "./rules";
import { resolveActivityType } from "./rules";

export { buildComment };

export interface MapContext {
  accountId: string;
  accountType: WealthfolioAccountType;
  fallbackCurrency: string;
  rules: MappingRule[];
}

export function mapTransaction(
  txn: ScrapedTransaction,
  ctx: MapContext,
): ActivityImport | null {
  // Pending charges frequently post at a different amount, and the server's
  // idempotency key includes the amount — importing both would create two rows
  // rather than update one. The overlap window picks them up once they post.
  if (txn.status === "pending") return null;
  if (txn.chargedAmount === 0) return null;

  const isInflow = txn.chargedAmount > 0;
  const { activityType, subtype } = resolveActivityType(
    txn.description,
    isInflow,
    ctx.accountType,
    ctx.rules,
  );

  return {
    accountId: ctx.accountId,
    activityType,
    ...(subtype === undefined ? {} : { subtype }),
    date: txn.date,
    amount: Math.abs(txn.chargedAmount),
    currency: txn.chargedCurrency ?? ctx.fallbackCurrency,
    fee: 0,
    comment: buildComment(txn),
    isDraft: false,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/mapping/`
Expected: PASS, 17 tests total across both files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): map scraped transactions to Wealthfolio activities"
```

---

### Task 5: Config schema

**Files:**
- Create: `packages/core/src/config/schema.ts`, `packages/core/src/config/schema.test.ts`

**Interfaces:**
- Consumes: `MappingRule` from Task 3
- Produces: `ConfigSchema` (zod), `type Config`, `type ProviderConfig`, `type AccountMapping`, `parseConfig(input: unknown): Config`, `OTP_ONLY_COMPANIES: Set<string>`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/config/schema.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseConfig } from "./schema";

const base = {
  wealthfolio: { url: "http://localhost:8080", password: "pw" },
  providers: [
    {
      id: "bank",
      companyId: "hapoalim",
      credentials: { userCode: "u", password: "p" },
      accounts: { "12-345": { wealthfolioAccountId: "acc-1", type: "CASH" } },
    },
  ],
};

describe("parseConfig", () => {
  test("accepts a minimal config and applies defaults", () => {
    const config = parseConfig(base);
    expect(config.daysBack).toBe(30);
    expect(config.transferWindowDays).toBe(5);
    expect(config.linkTransfers).toBe(true);
  });

  test("rejects hapoalim credentials of the wrong shape, naming the field", () => {
    const bad = { ...base, providers: [{ ...base.providers[0], credentials: { username: "u", password: "p" } }] };
    expect(() => parseConfig(bad)).toThrow(/userCode/);
  });

  test("accepts isracard credentials with card6Digits", () => {
    const config = parseConfig({
      ...base,
      providers: [
        {
          id: "card",
          companyId: "isracard",
          credentials: { id: "1", password: "p", card6Digits: "123456" },
          accounts: { "1234": { wealthfolioAccountId: "acc-2", type: "CREDIT_CARD" } },
        },
      ],
    });
    expect(config.providers[0]?.companyId).toBe("isracard");
  });

  test("rejects an OTP-only provider with a message naming it", () => {
    const otp = {
      ...base,
      providers: [
        {
          id: "oz",
          companyId: "oneZero",
          credentials: { email: "a@b.c", password: "p" },
          accounts: {},
        },
      ],
    };
    expect(() => parseConfig(otp)).toThrow(/oneZero/);
  });

  test("rejects an unknown companyId", () => {
    expect(() => parseConfig({ ...base, providers: [{ ...base.providers[0], companyId: "nope" }] })).toThrow();
  });

  test("parses card payment declarations", () => {
    const config = parseConfig({
      ...base,
      cardPayments: [{ pattern: "ישראכרט", wealthfolioAccountId: "acc-2" }],
    });
    expect(config.cardPayments[0]?.pattern).toBe("ישראכרט");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/config/schema.test.ts`
Expected: FAIL — cannot resolve `./schema`.

- [ ] **Step 3: Implement**

`packages/core/src/config/schema.ts`:

```ts
import { z } from "zod";

/**
 * Providers whose login requires an interactive OTP. They cannot complete in a
 * scheduled run, so they are rejected at parse time with a message naming the
 * provider rather than failing mid-scrape inside a browser.
 */
export const OTP_ONLY_COMPANIES = new Set(["oneZero", "behatsdaa"]);

const userCode = z.object({ userCode: z.string().min(1), password: z.string().min(1) });
const username = z.object({ username: z.string().min(1), password: z.string().min(1) });
const idPassword = z.object({ id: z.string().min(1), password: z.string().min(1) });
const idPasswordNum = idPassword.extend({ num: z.string().min(1) });
const idPasswordCard6 = idPassword.extend({ card6Digits: z.string().min(1) });
const usernameNationalId = z.object({
  username: z.string().min(1),
  nationalID: z.string().min(1),
  password: z.string().min(1),
});

/**
 * israeli-bank-scrapers' `ScraperCredentials` is a union whose member depends on
 * the company. Binding each company to its shape here turns a mid-scrape browser
 * failure into a startup error naming the missing field.
 */
const CREDENTIALS_BY_COMPANY = {
  hapoalim: userCode,
  leumi: username,
  discount: idPasswordNum,
  mercantile: idPasswordNum,
  mizrahi: username,
  otsarHahayal: username,
  union: username,
  beinleumi: username,
  massad: username,
  yahav: usernameNationalId,
  visaCal: username,
  max: username,
  isracard: idPasswordCard6,
  amex: idPasswordCard6,
  behatsdaa: idPassword,
  oneZero: z.object({ email: z.string().email(), password: z.string().min(1) }),
} as const;

export type CompanyId = keyof typeof CREDENTIALS_BY_COMPANY;

const accountMapping = z.object({
  wealthfolioAccountId: z.string().min(1),
  type: z.enum(["CASH", "CREDIT_CARD"]),
});

const mappingRule = z.object({
  pattern: z.string().min(1),
  activityType: z.enum([
    "DEPOSIT", "WITHDRAWAL", "CREDIT", "INTEREST",
    "FEE", "TAX", "TRANSFER_IN", "TRANSFER_OUT",
  ]),
  subtype: z.string().optional(),
});

const provider = z
  .object({
    id: z.string().min(1),
    companyId: z.enum(Object.keys(CREDENTIALS_BY_COMPANY) as [CompanyId, ...CompanyId[]]),
    credentials: z.unknown(),
    accounts: z.record(z.string(), accountMapping).default({}),
  })
  .superRefine((value, ctx) => {
    if (OTP_ONLY_COMPANIES.has(value.companyId)) {
      ctx.addIssue({
        code: "custom",
        message:
          `Provider "${value.companyId}" requires an interactive OTP at login and ` +
          "cannot run unattended. See the support matrix in the README.",
        path: ["companyId"],
      });
      return;
    }
    const result = CREDENTIALS_BY_COMPANY[value.companyId].safeParse(value.credentials);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: `credentials.${issue.path.join(".")}: ${issue.message}`,
          path: ["credentials", ...issue.path],
        });
      }
    }
  });

export const ConfigSchema = z.object({
  wealthfolio: z.object({
    url: z.string().url(),
    password: z.string().min(1),
  }),
  daysBack: z.number().int().positive().default(30),
  linkTransfers: z.boolean().default(true),
  transferWindowDays: z.number().int().nonnegative().default(5),
  rules: z.array(mappingRule).default([]),
  cardPayments: z
    .array(z.object({ pattern: z.string().min(1), wealthfolioAccountId: z.string().min(1) }))
    .default([]),
  providers: z.array(provider).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = Config["providers"][number];
export type AccountMapping = z.infer<typeof accountMapping>;

export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/config/schema.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): validate configuration with per-provider credential shapes"
```

---

### Task 6: Credential redaction

Bank credentials are the most sensitive thing this project touches. Redaction is a layer with a test, not a discipline.

**Files:**
- Create: `packages/core/src/redact.ts`, `packages/core/src/redact.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 5
- Produces: `createRedactor(secrets: string[]): (text: string) => string`, `collectSecrets(config: Config): string[]`

- [ ] **Step 1: Write the failing test**

`packages/core/src/redact.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { collectSecrets, createRedactor } from "./redact";

describe("createRedactor", () => {
  test("replaces every occurrence of every secret", () => {
    const redact = createRedactor(["hunter2", "s3cret"]);
    expect(redact("login hunter2 then s3cret then hunter2")).toBe(
      "login [REDACTED] then [REDACTED] then [REDACTED]",
    );
  });

  test("treats secrets as literals, not patterns", () => {
    const redact = createRedactor(["a.c"]);
    expect(redact("abc a.c")).toBe("abc [REDACTED]");
  });

  test("ignores empty and very short secrets to avoid shredding output", () => {
    const redact = createRedactor(["", "ab"]);
    expect(redact("ab cd")).toBe("ab cd");
  });
});

describe("collectSecrets", () => {
  test("gathers every credential value and the Wealthfolio password", () => {
    const secrets = collectSecrets({
      wealthfolio: { url: "http://x", password: "wf-pass" },
      daysBack: 30,
      linkTransfers: true,
      transferWindowDays: 5,
      rules: [],
      cardPayments: [],
      providers: [
        {
          id: "b",
          companyId: "hapoalim",
          credentials: { userCode: "user-code", password: "bank-pass" },
          accounts: {},
        },
      ],
    } as never);

    expect(secrets).toContain("wf-pass");
    expect(secrets).toContain("bank-pass");
    expect(secrets).toContain("user-code");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/redact.test.ts`
Expected: FAIL — cannot resolve `./redact`.

- [ ] **Step 3: Implement**

`packages/core/src/redact.ts`:

```ts
import type { Config } from "./config/schema";

const PLACEHOLDER = "[REDACTED]";
/** Below this length a "secret" matches too much ordinary text to be worth masking. */
const MIN_SECRET_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(secrets: string[]): (text: string) => string {
  const usable = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH))];
  if (usable.length === 0) return (text) => text;

  // Longest first, so a secret containing another is masked whole.
  usable.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(usable.map(escapeRegExp).join("|"), "g");
  return (text) => text.replace(pattern, PLACEHOLDER);
}

export function collectSecrets(config: Config): string[] {
  const secrets: string[] = [config.wealthfolio.password];
  for (const provider of config.providers) {
    for (const value of Object.values(provider.credentials as Record<string, unknown>)) {
      if (typeof value === "string") secrets.push(value);
    }
  }
  return secrets;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/redact.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): redact credentials from all output"
```

---

### Task 7: Wealthfolio API client

**Files:**
- Create: `packages/core/src/wealthfolio/client.ts`, `packages/core/src/wealthfolio/client.test.ts`

**Interfaces:**
- Consumes: `ActivityImport` from Task 2
- Produces: `class WealthfolioClient` with
  - `constructor(opts: { url: string; password: string; fetch?: typeof fetch })`
  - `health(): Promise<void>`
  - `login(): Promise<void>`
  - `checkImport(activities: ActivityImport[]): Promise<ActivityImport[]>`
  - `import(activities: ActivityImport[]): Promise<ImportResult>` where `ImportResult = { activities: ActivityImport[]; importRunId: string; summary: { total: number; imported: number; skipped: number; duplicates: number } }`
  - `link(activityAId: string, activityBId: string): Promise<void>`
  - `hasActivities(accountId: string): Promise<boolean>`
  - `getSecret(addonId: string, key: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

`packages/core/src/wealthfolio/client.test.ts` — a stub `fetch` records calls, so the test asserts protocol, not a live server:

```ts
import { describe, expect, test } from "bun:test";
import { WealthfolioClient } from "./client";

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const LOGIN_COOKIE = "wf_session=jwt-abc; Path=/; HttpOnly";

function client(handler: (url: string, init?: RequestInit) => Response) {
  const stub = stubFetch(handler);
  return {
    stub,
    api: new WealthfolioClient({ url: "http://wf:8080", password: "pw", fetch: stub.fn }),
  };
}

describe("WealthfolioClient", () => {
  test("logs in and sends the JWT as a bearer token", async () => {
    const { api, stub } = client((url) => {
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true, expiresIn: 3600 }), {
          headers: { "set-cookie": LOGIN_COOKIE },
        });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await api.login();
    await api.checkImport([]);

    const check = stub.calls.at(-1);
    expect(check?.url).toBe("http://wf:8080/api/v1/activities/import/check");
    expect(new Headers(check?.init?.headers).get("authorization")).toBe("Bearer jwt-abc");
  });

  test("posts activities under an `activities` key", async () => {
    const { api, stub } = client((url) => {
      if (url.endsWith("/auth/login")) {
        return new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } });
      }
      return new Response(JSON.stringify({ activities: [], importRunId: "r1", summary: {} }));
    });

    await api.login();
    await api.import([]);
    expect(JSON.parse(String(stub.calls.at(-1)?.init?.body))).toEqual({ activities: [] });
  });

  test("links a pair with camelCase ids", async () => {
    const { api, stub } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : new Response("{}"),
    );

    await api.login();
    await api.link("a1", "b2");
    expect(stub.calls.at(-1)?.url).toBe("http://wf:8080/api/v1/activities/link");
    expect(JSON.parse(String(stub.calls.at(-1)?.init?.body))).toEqual({
      activityAId: "a1",
      activityBId: "b2",
    });
  });

  test("re-authenticates once on a 401 and retries", async () => {
    let served401 = false;
    const { api, stub } = client((url) => {
      if (url.endsWith("/auth/login")) {
        return new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } });
      }
      if (!served401) {
        served401 = true;
        return new Response("nope", { status: 401 });
      }
      return new Response(JSON.stringify([]));
    });

    await api.login();
    await api.checkImport([]);
    expect(stub.calls.filter((c) => c.url.endsWith("/auth/login"))).toHaveLength(2);
  });

  test("throws a message naming the status and endpoint on failure", async () => {
    const { api } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : new Response("boom", { status: 500 }),
    );

    await api.login();
    expect(api.checkImport([])).rejects.toThrow(/500.*activities\/import\/check/s);
  });

  test("reports whether an account already has activities", async () => {
    const { api } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : new Response(JSON.stringify({ data: [{ id: "x" }], total: 1 })),
    );

    await api.login();
    expect(await api.hasActivities("acc-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/wealthfolio/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 3: Implement**

`packages/core/src/wealthfolio/client.ts`:

```ts
import type { ActivityImport } from "../types";

export interface ImportSummary {
  total: number;
  imported: number;
  skipped: number;
  duplicates: number;
}

export interface ImportResult {
  activities: ActivityImport[];
  importRunId: string;
  summary: ImportSummary;
}

export interface WealthfolioClientOptions {
  url: string;
  password: string;
  fetch?: typeof fetch;
}

/**
 * Wealthfolio's Personal Access Tokens authorize `/mcp` only — `/api/v1` is
 * behind `require_jwt`, which accepts the session cookie or an Authorization
 * header. So: log in with the password, lift the JWT out of the Set-Cookie, and
 * present it as a bearer token.
 */
export class WealthfolioClient {
  private readonly base: string;
  private readonly password: string;
  private readonly doFetch: typeof fetch;
  private token: string | null = null;

  constructor(options: WealthfolioClientOptions) {
    this.base = `${options.url.replace(/\/+$/, "")}/api/v1`;
    this.password = options.password;
    this.doFetch = options.fetch ?? fetch;
  }

  async health(): Promise<void> {
    const response = await this.doFetch(`${this.base}/healthz`);
    if (!response.ok) {
      throw new Error(
        `Wealthfolio is not reachable at ${this.base} (healthz returned ${response.status})`,
      );
    }
  }

  async login(): Promise<void> {
    const response = await this.doFetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: this.password }),
    });
    if (!response.ok) {
      throw new Error(`Wealthfolio login failed (${response.status}). Check WEALTHFOLIO_PASSWORD.`);
    }
    const cookie = response.headers.get("set-cookie");
    const token = cookie?.match(/(?:^|[;,\s])wf_session=([^;,\s]+)/)?.[1];
    if (!token) {
      throw new Error("Wealthfolio login succeeded but returned no session cookie");
    }
    this.token = token;
  }

  private async request<T>(path: string, init: RequestInit, retry = true): Promise<T> {
    if (this.token === null) await this.login();

    const response = await this.doFetch(`${this.base}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
        authorization: `Bearer ${this.token}`,
      },
    });

    if (response.status === 401 && retry) {
      this.token = null;
      return this.request<T>(path, init, false);
    }
    if (!response.ok) {
      throw new Error(`Wealthfolio ${path} returned ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  checkImport(activities: ActivityImport[]): Promise<ActivityImport[]> {
    return this.request<ActivityImport[]>("/activities/import/check", {
      method: "POST",
      body: JSON.stringify({ activities }),
    });
  }

  import(activities: ActivityImport[]): Promise<ImportResult> {
    return this.request<ImportResult>("/activities/import", {
      method: "POST",
      body: JSON.stringify({ activities }),
    });
  }

  async link(activityAId: string, activityBId: string): Promise<void> {
    await this.request("/activities/link", {
      method: "POST",
      body: JSON.stringify({ activityAId, activityBId }),
    });
  }

  async hasActivities(accountId: string): Promise<boolean> {
    const page = await this.request<{ data?: unknown[]; total?: number }>("/activities/search", {
      method: "POST",
      body: JSON.stringify({ accountIdFilter: [accountId], page: 1, pageSize: 1 }),
    });
    return (page.total ?? page.data?.length ?? 0) > 0;
  }

  getSecret(addonId: string, key: string): Promise<string | null> {
    const query = new URLSearchParams({ key });
    return this.request<string | null>(
      `/addons/${encodeURIComponent(addonId)}/secrets?${query}`,
      { method: "GET" },
    );
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/wealthfolio/client.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add the Wealthfolio API client with JWT session handling"
```

---

### Task 8: Balance anchoring

**Files:**
- Create: `packages/core/src/anchor/balance-anchor.ts`, `packages/core/src/anchor/balance-anchor.test.ts`

**Interfaces:**
- Consumes: `ActivityImport`, `WealthfolioAccountType`, `directionOf` from Task 3
- Produces: `netEffect(activities: ActivityImport[], accountType: WealthfolioAccountType): number`, `buildAnchor(input: { accountId; accountType; scrapedBalance; balanceDate?; activities }): ActivityImport | null`

- [ ] **Step 1: Write the failing test**

`packages/core/src/anchor/balance-anchor.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { buildAnchor, netEffect } from "./balance-anchor";

function activity(over: Partial<ActivityImport>): ActivityImport {
  return {
    accountId: "acc-1",
    activityType: "WITHDRAWAL",
    date: "2026-08-10T00:00:00.000Z",
    amount: 100,
    currency: "ILS",
    fee: 0,
    comment: "x",
    isDraft: false,
    ...over,
  };
}

describe("netEffect", () => {
  test("nets inflows against outflows", () => {
    const net = netEffect(
      [activity({ activityType: "DEPOSIT", amount: 500 }), activity({ amount: 200 })],
      "CASH",
    );
    expect(net).toBe(300);
  });
});

describe("buildAnchor", () => {
  const activities = [activity({ activityType: "DEPOSIT", amount: 500 }), activity({ amount: 200 })];

  test("emits a DEPOSIT for the shortfall, dated before the earliest activity", () => {
    const anchor = buildAnchor({
      accountId: "acc-1",
      accountType: "CASH",
      scrapedBalance: 1000,
      balanceDate: "2026-08-20",
      activities,
    });
    expect(anchor).toMatchObject({ activityType: "DEPOSIT", amount: 700, currency: "ILS" });
    expect(anchor?.comment).toContain("2026-08-20");
    expect(new Date(anchor?.date ?? 0) < new Date("2026-08-10T00:00:00.000Z")).toBe(true);
  });

  test("emits a WITHDRAWAL when imported activity overshoots the real balance", () => {
    const anchor = buildAnchor({
      accountId: "acc-1",
      accountType: "CASH",
      scrapedBalance: 100,
      activities,
    });
    expect(anchor).toMatchObject({ activityType: "WITHDRAWAL", amount: 200 });
  });

  test("returns null when the balance already matches", () => {
    expect(
      buildAnchor({ accountId: "acc-1", accountType: "CASH", scrapedBalance: 300, activities }),
    ).toBeNull();
  });

  test("returns null when there is nothing to anchor against", () => {
    expect(
      buildAnchor({ accountId: "acc-1", accountType: "CASH", scrapedBalance: 300, activities: [] }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/anchor/balance-anchor.test.ts`
Expected: FAIL — cannot resolve `./balance-anchor`.

- [ ] **Step 3: Implement**

`packages/core/src/anchor/balance-anchor.ts`:

```ts
import { directionOf } from "../mapping/rules";
import type { ActivityImport, WealthfolioAccountType } from "../types";

/** Rounding guard: below this the "drift" is float noise, not a real gap. */
const EPSILON = 0.005;

export function netEffect(
  activities: ActivityImport[],
  accountType: WealthfolioAccountType,
): number {
  return activities.reduce((total, activity) => {
    const direction = directionOf(activity.activityType, accountType);
    if (direction === "inflow") return total + activity.amount;
    if (direction === "outflow") return total - activity.amount;
    return total;
  }, 0);
}

export interface AnchorInput {
  accountId: string;
  accountType: WealthfolioAccountType;
  scrapedBalance: number;
  balanceDate?: string;
  activities: ActivityImport[];
}

/**
 * israeli-bank-scrapers reaches back months at most, so summed transactions never
 * equal the real balance. On an account's FIRST sync Wealthfolio's own balance is
 * zero and we know exactly what we are about to import, so the correction is
 * simply the difference — no valuation lookup needed.
 *
 * Callers must only invoke this on a first sync (see `WealthfolioClient.hasActivities`).
 * Re-anchoring on later runs would fight the transactions and compound drift.
 */
export function buildAnchor(input: AnchorInput): ActivityImport | null {
  const first = input.activities[0];
  if (first === undefined) return null;

  const difference = input.scrapedBalance - netEffect(input.activities, input.accountType);
  if (Math.abs(difference) < EPSILON) return null;

  const earliest = input.activities.reduce(
    (min, activity) => (activity.date < min ? activity.date : min),
    first.date,
  );
  const anchorDate = new Date(new Date(earliest).getTime() - 86_400_000).toISOString();
  const label = input.balanceDate ?? earliest.slice(0, 10);

  return {
    accountId: input.accountId,
    activityType: difference > 0 ? "DEPOSIT" : "WITHDRAWAL",
    date: anchorDate,
    amount: Math.abs(difference),
    currency: first.currency,
    fee: 0,
    comment: `Opening balance anchor — ${label}`,
    isDraft: false,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/anchor/`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): anchor accounts to their real bank balance on first sync"
```

---

### Task 9: Card-payment transfer pairing

Without this, importing a bank account *and* its cards double-counts every shekel — once as card spending, once as the monthly bank debit.

**Files:**
- Create: `packages/core/src/transfers/detect.ts`, `packages/core/src/transfers/detect.test.ts`

**Interfaces:**
- Consumes: `ActivityImport` from Task 2, `Config["cardPayments"]` from Task 5
- Produces:
  - `type AccountBucket = { accountId: string; accountType: WealthfolioAccountType; activities: ActivityImport[] }`
  - `type PairPlan = { out: ActivityImport; in: ActivityImport; synthesized: boolean }`
  - `detectCardPayments(buckets: AccountBucket[], opts: { cardPayments: {pattern,wealthfolioAccountId}[]; windowDays: number }): { pairs: PairPlan[]; unmatched: ActivityImport[] }`
  - Mutates matched activities in place to `TRANSFER_OUT` / `TRANSFER_IN`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/transfers/detect.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { detectCardPayments } from "./detect";

function activity(over: Partial<ActivityImport>): ActivityImport {
  return {
    accountId: "bank",
    activityType: "WITHDRAWAL",
    date: "2026-08-02T00:00:00.000Z",
    amount: 5000,
    currency: "ILS",
    fee: 0,
    comment: "ישראכרט חיוב חודשי",
    isDraft: false,
    ...over,
  };
}

const cardPayments = [{ pattern: "ישראכרט", wealthfolioAccountId: "card" }];

function buckets(bank: ActivityImport[], card: ActivityImport[] = []) {
  return [
    { accountId: "bank", accountType: "CASH" as const, activities: bank },
    { accountId: "card", accountType: "CREDIT_CARD" as const, activities: card },
  ];
}

describe("detectCardPayments", () => {
  test("pairs a bank debit with an existing card-side credit", () => {
    const debit = activity({});
    const credit = activity({
      accountId: "card",
      activityType: "CREDIT",
      subtype: "REFUND",
      date: "2026-08-03T00:00:00.000Z",
      comment: "תשלום",
    });

    const result = detectCardPayments(buckets([debit], [credit]), { cardPayments, windowDays: 5 });

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.synthesized).toBe(false);
    expect(debit.activityType).toBe("TRANSFER_OUT");
    expect(credit.activityType).toBe("TRANSFER_IN");
  });

  test("synthesizes the card-side leg when the card reports only purchases", () => {
    const debit = activity({});
    const result = detectCardPayments(buckets([debit]), { cardPayments, windowDays: 5 });

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]?.synthesized).toBe(true);
    expect(result.pairs[0]?.in).toMatchObject({
      accountId: "card",
      activityType: "TRANSFER_IN",
      amount: 5000,
    });
    expect(debit.activityType).toBe("TRANSFER_OUT");
  });

  test("leaves a debit alone when two card credits could match", () => {
    const debit = activity({});
    const a = activity({ accountId: "card", activityType: "CREDIT", comment: "תשלום א" });
    const b = activity({ accountId: "card", activityType: "CREDIT", comment: "תשלום ב" });

    const result = detectCardPayments(buckets([debit], [a, b]), { cardPayments, windowDays: 5 });

    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched).toContain(debit);
    expect(debit.activityType).toBe("WITHDRAWAL");
  });

  test("does not match outside the date window", () => {
    const debit = activity({});
    const credit = activity({
      accountId: "card",
      activityType: "CREDIT",
      date: "2026-08-20T00:00:00.000Z",
    });

    const result = detectCardPayments(buckets([debit], [credit]), { cardPayments, windowDays: 5 });
    expect(result.pairs[0]?.synthesized).toBe(true);
  });

  test("ignores debits that match no declared pattern", () => {
    const debit = activity({ comment: "סופרמרקט" });
    const result = detectCardPayments(buckets([debit]), { cardPayments, windowDays: 5 });
    expect(result.pairs).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(debit.activityType).toBe("WITHDRAWAL");
  });

  test("does nothing when no card payments are declared", () => {
    const debit = activity({});
    const result = detectCardPayments(buckets([debit]), { cardPayments: [], windowDays: 5 });
    expect(result.pairs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/transfers/detect.test.ts`
Expected: FAIL — cannot resolve `./detect`.

- [ ] **Step 3: Implement**

`packages/core/src/transfers/detect.ts`:

```ts
import type { ActivityImport, WealthfolioAccountType } from "../types";

export interface AccountBucket {
  accountId: string;
  accountType: WealthfolioAccountType;
  activities: ActivityImport[];
}

export interface CardPaymentRule {
  pattern: string;
  wealthfolioAccountId: string;
}

export interface PairPlan {
  out: ActivityImport;
  in: ActivityImport;
  /** True when the card side reported no matching credit and we created the leg. */
  synthesized: boolean;
}

export interface DetectOptions {
  cardPayments: CardPaymentRule[];
  windowDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Wealthfolio nets a transfer only when both legs share a `source_group_id`,
 * which `POST /activities/link` sets. So a card payment must become a linked
 * TRANSFER_OUT / TRANSFER_IN pair, or it is counted as spending twice.
 *
 * Israeli card issuers usually report only the individual purchases, leaving the
 * monthly charge visible on the bank side alone. Synthesizing the counterpart is
 * safe here precisely because the user *declared* the target account in
 * `cardPayments` — we are not guessing which account a debit belongs to.
 */
export function detectCardPayments(
  buckets: AccountBucket[],
  options: DetectOptions,
): { pairs: PairPlan[]; unmatched: ActivityImport[] } {
  const pairs: PairPlan[] = [];
  const unmatched: ActivityImport[] = [];
  if (options.cardPayments.length === 0) return { pairs, unmatched };

  const byId = new Map(buckets.map((bucket) => [bucket.accountId, bucket]));
  const claimed = new Set<ActivityImport>();
  const windowMs = options.windowDays * DAY_MS;

  for (const bucket of buckets) {
    if (bucket.accountType !== "CASH") continue;

    for (const debit of bucket.activities) {
      if (debit.activityType !== "WITHDRAWAL") continue;

      const rule = options.cardPayments.find((candidate) =>
        debit.comment.toLowerCase().includes(candidate.pattern.toLowerCase()),
      );
      if (rule === undefined) continue;

      const card = byId.get(rule.wealthfolioAccountId);
      const debitTime = new Date(debit.date).getTime();

      const candidates = (card?.activities ?? []).filter(
        (candidate) =>
          !claimed.has(candidate) &&
          candidate.activityType === "CREDIT" &&
          candidate.currency === debit.currency &&
          Math.abs(candidate.amount - debit.amount) < 0.005 &&
          Math.abs(new Date(candidate.date).getTime() - debitTime) <= windowMs,
      );

      // Linking the wrong leg is invisible; leaving it unlinked merely shows as
      // an expense the user can see and fix. So ambiguity means hands off.
      if (candidates.length > 1) {
        unmatched.push(debit);
        continue;
      }

      debit.activityType = "TRANSFER_OUT";
      delete debit.subtype;

      const existing = candidates[0];
      if (existing !== undefined) {
        existing.activityType = "TRANSFER_IN";
        delete existing.subtype;
        claimed.add(existing);
        pairs.push({ out: debit, in: existing, synthesized: false });
        continue;
      }

      const created: ActivityImport = {
        accountId: rule.wealthfolioAccountId,
        activityType: "TRANSFER_IN",
        date: debit.date,
        amount: debit.amount,
        currency: debit.currency,
        fee: 0,
        comment: `${debit.comment} · תשלום לכרטיס`,
        isDraft: false,
      };
      card?.activities.push(created);
      claimed.add(created);
      pairs.push({ out: debit, in: created, synthesized: true });
    }
  }

  return { pairs, unmatched };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/transfers/`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): pair card payments as linked transfers to stop double counting"
```

---

### Task 10: Sinks

**Files:**
- Create: `packages/core/src/sinks/types.ts`, `packages/core/src/sinks/api-sink.ts`, `packages/core/src/sinks/csv-sink.ts`
- Create: `packages/core/src/sinks/api-sink.test.ts`, `packages/core/src/sinks/csv-sink.test.ts`

**Interfaces:**
- Consumes: `WealthfolioClient` (Task 7), `PairPlan` (Task 9)
- Produces:
  - `interface Sink { write(activities: ActivityImport[]): Promise<WriteReport>; link(pairs: PairPlan[]): Promise<number> }`
  - `type WriteReport = { imported: number; duplicates: number; skipped: number; ids: Map<number, string> }`
  - `class ApiSink implements Sink`, `class CsvSink implements Sink`
  - `toCsv(activities: ActivityImport[]): string`

- [ ] **Step 1: Write the failing tests**

`packages/core/src/sinks/api-sink.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { ActivityImport } from "../types";
import { ApiSink } from "./api-sink";

function activity(over: Partial<ActivityImport> = {}): ActivityImport {
  return {
    accountId: "acc-1",
    activityType: "WITHDRAWAL",
    date: "2026-08-01T00:00:00.000Z",
    amount: 10,
    currency: "ILS",
    fee: 0,
    comment: "c",
    isDraft: false,
    ...over,
  };
}

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async checkImport(rows: ActivityImport[]) {
        calls.push("check");
        return rows.map((row) => ({ ...row, isValid: true }));
      },
      async import(rows: ActivityImport[]) {
        calls.push("import");
        return {
          activities: rows.map((row) => ({ ...row, id: `id-${row.lineNumber}` })),
          importRunId: "run",
          summary: { total: rows.length, imported: rows.length, skipped: 0, duplicates: 0 },
        };
      },
      async link() {
        calls.push("link");
      },
      ...over,
    } as never,
  };
}

describe("ApiSink", () => {
  test("checks before importing and assigns line numbers", async () => {
    const { client, calls } = fakeClient();
    const sink = new ApiSink(client);
    const report = await sink.write([activity(), activity()]);

    expect(calls).toEqual(["check", "import"]);
    expect(report.imported).toBe(2);
    expect(report.ids.get(0)).toBe("id-0");
  });

  test("drops rows the server flagged as duplicates instead of forcing them", async () => {
    const { client } = fakeClient({
      async checkImport(rows: ActivityImport[]) {
        return rows.map((row, index) => ({
          ...row,
          isValid: true,
          ...(index === 0 ? { duplicateOfId: "existing" } : {}),
        }));
      },
    });
    const sink = new ApiSink(client);
    const report = await sink.write([activity(), activity()]);

    expect(report.duplicates).toBe(1);
    expect(report.imported).toBe(1);
  });

  test("drops invalid rows and counts them as skipped", async () => {
    const { client } = fakeClient({
      async checkImport(rows: ActivityImport[]) {
        return rows.map((row) => ({ ...row, isValid: false }));
      },
    });
    const report = await new ApiSink(client).write([activity()]);
    expect(report.skipped).toBe(1);
    expect(report.imported).toBe(0);
  });

  test("does not call the API at all for an empty batch", async () => {
    const { client, calls } = fakeClient();
    await new ApiSink(client).write([]);
    expect(calls).toEqual([]);
  });
});
```

`packages/core/src/sinks/csv-sink.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { toCsv } from "./csv-sink";

describe("toCsv", () => {
  test("emits Wealthfolio's import columns", () => {
    const csv = toCsv([
      {
        accountId: "a",
        activityType: "WITHDRAWAL",
        date: "2026-08-01T00:00:00.000Z",
        amount: 15.49,
        currency: "ILS",
        fee: 0,
        comment: "שופרסל",
        isDraft: false,
      },
    ]);
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe("date,activityType,amount,currency,fee,comment");
    expect(row).toBe("2026-08-01T00:00:00.000Z,WITHDRAWAL,15.49,ILS,0,שופרסל");
  });

  test("quotes and escapes commas and quotes in the comment", () => {
    const csv = toCsv([
      {
        accountId: "a",
        activityType: "WITHDRAWAL",
        date: "2026-08-01T00:00:00.000Z",
        amount: 1,
        currency: "ILS",
        fee: 0,
        comment: 'a,b "c"',
        isDraft: false,
      },
    ]);
    expect(csv.trim().split("\n")[1]).toContain('"a,b ""c"""');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/core/src/sinks/`
Expected: FAIL — cannot resolve `./api-sink` and `./csv-sink`.

- [ ] **Step 3: Implement**

`packages/core/src/sinks/types.ts`:

```ts
import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";

export interface WriteReport {
  imported: number;
  duplicates: number;
  skipped: number;
  /** lineNumber → Wealthfolio activity id, for linking after import. */
  ids: Map<number, string>;
}

export interface Sink {
  write(activities: ActivityImport[]): Promise<WriteReport>;
  link(pairs: PairPlan[]): Promise<number>;
}

export const EMPTY_REPORT: WriteReport = {
  imported: 0,
  duplicates: 0,
  skipped: 0,
  ids: new Map(),
};
```

`packages/core/src/sinks/api-sink.ts`:

```ts
import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";
import type { WealthfolioClient } from "../wealthfolio/client";
import type { Sink, WriteReport } from "./types";

/**
 * `/activities/import` requires `isValid`/`isDraft`, which only the check pass
 * populates — so both calls are mandatory and ordered. Line numbers are assigned
 * here so the ids coming back off the import can be correlated for linking.
 */
export class ApiSink implements Sink {
  constructor(private readonly client: WealthfolioClient) {}

  async write(activities: ActivityImport[]): Promise<WriteReport> {
    const ids = new Map<number, string>();
    if (activities.length === 0) {
      return { imported: 0, duplicates: 0, skipped: 0, ids };
    }

    const numbered = activities.map((activity, index) => ({ ...activity, lineNumber: index }));
    const checked = await this.client.checkImport(numbered);

    const duplicates = checked.filter((row) => row.duplicateOfId !== undefined).length;
    // A scheduled sync has no business overriding duplicate detection, so
    // `forceImport` stays false and flagged rows are simply dropped.
    const importable = checked.filter(
      (row) => row.duplicateOfId === undefined && row.isValid !== false,
    );
    const skipped = checked.length - duplicates - importable.length;

    if (importable.length === 0) {
      return { imported: 0, duplicates, skipped, ids };
    }

    const result = await this.client.import(importable);
    for (const row of result.activities) {
      if (row.lineNumber !== undefined && row.id !== undefined) ids.set(row.lineNumber, row.id);
    }

    return { imported: result.summary.imported ?? importable.length, duplicates, skipped, ids };
  }

  async link(pairs: PairPlan[]): Promise<number> {
    let linked = 0;
    for (const pair of pairs) {
      const outId = pair.out.id;
      const inId = pair.in.id;
      if (outId === undefined || inId === undefined) continue;
      await this.client.link(outId, inId);
      linked += 1;
    }
    return linked;
  }
}
```

`packages/core/src/sinks/csv-sink.ts`:

```ts
import type { PairPlan } from "../transfers/detect";
import type { ActivityImport } from "../types";
import type { Sink, WriteReport } from "./types";

const HEADER = "date,activityType,amount,currency,fee,comment";

function cell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Wealthfolio's own activity-import columns, matching docs/test-data/credit-card-history.csv. */
export function toCsv(activities: ActivityImport[]): string {
  const rows = activities.map((activity) =>
    [
      activity.date,
      activity.activityType,
      String(activity.amount),
      activity.currency,
      String(activity.fee),
      cell(activity.comment),
    ].join(","),
  );
  return [HEADER, ...rows].join("\n") + "\n";
}

export interface CsvWriter {
  write(fileName: string, contents: string): Promise<void>;
}

/**
 * For desktop users and for --dry-run. There is no server to dedup, so output is
 * documented as "review before importing" rather than presented as safe to apply
 * repeatedly. Linking is not expressible in CSV.
 */
export class CsvSink implements Sink {
  constructor(private readonly writer: CsvWriter) {}

  async write(activities: ActivityImport[]): Promise<WriteReport> {
    const byAccount = new Map<string, ActivityImport[]>();
    for (const activity of activities) {
      const bucket = byAccount.get(activity.accountId) ?? [];
      bucket.push(activity);
      byAccount.set(activity.accountId, bucket);
    }

    for (const [accountId, rows] of byAccount) {
      await this.writer.write(`${accountId}.csv`, toCsv(rows));
    }

    return { imported: activities.length, duplicates: 0, skipped: 0, ids: new Map() };
  }

  async link(_pairs: PairPlan[]): Promise<number> {
    return 0;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/sinks/`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): add API and CSV sinks behind one interface"
```

---

### Task 11: Scraper package

**Files:**
- Create: `packages/scraper/package.json`, `packages/scraper/tsconfig.json`
- Create: `packages/scraper/src/index.ts`, `packages/scraper/src/scrape.ts`, `packages/scraper/src/scrape.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig` (Task 5), `ScrapedAccount` (Task 2)
- Produces: `scrapeProvider(provider: ProviderConfig, opts: { startDate: Date; executablePath?: string; timeoutMs?: number }): Promise<ScrapeOutcome>` where `ScrapeOutcome = { ok: true; accounts: ScrapedAccount[] } | { ok: false; errorType: string; errorMessage: string }`

- [ ] **Step 1: Create the package manifest**

`packages/scraper/package.json`:

```json
{
  "name": "@ibw/scraper",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@ibw/core": "workspace:*",
    "israeli-bank-scrapers": "6.9.0"
  }
}
```

`packages/scraper/tsconfig.json`: `{ "extends": "../../tsconfig.json", "include": ["src/**/*.ts"] }`

Run `bun install`.

- [ ] **Step 2: Write the failing test**

The scraper is never run against a live bank in CI, so the test covers the parts that are ours: option construction and failure translation.

`packages/scraper/src/scrape.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildScraperOptions, toOutcome } from "./scrape";

describe("buildScraperOptions", () => {
  test("never combines installments, so each charge lands on its own date", () => {
    const options = buildScraperOptions(
      { companyId: "isracard" } as never,
      { startDate: new Date("2026-07-01") },
    );
    expect(options.combineInstallments).toBe(false);
  });

  test("runs headless with a sandbox-safe argument set", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
    });
    expect(options.showBrowser).toBe(false);
    expect(options.args).toContain("--no-sandbox");
  });

  test("passes an explicit Chromium path when given", () => {
    const options = buildScraperOptions({ companyId: "hapoalim" } as never, {
      startDate: new Date("2026-07-01"),
      executablePath: "/usr/bin/chromium",
    });
    expect(options.executablePath).toBe("/usr/bin/chromium");
  });
});

describe("toOutcome", () => {
  test("passes accounts through on success", () => {
    const outcome = toOutcome({ success: true, accounts: [{ accountNumber: "1", txns: [] }] });
    expect(outcome).toEqual({ ok: true, accounts: [{ accountNumber: "1", txns: [] }] });
  });

  test("surfaces the scraper's error type and message on failure", () => {
    expect(toOutcome({ success: false, errorType: "invalidPassword", errorMessage: "bad" })).toEqual({
      ok: false,
      errorType: "invalidPassword",
      errorMessage: "bad",
    });
  });

  test("reports a success with no accounts as a failure rather than a silent no-op", () => {
    const outcome = toOutcome({ success: true, accounts: [] });
    expect(outcome.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test packages/scraper/src/scrape.test.ts`
Expected: FAIL — cannot resolve `./scrape`.

- [ ] **Step 4: Implement**

`packages/scraper/src/scrape.ts`:

```ts
import type { ProviderConfig, ScrapedAccount, ScrapeOutcome } from "@ibw/core";
import { createScraper } from "israeli-bank-scrapers";

export type { ScrapeOutcome };

export interface ScrapeOptions {
  startDate: Date;
  executablePath?: string;
  timeoutMs?: number;
}

export function buildScraperOptions(provider: ProviderConfig, options: ScrapeOptions) {
  return {
    companyId: provider.companyId,
    startDate: options.startDate,
    // Each installment is imported on its own charge date, because that is what
    // actually leaves the account that month. Combining would book the whole
    // purchase in month one and misstate every month after.
    combineInstallments: false,
    showBrowser: false,
    verbose: false,
    timeout: options.timeoutMs ?? 120_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  };
}

export function toOutcome(result: {
  success: boolean;
  accounts?: { accountNumber: string; txns: unknown[] }[];
  errorType?: string;
  errorMessage?: string;
}): ScrapeOutcome {
  if (!result.success) {
    return {
      ok: false,
      errorType: result.errorType ?? "unknown",
      errorMessage: result.errorMessage ?? "Scraper reported failure without a message",
    };
  }
  // A "successful" scrape returning nothing means the login silently landed
  // somewhere unexpected. Treating it as success would look like a quiet no-op.
  if (!result.accounts || result.accounts.length === 0) {
    return {
      ok: false,
      errorType: "noAccounts",
      errorMessage: "Scrape succeeded but returned no accounts",
    };
  }
  return { ok: true, accounts: result.accounts as ScrapedAccount[] };
}

export async function scrapeProvider(
  provider: ProviderConfig,
  options: ScrapeOptions,
): Promise<ScrapeOutcome> {
  const scraper = createScraper(buildScraperOptions(provider, options) as never);
  try {
    return toOutcome((await scraper.scrape(provider.credentials as never)) as never);
  } catch (error) {
    return {
      ok: false,
      errorType: "exception",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
```

`packages/scraper/src/index.ts`: `export * from "./scrape";`

- [ ] **Step 5: Run tests and commit**

Run: `bun test packages/scraper/ && bunx tsc --noEmit`
Expected: PASS, 6 tests.

```bash
git add -A
git commit -m "feat(scraper): wrap israeli-bank-scrapers with explicit failure outcomes"
```

---

### Task 12: Config resolution

**Files:**
- Create: `packages/core/src/config/resolve.ts`, `packages/core/src/config/resolve.test.ts`

**Interfaces:**
- Consumes: `parseConfig` (Task 5), `WealthfolioClient.getSecret` (Task 7)
- Produces: `resolveConfig(deps: { env: Record<string, string | undefined>; readFile(path: string): Promise<string>; fetchRemote?(url: string, password: string): Promise<string | null> }): Promise<Config>`
- `ADDON_ID = "israeli-bank-importer"`, `ADDON_CONFIG_KEY = "config"`

- [ ] **Step 1: Write the failing test**

`packages/core/src/config/resolve.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "./resolve";

const raw = JSON.stringify({
  wealthfolio: { url: "http://wf:8080", password: "pw" },
  providers: [
    {
      id: "bank",
      companyId: "hapoalim",
      credentials: { userCode: "u", password: "p" },
      accounts: {},
    },
  ],
});

const noFile = () => Promise.reject(new Error("no file"));

describe("resolveConfig", () => {
  test("reads inline JSON from IBW_CONFIG", async () => {
    const config = await resolveConfig({ env: { IBW_CONFIG: raw }, readFile: noFile });
    expect(config.providers[0]?.id).toBe("bank");
  });

  test("reads IBW_CONFIG_PATH when no inline config is set", async () => {
    const config = await resolveConfig({
      env: { IBW_CONFIG_PATH: "/cfg.json" },
      readFile: (path) => (path === "/cfg.json" ? Promise.resolve(raw) : noFile()),
    });
    expect(config.wealthfolio.url).toBe("http://wf:8080");
  });

  test("env overrides the Wealthfolio block so the Action can pass discrete secrets", async () => {
    const config = await resolveConfig({
      env: { IBW_CONFIG: raw, WEALTHFOLIO_URL: "http://other:9000", WEALTHFOLIO_PASSWORD: "other" },
      readFile: noFile,
    });
    expect(config.wealthfolio).toEqual({ url: "http://other:9000", password: "other" });
  });

  test("falls back to the addon secret store", async () => {
    const config = await resolveConfig({
      env: { WEALTHFOLIO_URL: "http://wf:8080", WEALTHFOLIO_PASSWORD: "pw" },
      readFile: noFile,
      fetchRemote: () => Promise.resolve(raw),
    });
    expect(config.providers[0]?.companyId).toBe("hapoalim");
  });

  test("explains what to set when no source yields a config", async () => {
    expect(resolveConfig({ env: {}, readFile: noFile })).rejects.toThrow(/IBW_CONFIG/);
  });

  test("reports malformed JSON as a config error, not a crash", async () => {
    expect(resolveConfig({ env: { IBW_CONFIG: "{oops" }, readFile: noFile })).rejects.toThrow(
      /could not be parsed/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/config/resolve.test.ts`
Expected: FAIL — cannot resolve `./resolve`.

- [ ] **Step 3: Implement**

`packages/core/src/config/resolve.ts`:

```ts
import type { Config } from "./schema";
import { parseConfig } from "./schema";

export const ADDON_ID = "israeli-bank-importer";
export const ADDON_CONFIG_KEY = "config";

export interface ResolveDeps {
  env: Record<string, string | undefined>;
  readFile(path: string): Promise<string>;
  /** Reads the addon-scoped secret from a running Wealthfolio. */
  fetchRemote?(url: string, password: string): Promise<string | null>;
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Configuration from ${source} could not be parsed as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Env wins over the addon secret store, so a GitHub Actions run is always
 * self-describing and never depends on state inside Wealthfolio.
 */
export async function resolveConfig(deps: ResolveDeps): Promise<Config> {
  const { env } = deps;
  let raw: string | null = null;
  let source = "";

  if (env.IBW_CONFIG) {
    raw = env.IBW_CONFIG;
    source = "IBW_CONFIG";
  } else if (env.IBW_CONFIG_PATH) {
    raw = await deps.readFile(env.IBW_CONFIG_PATH);
    source = `IBW_CONFIG_PATH (${env.IBW_CONFIG_PATH})`;
  } else if (deps.fetchRemote && env.WEALTHFOLIO_URL && env.WEALTHFOLIO_PASSWORD) {
    raw = await deps.fetchRemote(env.WEALTHFOLIO_URL, env.WEALTHFOLIO_PASSWORD);
    source = "the Wealthfolio addon secret store";
  }

  if (raw === null) {
    throw new Error(
      "No configuration found. Set IBW_CONFIG (inline JSON) or IBW_CONFIG_PATH (a file), " +
        "or configure the importer in Wealthfolio and set WEALTHFOLIO_URL and WEALTHFOLIO_PASSWORD.",
    );
  }

  const parsed = parseJson(raw, source) as Record<string, unknown>;
  const overridden =
    env.WEALTHFOLIO_URL && env.WEALTHFOLIO_PASSWORD
      ? { ...parsed, wealthfolio: { url: env.WEALTHFOLIO_URL, password: env.WEALTHFOLIO_PASSWORD } }
      : parsed;

  return parseConfig(overridden);
}
```

- [ ] **Step 4: Run tests and commit**

Run: `bun test packages/core/src/config/`
Expected: PASS, 12 tests across both config files.

```bash
git add -A
git commit -m "feat(core): resolve config from env, file or the addon secret store"
```

---

### Task 13: Sync orchestration

**Files:**
- Create: `packages/core/src/run/sync.ts`, `packages/core/src/run/sync.test.ts`
- Modify: `packages/core/src/index.ts` (export the public surface)

**Interfaces:**
- Consumes: everything from Tasks 3–10, 12
- Produces:
  - `type ScrapeFn = (provider: ProviderConfig, startDate: Date) => Promise<ScrapeOutcome>`
  - `runSync(config: Config, deps: { sink: Sink; scrape: ScrapeFn; hasActivities(accountId: string): Promise<boolean>; now?: () => Date }): Promise<RunReport>`
  - `type RunReport = { startedAt: string; finishedAt: string; providers: ProviderReport[]; totals: { imported; duplicates; skipped; linked }; ok: boolean }`
  - `type ProviderReport = { id: string; ok: boolean; error?: string; accounts: { accountNumber: string; mapped: boolean; imported: number }[] }`

- [ ] **Step 1: Write the failing test**

`packages/core/src/run/sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../config/schema";
import type { Sink } from "../sinks/types";
import { runSync } from "./sync";

function config(over: Record<string, unknown> = {}) {
  return parseConfig({
    wealthfolio: { url: "http://wf:8080", password: "pw" },
    providers: [
      {
        id: "bank",
        companyId: "hapoalim",
        credentials: { userCode: "u", password: "p" },
        accounts: { "12-345": { wealthfolioAccountId: "acc-1", type: "CASH" } },
      },
    ],
    ...over,
  });
}

function recordingSink() {
  const written: unknown[][] = [];
  const sink: Sink = {
    async write(activities) {
      written.push(activities);
      return {
        imported: activities.length,
        duplicates: 0,
        skipped: 0,
        ids: new Map(activities.map((_, index) => [index, `id-${index}`])),
      };
    },
    async link(pairs) {
      return pairs.length;
    },
  };
  return { sink, written };
}

const txn = {
  type: "normal" as const,
  date: "2026-08-10T00:00:00.000Z",
  processedDate: "2026-08-10T00:00:00.000Z",
  originalAmount: -100,
  originalCurrency: "ILS",
  chargedAmount: -100,
  chargedCurrency: "ILS",
  description: "סופר",
  status: "completed" as const,
};

describe("runSync", () => {
  test("maps and writes transactions for a mapped account", async () => {
    const { sink, written } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [{ accountNumber: "12-345", balance: 900, currency: "ILS", txns: [txn] }],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.totals.imported).toBe(1);
    expect(written[0]).toHaveLength(1);
  });

  test("adds a balance anchor only when the account is empty", async () => {
    const { sink, written } = recordingSink();
    await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [{ accountNumber: "12-345", balance: 900, currency: "ILS", txns: [txn] }],
      }),
      hasActivities: async () => false,
    });

    const rows = written[0] as { comment: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.comment.startsWith("Opening balance anchor"))).toBe(true);
  });

  test("reports unmapped accounts without failing the run", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({
        ok: true,
        accounts: [{ accountNumber: "99-999", txns: [txn] }],
      }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.providers[0]?.accounts[0]).toMatchObject({ accountNumber: "99-999", mapped: false });
  });

  test("marks the run failed when a provider fails, and keeps the message", async () => {
    const { sink } = recordingSink();
    const report = await runSync(config(), {
      sink,
      scrape: async () => ({ ok: false, errorType: "invalidPassword", errorMessage: "bad" }),
      hasActivities: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.providers[0]?.error).toContain("invalidPassword");
  });

  test("scrapes from now minus daysBack, not from a stored watermark", async () => {
    const { sink } = recordingSink();
    let seen: Date | null = null;
    await runSync(config({ daysBack: 10 }), {
      sink,
      scrape: async (_provider, startDate) => {
        seen = startDate;
        return { ok: true, accounts: [] };
      },
      hasActivities: async () => true,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(seen?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/core/src/run/sync.test.ts`
Expected: FAIL — cannot resolve `./sync`.

- [ ] **Step 3: Implement**

`packages/core/src/run/sync.ts`:

```ts
import { buildAnchor } from "../anchor/balance-anchor";
import type { Config, ProviderConfig } from "../config/schema";
import { DEFAULT_RULES } from "../mapping/rules";
import { mapTransaction } from "../mapping/map-transaction";
import type { Sink } from "../sinks/types";
import type { AccountBucket } from "../transfers/detect";
import { detectCardPayments } from "../transfers/detect";
import type { ActivityImport, ScrapeOutcome } from "../types";

export type ScrapeFn = (provider: ProviderConfig, startDate: Date) => Promise<ScrapeOutcome>;

export interface AccountReport {
  accountNumber: string;
  mapped: boolean;
  imported: number;
}

export interface ProviderReport {
  id: string;
  ok: boolean;
  error?: string;
  accounts: AccountReport[];
}

export interface RunReport {
  startedAt: string;
  finishedAt: string;
  providers: ProviderReport[];
  totals: { imported: number; duplicates: number; skipped: number; linked: number };
  unmatchedCardPayments: number;
  ok: boolean;
}

export interface SyncDeps {
  sink: Sink;
  scrape: ScrapeFn;
  hasActivities(accountId: string): Promise<boolean>;
  now?: () => Date;
}

const DAY_MS = 86_400_000;

export async function runSync(config: Config, deps: SyncDeps): Promise<RunReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  // Always a trailing window, never a watermark: Israeli card charges post days
  // late with backdated timestamps, and server-side dedup makes rescanning free.
  const startDate = new Date(startedAt.getTime() - config.daysBack * DAY_MS);
  const rules = [...config.rules, ...DEFAULT_RULES];

  const providers: ProviderReport[] = [];
  const buckets = new Map<string, AccountBucket>();
  const firstSync = new Map<string, boolean>();

  for (const provider of config.providers) {
    const outcome = await deps.scrape(provider, startDate);
    if (!outcome.ok) {
      providers.push({
        id: provider.id,
        ok: false,
        error: `${outcome.errorType}: ${outcome.errorMessage}`,
        accounts: [],
      });
      continue;
    }

    const accounts: AccountReport[] = [];
    for (const scraped of outcome.accounts) {
      const mapping = provider.accounts[scraped.accountNumber];
      if (mapping === undefined) {
        accounts.push({ accountNumber: scraped.accountNumber, mapped: false, imported: 0 });
        continue;
      }

      const context = {
        accountId: mapping.wealthfolioAccountId,
        accountType: mapping.type,
        fallbackCurrency: scraped.currency ?? "ILS",
        rules,
      };
      const activities = scraped.txns
        .map((txn) => mapTransaction(txn, context))
        .filter((activity): activity is ActivityImport => activity !== null);

      const bucket = buckets.get(mapping.wealthfolioAccountId) ?? {
        accountId: mapping.wealthfolioAccountId,
        accountType: mapping.type,
        activities: [],
      };
      bucket.activities.push(...activities);
      buckets.set(mapping.wealthfolioAccountId, bucket);

      if (!firstSync.has(mapping.wealthfolioAccountId)) {
        firstSync.set(
          mapping.wealthfolioAccountId,
          !(await deps.hasActivities(mapping.wealthfolioAccountId)),
        );
      }

      if (scraped.balance !== undefined && firstSync.get(mapping.wealthfolioAccountId)) {
        const anchor = buildAnchor({
          accountId: mapping.wealthfolioAccountId,
          accountType: mapping.type,
          scrapedBalance: scraped.balance,
          ...(scraped.balanceDate === undefined ? {} : { balanceDate: scraped.balanceDate }),
          activities,
        });
        if (anchor !== null) bucket.activities.push(anchor);
      }

      accounts.push({
        accountNumber: scraped.accountNumber,
        mapped: true,
        imported: activities.length,
      });
    }

    providers.push({ id: provider.id, ok: true, accounts });
  }

  const bucketList = [...buckets.values()];
  const detection = config.linkTransfers
    ? detectCardPayments(bucketList, {
        cardPayments: config.cardPayments,
        windowDays: config.transferWindowDays,
      })
    : { pairs: [], unmatched: [] };

  const all = bucketList.flatMap((bucket) => bucket.activities);
  const report = await deps.sink.write(all);

  for (const [index, activity] of all.entries()) {
    const id = report.ids.get(index);
    if (id !== undefined) activity.id = id;
  }
  const linked = await deps.sink.link(detection.pairs);

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: now().toISOString(),
    providers,
    totals: {
      imported: report.imported,
      duplicates: report.duplicates,
      skipped: report.skipped,
      linked,
    },
    unmatchedCardPayments: detection.unmatched.length,
    ok: providers.every((provider) => provider.ok),
  };
}
```

- [ ] **Step 4: Export the public surface**

`packages/core/src/index.ts`:

```ts
export * from "./anchor/balance-anchor";
export * from "./config/resolve";
export * from "./config/schema";
export * from "./mapping/map-transaction";
export * from "./mapping/rules";
export * from "./redact";
export * from "./run/sync";
export * from "./sinks/api-sink";
export * from "./sinks/csv-sink";
export * from "./sinks/types";
export * from "./transfers/detect";
export * from "./types";
export * from "./wealthfolio/client";
```

- [ ] **Step 5: Run everything and commit**

Run: `bun test && bunx tsc --noEmit && bunx ultracite check`
Expected: PASS. The boundary test from Task 2 must still pass — core still imports no puppeteer.

```bash
git add -A
git commit -m "feat(core): orchestrate scrape, map, anchor, pair and write into one run"
```

---

### Task 14: CLI

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`
- Create: `apps/cli/src/index.ts`, `apps/cli/src/summary.ts`, `apps/cli/src/summary.test.ts`

**Interfaces:**
- Consumes: `runSync`, `resolveConfig`, `ApiSink`, `CsvSink`, `WealthfolioClient`, `collectSecrets`, `createRedactor` from `@ibw/core`; `scrapeProvider` from `@ibw/scraper`
- Produces: an executable entrypoint accepting `sync` (default) and `daemon`, plus `renderSummary(report: RunReport): string`

- [ ] **Step 1: Create the package manifest**

`apps/cli/package.json`:

```json
{
  "name": "@ibw/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "ibw": "./src/index.ts" },
  "dependencies": {
    "@ibw/core": "workspace:*",
    "@ibw/scraper": "workspace:*"
  }
}
```

`apps/cli/tsconfig.json`: `{ "extends": "../../tsconfig.json", "include": ["src/**/*.ts"] }`

Run `bun install`.

- [ ] **Step 2: Write the failing summary test**

`apps/cli/src/summary.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { renderSummary } from "./summary";

const report = {
  startedAt: "2026-08-30T00:00:00.000Z",
  finishedAt: "2026-08-30T00:02:00.000Z",
  providers: [
    { id: "bank", ok: true, accounts: [{ accountNumber: "12-345", mapped: true, imported: 12 }] },
    { id: "card", ok: false, error: "invalidPassword: bad", accounts: [] },
  ],
  totals: { imported: 12, duplicates: 3, skipped: 0, linked: 1 },
  unmatchedCardPayments: 0,
  ok: false,
};

describe("renderSummary", () => {
  test("renders a markdown table of totals", () => {
    const output = renderSummary(report);
    expect(output).toContain("| bank | ok | 12 |");
    expect(output).toContain("Imported 12");
  });

  test("names the failing provider and its error", () => {
    expect(renderSummary(report)).toContain("invalidPassword: bad");
  });

  test("flags unmapped accounts so they do not go unnoticed", () => {
    const output = renderSummary({
      ...report,
      providers: [
        { id: "bank", ok: true, accounts: [{ accountNumber: "99", mapped: false, imported: 0 }] },
      ],
    });
    expect(output).toContain("99");
    expect(output).toContain("unmapped");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test apps/cli/src/summary.test.ts`
Expected: FAIL — cannot resolve `./summary`.

- [ ] **Step 4: Implement the summary**

`apps/cli/src/summary.ts`:

```ts
import type { RunReport } from "@ibw/core";

export function renderSummary(report: RunReport): string {
  const lines: string[] = ["## Wealthfolio import", "", "| Provider | Status | Imported |", "| --- | --- | --- |"];

  for (const provider of report.providers) {
    const imported = provider.accounts.reduce((total, account) => total + account.imported, 0);
    lines.push(`| ${provider.id} | ${provider.ok ? "ok" : "failed"} | ${imported} |`);
  }

  lines.push(
    "",
    `Imported ${report.totals.imported}, ${report.totals.duplicates} duplicates skipped, ` +
      `${report.totals.linked} transfers linked.`,
  );

  const unmapped = report.providers.flatMap((provider) =>
    provider.accounts.filter((account) => !account.mapped).map((account) => account.accountNumber),
  );
  if (unmapped.length > 0) {
    lines.push("", `⚠️ Scraped but unmapped (nothing imported): ${unmapped.join(", ")}`);
  }

  if (report.unmatchedCardPayments > 0) {
    lines.push(
      "",
      `⚠️ ${report.unmatchedCardPayments} possible card payment(s) had an ambiguous counterpart ` +
        "and were left unlinked.",
    );
  }

  for (const provider of report.providers) {
    if (!provider.ok) lines.push("", `❌ ${provider.id}: ${provider.error}`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 5: Run the test**

Run: `bun test apps/cli/src/summary.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Implement the entrypoint**

`apps/cli/src/index.ts`:

```ts
#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ApiSink,
  CsvSink,
  collectSecrets,
  createRedactor,
  resolveConfig,
  runSync,
  WealthfolioClient,
} from "@ibw/core";
import { scrapeProvider } from "@ibw/scraper";
import { renderSummary } from "./summary";

const DAY_MS = 86_400_000;

async function sync(): Promise<number> {
  const config = await resolveConfig({
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    fetchRemote: async (url, password) => {
      const client = new WealthfolioClient({ url, password });
      return client.getSecret("israeli-bank-importer", "config");
    },
  });

  const redact = createRedactor(collectSecrets(config));
  const dryRun = process.env.IBW_DRY_RUN === "true";
  const outDir = process.env.IBW_OUT_DIR ?? "./out";

  const client = new WealthfolioClient(config.wealthfolio);
  let sink: ApiSink | CsvSink;

  if (dryRun) {
    await mkdir(outDir, { recursive: true });
    sink = new CsvSink({
      write: (fileName, contents) => writeFile(join(outDir, fileName), contents, "utf8"),
    });
  } else {
    await client.health();
    await client.login();
    sink = new ApiSink(client);
  }

  const report = await runSync(config, {
    sink,
    scrape: (provider, startDate) =>
      scrapeProvider(provider, {
        startDate,
        ...(process.env.PUPPETEER_EXECUTABLE_PATH === undefined
          ? {}
          : { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }),
      }),
    hasActivities: (accountId) => (dryRun ? Promise.resolve(true) : client.hasActivities(accountId)),
  });

  const summary = redact(renderSummary(report));
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
  }

  // A non-zero exit is what turns a broken scraper into a GitHub failure
  // notification, which is why Telegram can wait for v1.1.
  return report.ok ? 0 : 1;
}

async function daemon(): Promise<number> {
  const intervalHours = Number(process.env.IBW_INTERVAL_HOURS ?? "12");
  for (;;) {
    try {
      await sync();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, (intervalHours * DAY_MS) / 24));
  }
}

const command = process.argv[2] ?? "sync";

try {
  process.exitCode = command === "daemon" ? await daemon() : await sync();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
```

- [ ] **Step 7: Verify the CLI fails cleanly with no config**

Run: `bun run apps/cli/src/index.ts sync; echo "exit=$?"`
Expected: prints the "No configuration found. Set IBW_CONFIG…" message and `exit=1`. No stack trace.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): add the sync and daemon entrypoints with a run summary"
```

---

### Task 15: Docker image

**Files:**
- Create: `Dockerfile`, `.dockerignore`

**Interfaces:**
- Consumes: the CLI from Task 14
- Produces: an image whose entrypoint is `bun apps/cli/src/index.ts`, with Chromium at `PUPPETEER_EXECUTABLE_PATH`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM oven/bun:1.3.10-debian

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jerusalem \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium is installed at build time so no scheduled run pays a browser download.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji fonts-noto-hebrew \
      ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/scraper/package.json packages/scraper/
COPY apps/cli/package.json apps/cli/
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps apps
COPY tsconfig.json ./

# Bank credentials pass through this process; it has no reason to be root.
RUN useradd --create-home --shell /usr/sbin/nologin importer \
 && chown -R importer:importer /app
USER importer

ENTRYPOINT ["bun", "apps/cli/src/index.ts"]
CMD ["sync"]
```

`.dockerignore`:

```
node_modules
**/node_modules
.git
docs
out
*.md
.github
```

- [ ] **Step 2: Build the image**

Run: `docker build -t ibw:dev .`
Expected: build succeeds.

- [ ] **Step 3: Verify the entrypoint and the Hebrew font stack**

Run: `docker run --rm ibw:dev sync; echo "exit=$?"`
Expected: the "No configuration found…" message and `exit=1` — proving the CLI runs inside the image.

Run: `docker run --rm --entrypoint chromium ibw:dev --version`
Expected: a Chromium version string.

- [ ] **Step 4: Record the image size**

Run: `docker image ls ibw:dev --format '{{.Size}}'`
Expected: a number. Spec §16 flags that if this exceeds roughly 1 GB, evaluate `israeli-bank-scrapers-core` against a system Chromium. Note the result in the commit message.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "build: package the importer as a Docker image with Chromium baked in"
```

---

### Task 16: Repository CI

**Files:**
- Create: `.github/workflows/node-ci.yml`, `.github/workflows/docker-build.yml`, `.github/workflows/pull-request.yml`, `.github/workflows/push.yml`
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: the `check` / `typecheck` / `test` scripts from Task 1 and the Dockerfile from Task 15
- Produces: `node-ci.yml` and `docker-build.yml` as `workflow_call` targets

- [ ] **Step 1: Write the reusable CI workflow**

`.github/workflows/node-ci.yml`:

```yaml
name: node-ci

on:
  workflow_call:

jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5

      # Bun runs the scripts, but ultracite/biome resolve `#!/usr/bin/env node`,
      # so a real node must be on PATH.
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10

      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('bun.lock') }}
          restore-keys: ${{ runner.os }}-bun-

      - run: bun install --frozen-lockfile
      - name: Lint
        run: bunx ultracite check
      - name: Typecheck
        run: bunx tsc --noEmit
      - name: Test
        run: bun test
```

- [ ] **Step 2: Write the reusable Docker workflow**

`.github/workflows/docker-build.yml`:

```yaml
name: docker-build

on:
  workflow_call:
    inputs:
      push:
        type: boolean
        default: false
      tags:
        type: string
        default: ""

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v5
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3

      - if: inputs.push
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          # PRs validate amd64 only; publishing builds both, since emulated
          # arm64 builds are slow enough to hurt PR feedback.
          platforms: ${{ inputs.push && 'linux/amd64,linux/arm64' || 'linux/amd64' }}
          push: ${{ inputs.push }}
          tags: ${{ inputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 3: Write the event workflows**

`.github/workflows/pull-request.yml`:

```yaml
name: pull-request

on:
  pull_request:
    branches: [main]

concurrency:
  group: pr-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  ci:
    uses: ./.github/workflows/node-ci.yml
  docker:
    uses: ./.github/workflows/docker-build.yml
    with:
      push: false
```

`.github/workflows/push.yml`:

```yaml
name: push

on:
  push:
    branches: [main]

concurrency:
  group: push-${{ github.ref }}
  cancel-in-progress: false

jobs:
  ci:
    uses: ./.github/workflows/node-ci.yml
  docker:
    needs: ci
    uses: ./.github/workflows/docker-build.yml
    permissions:
      contents: read
      packages: write
    with:
      push: true
      tags: ghcr.io/${{ github.repository }}:main
```

- [ ] **Step 4: Add dependabot**

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

- [ ] **Step 5: Pin every action by SHA**

For each `uses:` above, resolve the tag to a commit SHA and rewrite as
`owner/repo@<sha> # vX.Y.Z`. Resolve with:

```bash
gh api repos/actions/checkout/git/ref/tags/v5 --jq .object.sha
```

Repeat for `actions/setup-node`, `oven-sh/setup-bun`, `actions/cache`,
`docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/login-action`,
`docker/build-push-action`.

- [ ] **Step 6: Validate the workflows parse**

Run: `for f in .github/workflows/*.yml; do bun -e "import {parse} from 'yaml'; parse(await Bun.file('$f').text()); console.log('ok $f')"; done`
(Add `yaml` as a root dev dependency first: `bun add -d yaml`.)
Expected: `ok` for each file.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "ci: add lint, typecheck, test and multi-arch docker workflows"
```

---

### Task 17: Consumer-facing Action, reusable workflow and release

**Files:**
- Create: `action.yml`, `.github/workflows/import.yml`, `.github/workflows/release.yml`
- Create: `examples/sync.yml`

**Interfaces:**
- Consumes: the published image from Task 16
- Produces: the public contract — `uses: omer9564/israeli-bank-wealthfolio-importer@v1` and `uses: …/.github/workflows/import.yml@v1`

- [ ] **Step 1: Write the Docker action**

`action.yml`:

```yaml
name: Israeli Bank → Wealthfolio Importer
description: Scrape Israeli bank and credit-card transactions into a self-hosted Wealthfolio.
branding:
  icon: download
  color: blue

inputs:
  days-back:
    description: How many days of history to rescan each run.
    required: false
    default: "30"
  dry-run:
    description: Write CSVs to out/ instead of pushing to Wealthfolio.
    required: false
    default: "false"

runs:
  using: docker
  image: docker://ghcr.io/omer9564/israeli-bank-wealthfolio-importer:v1
  args: ["sync"]
  env:
    IBW_DAYS_BACK: ${{ inputs.days-back }}
    IBW_DRY_RUN: ${{ inputs.dry-run }}
```

- [ ] **Step 2: Write the reusable workflow**

`.github/workflows/import.yml`:

```yaml
name: import

on:
  workflow_call:
    inputs:
      days-back:
        type: string
        default: "30"
      dry-run:
        type: boolean
        default: false
    secrets:
      IBW_CONFIG:
        required: true
      WEALTHFOLIO_URL:
        required: false
      WEALTHFOLIO_PASSWORD:
        required: false

jobs:
  sync:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: omer9564/israeli-bank-wealthfolio-importer@v1
        with:
          days-back: ${{ inputs.days-back }}
          dry-run: ${{ inputs.dry-run }}
        env:
          IBW_CONFIG: ${{ secrets.IBW_CONFIG }}
          WEALTHFOLIO_URL: ${{ secrets.WEALTHFOLIO_URL }}
          WEALTHFOLIO_PASSWORD: ${{ secrets.WEALTHFOLIO_PASSWORD }}

      - if: failure() && inputs.dry-run
        uses: actions/upload-artifact@v4
        with:
          name: wealthfolio-csv
          path: out/
```

- [ ] **Step 3: Write the release workflow**

`.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags: ["v*.*.*"]

jobs:
  ci:
    uses: ./.github/workflows/node-ci.yml

  publish:
    needs: ci
    uses: ./.github/workflows/docker-build.yml
    permissions:
      contents: read
      packages: write
    with:
      push: true
      tags: |
        ghcr.io/${{ github.repository }}:${{ github.ref_name }}
        ghcr.io/${{ github.repository }}:latest

  move-major-tag:
    needs: publish
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5
      # `@v1` consumers track this tag, so it must move only after the image
      # it points at is actually published.
      - name: Move the major tag
        run: |
          MAJOR="${GITHUB_REF_NAME%%.*}"
          git tag -f "$MAJOR"
          git push origin -f "$MAJOR"
```

- [ ] **Step 4: Write the consumer example**

`examples/sync.yml` — the file a user copies into their own repository:

```yaml
name: wealthfolio-sync

on:
  schedule:
    - cron: "5 4,16 * * *" # 07:05 and 19:05 Israel time
  workflow_dispatch:

jobs:
  sync:
    uses: omer9564/israeli-bank-wealthfolio-importer/.github/workflows/import.yml@v1
    with:
      days-back: "30"
    secrets:
      IBW_CONFIG: ${{ secrets.IBW_CONFIG }}
      WEALTHFOLIO_URL: ${{ secrets.WEALTHFOLIO_URL }}
      WEALTHFOLIO_PASSWORD: ${{ secrets.WEALTHFOLIO_PASSWORD }}
```

- [ ] **Step 5: Wire `IBW_DAYS_BACK` through config resolution**

The action passes `IBW_DAYS_BACK`, so `resolveConfig` must honour it. In
`packages/core/src/config/resolve.ts`, before `parseConfig`, apply:

```ts
const withDaysBack =
  env.IBW_DAYS_BACK === undefined
    ? overridden
    : { ...overridden, daysBack: Number(env.IBW_DAYS_BACK) };
return parseConfig(withDaysBack);
```

Add a test to `resolve.test.ts`:

```ts
test("honours IBW_DAYS_BACK from the action input", async () => {
  const config = await resolveConfig({
    env: { IBW_CONFIG: raw, IBW_DAYS_BACK: "7" },
    readFile: noFile,
  });
  expect(config.daysBack).toBe(7);
});
```

Run: `bun test packages/core/src/config/resolve.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Validate and commit**

Run: `bun test && bunx tsc --noEmit && bunx ultracite check`
Expected: PASS.

```bash
git add -A
git commit -m "feat: publish the composite action, reusable workflow and release pipeline"
```

---

### Task 18: Documentation and open-source hygiene

**Files:**
- Create: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE`
- Create: `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/provider_request.yml`
- Create: `config.example.jsonc`

**Interfaces:**
- Consumes: everything
- Produces: the public documentation surface

- [ ] **Step 1: Write `config.example.jsonc`**

A fully worked example: one bank provider, one card provider, an account map for
each, one `cardPayments` declaration linking them, and a custom rule. Every field
commented with what it does and where to find the value.

- [ ] **Step 2: Write the README**

Required sections, in this order:

1. **What it does** — one paragraph, plus a sentence naming Wealthfolio and israeli-bank-scrapers.
2. **The companion is mandatory** — above the fold. State plainly that a Wealthfolio addon cannot drive a headless browser, so scraping always happens in the container or the Action. Without this, users install the addon and wait for a sync that can never happen.
3. **Quickstart (GitHub Actions)** — fork-free: create `IBW_CONFIG`, `WEALTHFOLIO_URL`, `WEALTHFOLIO_PASSWORD` secrets, copy `examples/sync.yml`, done.
4. **Quickstart (Docker)** — a `compose.yml` with `IBW_CONFIG_PATH`, `TZ=Asia/Jerusalem`, `restart: unless-stopped`, and `daemon`.
5. **Configuration reference** — every field from the zod schema, with the credential shape required per provider.
6. **Provider support matrix** — a table of all 16 supported companies plus the two OTP-only ones marked unsupported, with a link to the tracking issue.
7. **How transactions map** — reproduce the §5.3 table from the spec, and explain why `DEPOSIT` on a credit card and subtype-less `CREDIT` on cash are never emitted.
8. **Card payments and double counting** — why `cardPayments` exists and what happens without it.
9. **Balance anchoring** — what the one-time anchor row is and why it appears.
10. **Security** — link to `SECURITY.md`, and state the GitHub-hosted-runner tradeoff in plain terms.
11. **Limitations** — pending transactions, OTP providers, no investment holdings.

- [ ] **Step 3: Write `SECURITY.md`**

Must cover: what a run can access; that GitHub-hosted runners hold plaintext
credentials in memory during a run and self-hosted runners or the Docker daemon
avoid that; that failure screenshots are off by default because they can capture
a logged-in bank session; that credentials are redacted from logs; and a
disclosure contact.

- [ ] **Step 4: Add MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`**

`CONTRIBUTING.md` covers: `bun install`, `bun test`, `bunx ultracite check`,
Conventional Commits, and — importantly — that new providers need a fixture-based
mapping test rather than a live credential.

- [ ] **Step 5: Add the GitHub templates**

`CODEOWNERS` assigning `@omer9564`. A bug report form with fields for provider,
Wealthfolio version, and redacted logs. A provider request form.

- [ ] **Step 6: Verify no secret leaked into the docs**

Run: `grep -rniE '(userCode|password|card6Digits)"\s*:\s*"[^"<]' README.md config.example.jsonc docs/ || echo "clean"`
Expected: `clean`, or only obvious placeholders such as `"<your-password>"`.

- [ ] **Step 7: Final full verification**

Run: `bun install --frozen-lockfile && bunx ultracite check && bunx tsc --noEmit && bun test && docker build -t ibw:dev .`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: document setup, provider support, mapping and the security tradeoff"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
| --- | --- |
| §2 companion mandatory | 18 (README §2) |
| §3 package split + boundary | 1, 2, 11, 14 |
| §4.1 JWT auth | 7 |
| §4.2 two-phase import | 7, 10 |
| §4.3 stateless dedup | 10, 13 |
| §5.1–5.4 mapping | 3, 4 |
| §5.5 pending skipped | 4 |
| §5.6 installments | 4, 11 |
| §6 transfer pairs | 9 |
| §7 config + resolution | 5, 12 |
| §8 overlap window, anchoring | 8, 13 |
| §9 sinks | 10 |
| §10 image, action, workflow | 15, 16, 17 |
| §12 OTP rejection | 5 |
| §13 testing | every task |
| §14 security | 6, 15, 18 |
| §15 repo CI | 16, 17, 18 |

Two gaps found and closed: `IBW_DAYS_BACK` was passed by the action with nothing
reading it (fixed in Task 17 Step 5), and spec §12's `Notifier` seam is not
built — the CLI's exit code plus `$GITHUB_STEP_SUMMARY` (Task 14) covers the
failure-visibility requirement for v1, and the seam is deferred with Telegram
rather than shipped unused. That is a deliberate YAGNI call, recorded here.

**2. Placeholder scan** — no TBD/TODO; every code step carries real code. Task 18
specifies documents by required content rather than full prose, which is
appropriate for prose deliverables.

**3. Type consistency** — `ScrapeOutcome` was declared twice (Task 11 and Task
13) and both were re-exported from `@ibw/core`, which is a duplicate-export
conflict. Resolved: it is defined once in `packages/core/src/types.ts`, and both
`run/sync.ts` and `@ibw/scraper` import it. `RunReport`, `WriteReport`, `Sink`,
`PairPlan`, `AccountBucket`, `MappingRule`, `MapContext` and `Config` are each
declared once and referenced consistently.
