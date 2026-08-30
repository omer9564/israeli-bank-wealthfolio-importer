import { describe, expect, test } from "bun:test";
import { WealthfolioClient } from "./client";

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

const LOGIN_COOKIE = "wf_session=jwt-abc; Path=/; HttpOnly";
const IMPORT_CHECK_FAILURE_PATTERN = /500.*activities\/import\/check/s;

function client(handler: (url: string, init?: RequestInit) => Response) {
  const stub = stubFetch(handler);
  return {
    stub,
    api: new WealthfolioClient({
      url: "http://wf:8080",
      password: "pw",
      fetch: stub.fn,
    }),
  };
}

describe("WealthfolioClient", () => {
  test("logs in and sends the JWT as a bearer token", async () => {
    const { api, stub } = client((url) => {
      if (url.endsWith("/auth/login")) {
        return new Response(
          JSON.stringify({ authenticated: true, expiresIn: 3600 }),
          {
            headers: { "set-cookie": LOGIN_COOKIE },
          }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await api.login();
    await api.checkImport([]);

    const check = stub.calls.at(-1);
    expect(check?.url).toBe("http://wf:8080/api/v1/activities/import/check");
    expect(new Headers(check?.init?.headers).get("authorization")).toBe(
      "Bearer jwt-abc"
    );
  });

  test("posts activities under an `activities` key", async () => {
    const { api, stub } = client((url) => {
      if (url.endsWith("/auth/login")) {
        return new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } });
      }
      return Response.json({ activities: [], importRunId: "r1", summary: {} });
    });

    await api.login();
    await api.import([]);
    expect(JSON.parse(String(stub.calls.at(-1)?.init?.body))).toEqual({
      activities: [],
    });
  });

  test("links a pair with camelCase ids", async () => {
    const { api, stub } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : new Response("{}")
    );

    await api.login();
    await api.link("a1", "b2");
    expect(stub.calls.at(-1)?.url).toBe(
      "http://wf:8080/api/v1/activities/link"
    );
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
      return Response.json([]);
    });

    await api.login();
    await api.checkImport([]);
    expect(
      stub.calls.filter((c) => c.url.endsWith("/auth/login"))
    ).toHaveLength(2);
  });

  test("throws a message naming the status and endpoint on failure", async () => {
    const { api } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : new Response("boom", { status: 500 })
    );

    await api.login();
    expect(api.checkImport([])).rejects.toThrow(IMPORT_CHECK_FAILURE_PATTERN);
  });

  test("reports whether an account already has activities", async () => {
    const { api } = client((url) =>
      url.endsWith("/auth/login")
        ? new Response("{}", { headers: { "set-cookie": LOGIN_COOKIE } })
        : Response.json({ data: [{ id: "x" }], total: 1 })
    );

    await api.login();
    expect(await api.hasActivities("acc-1")).toBe(true);
  });
});
