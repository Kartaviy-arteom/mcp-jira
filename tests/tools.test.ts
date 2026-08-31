import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@napi-rs/keyring", () => ({
  findCredentials: () => [{ password: "test-token" }],
}));

import GetReleaseTasksTool from "../src/tools/getReleaseTasksTool.js";
import GetTaskTool from "../src/tools/getTaskTool.js";
import { JIRA_ERROR_CODE } from "../src/jira/client.js";

describe("Jira tools", () => {
  beforeEach(() => {
    vi.stubEnv("JIRA_URL", "https://jira.example.test/jira");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a Jira issue through the MCP interface", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        id: "10001",
        key: "OMS-1",
        fields: {
          summary: "Safe HTTP client",
          description: null,
          status: { name: "In Progress" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetTaskTool().toolCall({
      params: { name: "get-jira-issue", arguments: { issueKey: "OMS-1" } },
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      id: "10001",
      key: "OMS-1",
      summary: "Safe HTTP client",
      description: "",
      status: "In Progress",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/issue/OMS-1?fields=summary%2Cstatus%2Cdescription",
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("gets release tasks using a validated releaseId", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        issues: [
          {
            id: "10002",
            key: "OMS-2",
            fields: { summary: "Migrate tool", description: "Done safely" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136" },
      },
    });

    expect(response.isError).toBeUndefined();
    expect(
      JSON.parse(response.content[0]?.type === "text" ? response.content[0].text : "null"),
    ).toEqual([
      {
        id: "10002",
        key: "OMS-2",
        summary: "Migrate tool",
        description: "Done safely",
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/search?jql=fixVersion%3D18136&startAt=0&maxResults=500&fields=summary%2Cstatus%2Cdescription",
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("rejects a non-numeric releaseId before fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136 OR project=PRIVATE" },
      },
    });

    expect(response.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only the safe Jira error through MCP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private Jira stack and implementation", { status: 500 })),
    );

    const response = await new GetTaskTool().toolCall({
      params: { name: "get-jira-issue", arguments: { issueKey: "OMS-1" } },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.JIRA_UNAVAILABLE,
            message: "Jira is unavailable.",
            httpStatus: 500,
          }),
        },
      ],
      isError: true,
    });
  });
});
