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

  it("returns a structured Jira issue with hierarchy, links and versions", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        id: "10001",
        key: "OMS-1",
        fields: {
          summary: "Safe HTTP client",
          description: null,
          status: { name: "In Progress" },
          issuetype: { name: "Task" },
          parent: {
            id: "10000",
            key: "OMS-0",
            fields: { summary: "Jira integration" },
          },
          subtasks: [
            {
              id: "10002",
              key: "OMS-2",
              fields: { summary: "Add tests", status: { name: "Open" } },
            },
          ],
          issuelinks: [
            {
              id: "20001",
              type: { id: "10000", name: "Blocks" },
              outwardIssue: {
                id: "10003",
                key: "OMS-3",
                fields: { summary: "Release", status: { name: "To Do" } },
              },
            },
            {
              id: "20002",
              type: { id: "10000", name: "Blocks" },
              inwardIssue: {
                id: "10004",
                key: "OMS-4",
                fields: { summary: "Deployment", status: { name: "Done" } },
              },
            },
          ],
          fixVersions: [
            {
              id: "18136",
              name: "release-1.2.3",
              released: false,
              archived: true,
            },
          ],
          updated: "2026-08-31T12:34:56.000+0300",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetTaskTool().toolCall({
      params: { name: "get-jira-issue", arguments: { issueKey: " oms-1 " } },
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      id: "10001",
      key: "OMS-1",
      summary: "Safe HTTP client",
      description: null,
      status: "In Progress",
      issueType: "Task",
      parent: { key: "OMS-0", summary: "Jira integration" },
      subtasks: [{ key: "OMS-2", summary: "Add tests", status: "Open" }],
      issueLinks: [
        {
          type: "Blocks",
          direction: "outward",
          key: "OMS-3",
          summary: "Release",
          status: "To Do",
        },
        {
          type: "Blocks",
          direction: "inward",
          key: "OMS-4",
          summary: "Deployment",
          status: "Done",
        },
      ],
      fixVersions: [
        {
          id: "18136",
          name: "release-1.2.3",
          released: false,
          archived: true,
        },
      ],
      updated: "2026-08-31T12:34:56.000+0300",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/issue/OMS-1?fields=summary%2Cstatus%2Cdescription%2Cissuetype%2Cparent%2Csubtasks%2Cissuelinks%2CfixVersions%2Cupdated",
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("returns null parent and empty related collections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "10001",
          key: "OMS-1",
          fields: {
            summary: "Standalone issue",
            description: "Details",
            status: { name: "Open" },
            issuetype: { name: "Story" },
            updated: "2026-08-31T12:34:56.000+0300",
          },
        }),
      ),
    );

    const response = await new GetTaskTool().toolCall({
      params: { name: "get-jira-issue", arguments: { issueKey: "OMS-1" } },
    });

    expect(response.structuredContent).toMatchObject({
      description: "Details",
      parent: null,
      subtasks: [],
      issueLinks: [],
      fixVersions: [],
    });
  });

  it.each([{ issueKey: "not a key" }, { issueKey: "OMS-1", unexpected: true }])(
    "rejects invalid get-jira-issue input before fetch",
    async (input) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const response = await new GetTaskTool().toolCall({
        params: { name: "get-jira-issue", arguments: input },
      });

      expect(response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns a safe error for an incompatible Jira issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "10001",
          key: "OMS-1",
          fields: {
            summary: "Broken response",
            description: null,
            status: { name: "Open" },
            issuetype: { name: "Task" },
            fixVersions: [{ id: "18136", name: "release", released: "no", archived: false }],
            updated: "2026-08-31T12:34:56.000+0300",
          },
        }),
      ),
    );

    const response = await new GetTaskTool().toolCall({
      params: { name: "get-jira-issue", arguments: { issueKey: "OMS-1" } },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
            message: "Jira returned an unexpected response.",
            httpStatus: 200,
          }),
        },
      ],
      isError: true,
    });
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
