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

/** The rejection reason, as an Error, so a message can be asserted on. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as Error;
  }
  throw new Error("expected the promise to reject");
}

const IBW_CONFIG_MENTIONED = /IBW_CONFIG/;
const NOT_VALID_JSON = /is not valid JSON/i;
const IBW_CONFIG_SET_BUT_EMPTY = /IBW_CONFIG is set but empty/;
const IBW_CONFIG_PATH_SET_BUT_EMPTY = /IBW_CONFIG_PATH is set but empty/;
const PASSWORD_REQUIRED = /WEALTHFOLIO_PASSWORD is not/;
const URL_REQUIRED = /WEALTHFOLIO_URL is not/;

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
    ).rejects.toThrow(NOT_VALID_JSON);
  });

  test("never echoes the JSON parser's message, which quotes the bad token", async () => {
    // Forgetting the quotes around a password while hand-editing IBW_CONFIG
    // makes JavaScriptCore report `Unexpected identifier "<the password>"`.
    // That message escapes redaction structurally — the redactor is built from
    // the parsed config, and this error exists because it did not parse.
    const leaky = '{"wealthfolio":{"password": hunter2SuperSecret}}';
    const error = await rejectionOf(
      resolveConfig({ env: { IBW_CONFIG: leaky }, readFile: noFile })
    );

    expect(error.message).not.toContain("hunter2SuperSecret");
    expect(error.message).toMatch(NOT_VALID_JSON);
  });

  test("reports an unreadable config file without quoting the underlying error", async () => {
    const error = await rejectionOf(
      resolveConfig({
        env: { IBW_CONFIG_PATH: "/nope.json" },
        readFile: () =>
          Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })),
      })
    );

    expect(error.message).toContain("IBW_CONFIG_PATH");
    expect(error.message).toContain("ENOENT");
  });

  test("accepts an already-parsed object from the addon secret store", async () => {
    // `WealthfolioClient.request` JSON-parses the response, so parsing it a
    // second time here would only work if the endpoint returned a JSON string
    // literal — an object would break the whole addon-secret path.
    const config = await resolveConfig({
      env: { WEALTHFOLIO_URL: "http://wf:8080", WEALTHFOLIO_PASSWORD: "pw" },
      readFile: noFile,
      fetchRemote: () => Promise.resolve(JSON.parse(raw) as unknown),
    });
    expect(config.providers[0]?.companyId).toBe("hapoalim");
  });

  test("rejects IBW_CONFIG set but empty instead of silently falling through", async () => {
    await expect(
      resolveConfig({
        env: { IBW_CONFIG: "", IBW_CONFIG_PATH: "/cfg.json" },
        readFile: (path) =>
          path === "/cfg.json" ? Promise.resolve(raw) : noFile(),
      })
    ).rejects.toThrow(IBW_CONFIG_SET_BUT_EMPTY);
  });

  test("rejects IBW_CONFIG_PATH set but empty instead of silently falling through", async () => {
    await expect(
      resolveConfig({
        env: {
          IBW_CONFIG_PATH: "",
          WEALTHFOLIO_URL: "u",
          WEALTHFOLIO_PASSWORD: "p",
        },
        readFile: noFile,
        fetchRemote: () => Promise.resolve(raw),
      })
    ).rejects.toThrow(IBW_CONFIG_PATH_SET_BUT_EMPTY);
  });

  test("rejects WEALTHFOLIO_URL set without WEALTHFOLIO_PASSWORD instead of silently discarding it", async () => {
    await expect(
      resolveConfig({
        env: { IBW_CONFIG: raw, WEALTHFOLIO_URL: "http://other:9000" },
        readFile: noFile,
      })
    ).rejects.toThrow(PASSWORD_REQUIRED);
  });

  test("rejects WEALTHFOLIO_PASSWORD set without WEALTHFOLIO_URL instead of silently discarding it", async () => {
    await expect(
      resolveConfig({
        env: { IBW_CONFIG: raw, WEALTHFOLIO_PASSWORD: "other" },
        readFile: noFile,
      })
    ).rejects.toThrow(URL_REQUIRED);
  });

  test("honours IBW_DAYS_BACK from the action input", async () => {
    const config = await resolveConfig({
      env: { IBW_CONFIG: raw, IBW_DAYS_BACK: "7" },
      readFile: noFile,
    });
    expect(config.daysBack).toBe(7);
  });
});
