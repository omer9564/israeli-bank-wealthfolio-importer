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

const IBW_CONFIG_MENTIONED = /IBW_CONFIG/;
const COULD_NOT_BE_PARSED = /could not be parsed/i;

describe("resolveConfig", () => {
  test("reads inline JSON from IBW_CONFIG", async () => {
    const config = await resolveConfig({
      env: { IBW_CONFIG: raw },
      readFile: noFile,
    });
    expect(config.providers[0]?.id).toBe("bank");
  });

  test("reads IBW_CONFIG_PATH when no inline config is set", async () => {
    const config = await resolveConfig({
      env: { IBW_CONFIG_PATH: "/cfg.json" },
      readFile: (path) =>
        path === "/cfg.json" ? Promise.resolve(raw) : noFile(),
    });
    expect(config.wealthfolio.url).toBe("http://wf:8080");
  });

  test("env overrides the Wealthfolio block so the Action can pass discrete secrets", async () => {
    const config = await resolveConfig({
      env: {
        IBW_CONFIG: raw,
        WEALTHFOLIO_URL: "http://other:9000",
        WEALTHFOLIO_PASSWORD: "other",
      },
      readFile: noFile,
    });
    expect(config.wealthfolio).toEqual({
      url: "http://other:9000",
      password: "other",
    });
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
    await expect(resolveConfig({ env: {}, readFile: noFile })).rejects.toThrow(
      IBW_CONFIG_MENTIONED
    );
  });

  test("reports malformed JSON as a config error, not a crash", async () => {
    await expect(
      resolveConfig({ env: { IBW_CONFIG: "{oops" }, readFile: noFile })
    ).rejects.toThrow(COULD_NOT_BE_PARSED);
  });
});
