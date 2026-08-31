import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  JIRA_ERROR_CODE,
  createJiraClient,
} from "../src/jira/client.js";

describe("Jira HTTP client", () => {
  it("gets and validates JSON through a safe Jira URL", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: "10001" }),
    );
    const client = createJiraClient({
      fetch,
      getJiraUrl: () => "https://jira.example.test/jira/",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    const result = await client.getJson({
      pathname: "rest/api/2/issue/OMS-1",
      query: { fields: "summary,status", expand: undefined },
      schema: z.object({ id: z.string() }),
    });

    expect(result).toEqual({ id: "10001" });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/issue/OMS-1?fields=summary%2Cstatus",
      ),
      {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer secret-token",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    [400, JIRA_ERROR_CODE.BAD_REQUEST, "Jira rejected the request."],
    [401, JIRA_ERROR_CODE.AUTH_ERROR, "Jira authentication failed."],
    [403, JIRA_ERROR_CODE.ACCESS_DENIED, "Jira access was denied."],
    [408, JIRA_ERROR_CODE.NETWORK_TIMEOUT, "Jira request timed out."],
    [429, JIRA_ERROR_CODE.RATE_LIMITED, "Jira rate limit was exceeded."],
    [500, JIRA_ERROR_CODE.JIRA_UNAVAILABLE, "Jira is unavailable."],
  ])("maps HTTP %i to a safe %s error", async (status, code, message) => {
    const client = createJiraClient({
      fetch: async () => new Response("private Jira details", { status }),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code,
      httpStatus: status,
      message: JSON.stringify({ code, message, httpStatus: status }),
    });
  });

  it("uses the caller's safe code for a not-found response", async () => {
    const client = createJiraClient({
      fetch: async () => new Response("private Jira details", { status: 404 }),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({
        pathname: "rest/api/2/issue/OMS-404",
        schema: z.unknown(),
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      httpStatus: 404,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
        message: "Jira issue was not found.",
        httpStatus: 404,
      }),
    });
  });

  it.each([
    [new Response("not-json", { status: 200 }), z.unknown()],
    [Response.json({ id: 10001 }), z.object({ id: z.string() })],
  ])("hides invalid Jira response details", async (response, schema) => {
    const client = createJiraClient({
      fetch: async () => response,
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
      httpStatus: 200,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
        message: "Jira returned an unexpected response.",
        httpStatus: 200,
      }),
    });
  });

  it("hides network failure details", async () => {
    const client = createJiraClient({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND private.example.test");
      },
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
      httpStatus: undefined,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
        message: "Jira is unavailable.",
      }),
    });
  });

  it("classifies only its own elapsed signal as a timeout", async () => {
    const client = createJiraClient({
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private timeout", "TimeoutError")),
            { once: true },
          );
        }),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.NETWORK_TIMEOUT,
      httpStatus: undefined,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.NETWORK_TIMEOUT,
        message: "Jira request timed out.",
      }),
    });
  });

  it.each([
    "not a URL",
    "ftp://jira.example.test",
    "https://user:password@jira.example.test",
    "https://jira.example.test/jira?token=private",
    "https://jira.example.test/jira#private",
  ])("rejects unsafe Jira base URL %s before fetch", async (jiraUrl) => {
    const fetch = vi.fn();
    const client = createJiraClient({
      fetch,
      getJiraUrl: () => jiraUrl,
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.CONFIG_ERROR,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.CONFIG_ERROR,
        message: "Jira configuration is invalid.",
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "/rest/api/2/search",
    "\\rest\\api\\2\\search",
    "https://other.example.test/rest/api/2/search",
    "../rest/api/2/search",
    "rest/%2e%2e/admin",
    "rest/%2e%2e%2fadmin",
    "rest/%2e%2e%5cadmin",
    "rest/api/2/search?private=true",
    "rest/api/2/search#private",
  ])("rejects unsafe relative pathname %s before fetch", async (pathname) => {
    const fetch = vi.fn();
    const client = createJiraClient({
      fetch,
      getJiraUrl: () => "https://jira.example.test/jira/",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname, schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.BAD_REQUEST,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.BAD_REQUEST,
        message: "Jira rejected the request.",
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a binary response without parsing its body as JSON", async () => {
    const fetch = vi.fn(async () =>
      new Response(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), {
        headers: { "Content-Type": "image/png" },
      }),
    );
    const client = createJiraClient({
      fetch,
      getJiraUrl: () => "https://jira.example.test/jira",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    const response = await client.getBinary({
      pathname: "rest/api/2/attachment/content/123",
      notFoundCode: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://jira.example.test/jira/rest/api/2/attachment/content/123"),
      {
        headers: {
          Accept: "*/*",
          Authorization: "Bearer secret-token",
        },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("keeps the safe timeout active while a binary body is read", async () => {
    const client = createJiraClient({
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(
                    new DOMException("private timeout", "TimeoutError"),
                  ),
                { once: true },
              );
            },
          }),
        ),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1,
    });

    const response = await client.getBinary({
      pathname: "rest/api/2/attachment/content/123",
    });

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.NETWORK_TIMEOUT,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.NETWORK_TIMEOUT,
        message: "Jira request timed out.",
      }),
    });
  });

  it("maps a network failure while reading JSON without leaking it", async () => {
    const client = createJiraClient({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("private connection reset"));
            },
          }),
        ),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
      httpStatus: undefined,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
        message: "Jira is unavailable.",
      }),
    });
  });

  it("does not classify an unrelated AbortError as its timeout", async () => {
    const client = createJiraClient({
      fetch: async () => {
        throw new DOMException("private abort", "AbortError");
      },
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({ code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE });
  });

  it("maps binary 404 with the caller's context", async () => {
    const client = createJiraClient({
      fetch: async () => new Response(null, { status: 404 }),
      getJiraUrl: () => "https://jira.example.test",
      getToken: () => "secret-token",
      timeoutMs: 1_000,
    });

    await expect(
      client.getBinary({
        pathname: "rest/api/2/attachment/content/404",
        notFoundCode: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
      }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
      httpStatus: 404,
    });
  });

  it("gets configuration and credentials for every request", async () => {
    const getJiraUrl = vi.fn(() => "https://jira.example.test");
    const getToken = vi.fn(() => "secret-token");
    const client = createJiraClient({
      fetch: async () => Response.json({ ok: true }),
      getJiraUrl,
      getToken,
      timeoutMs: 1_000,
    });

    await client.getJson({ pathname: "rest/api/2/one", schema: z.unknown() });
    await client.getJson({ pathname: "rest/api/2/two", schema: z.unknown() });

    expect(getJiraUrl).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => "   ",
    () => {
      throw new Error("private keyring details");
    },
  ])("hides missing credential details before fetch", async (getToken) => {
    const fetch = vi.fn();
    const client = createJiraClient({
      fetch,
      getJiraUrl: () => "https://jira.example.test",
      getToken,
      timeoutMs: 1_000,
    });

    await expect(
      client.getJson({ pathname: "rest/api/2/search", schema: z.unknown() }),
    ).rejects.toMatchObject({
      code: JIRA_ERROR_CODE.CONFIG_ERROR,
      message: JSON.stringify({
        code: JIRA_ERROR_CODE.CONFIG_ERROR,
        message: "Jira configuration is invalid.",
      }),
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
