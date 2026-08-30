import { z } from "zod";

/**
 * Providers whose login requires an interactive OTP. They cannot complete in a
 * scheduled run, so they are rejected at parse time with a message naming the
 * provider rather than failing mid-scrape inside a browser.
 */
export const OTP_ONLY_COMPANIES = new Set(["oneZero", "behatsdaa"]);

const userCode = z.object({
  userCode: z.string().min(1),
  password: z.string().min(1),
});
const username = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
const idPassword = z.object({
  id: z.string().min(1),
  password: z.string().min(1),
});
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
  pagi: username,
  yahav: usernameNationalId,
  visaCal: username,
  max: username,
  isracard: idPasswordCard6,
  amex: idPasswordCard6,
  behatsdaa: idPassword,
  beyahadBishvilha: idPassword,
  oneZero: z.object({ email: z.email(), password: z.string().min(1) }),
} as const;

export type CompanyId = keyof typeof CREDENTIALS_BY_COMPANY;

const accountMapping = z.object({
  wealthfolioAccountId: z.string().min(1),
  type: z.enum(["CASH", "CREDIT_CARD"]),
});

const mappingRule = z.object({
  pattern: z.string().min(1),
  activityType: z.enum([
    "DEPOSIT",
    "WITHDRAWAL",
    "CREDIT",
    "INTEREST",
    "FEE",
    "TAX",
    "TRANSFER_IN",
    "TRANSFER_OUT",
  ]),
  subtype: z.string().optional(),
});

const provider = z
  .object({
    id: z.string().min(1),
    companyId: z.enum(
      Object.keys(CREDENTIALS_BY_COMPANY) as [CompanyId, ...CompanyId[]]
    ),
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
    const result = CREDENTIALS_BY_COMPANY[value.companyId].safeParse(
      value.credentials
    );
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

export const ConfigSchema = z
  .object({
    wealthfolio: z.object({
      url: z.url(),
      password: z.string().min(1),
    }),
    daysBack: z.number().int().positive().default(30),
    linkTransfers: z.boolean().default(true),
    transferWindowDays: z.number().int().nonnegative().default(5),
    rules: z.array(mappingRule).default([]),
    cardPayments: z
      .array(
        z.object({
          pattern: z.string().min(1),
          wealthfolioAccountId: z.string().min(1),
        })
      )
      .default([]),
    providers: z.array(provider).min(1),
  })
  .superRefine((value, ctx) => {
    // A cardPayments entry naming an account that is declared nowhere can only
    // ever fail at run time, and it fails as "could not be paired" — which
    // reads as a matching problem and sends the user looking for card credits
    // that do not exist. It is a typo, so it belongs in config validation.
    const declared = new Set(
      value.providers.flatMap((entry) =>
        Object.values(entry.accounts).map(
          (account) => account.wealthfolioAccountId
        )
      )
    );
    for (const [index, rule] of value.cardPayments.entries()) {
      if (!declared.has(rule.wealthfolioAccountId)) {
        ctx.addIssue({
          code: "custom",
          message:
            `"${rule.wealthfolioAccountId}" is not declared under any provider's ` +
            "accounts. Every cardPayments target must be an account this " +
            "configuration also imports into.",
          path: ["cardPayments", index, "wealthfolioAccountId"],
        });
      }
    }
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
