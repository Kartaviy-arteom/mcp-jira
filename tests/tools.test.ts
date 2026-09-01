import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findCredentials } = vi.hoisted(() => ({
  findCredentials: vi.fn((): { password: string }[] => [{ password: "test-token" }]),
}));

vi.mock("@napi-rs/keyring", () => ({
  findCredentials,
}));

import DiagnoseJiraConnectionTool from "../src/tools/diagnoseJiraConnectionTool.js";
import GetReleaseTasksTool from "../src/tools/getReleaseTasksTool.js";
import GetTaskTool from "../src/tools/getTaskTool.js";
import { JIRA_ERROR_CODE } from "../src/jira/client.js";

describe("Jira tools", () => {
  beforeEach(() => {
    findCredentials.mockReset();
    findCredentials.mockReturnValue([{ password: "test-token" }]);
    vi.stubEnv("JIRA_URL", "https://jira.example.test/jira");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    [200, "authenticated"],
    [204, "authenticated"],
    [302, "unverified"],
    [401, "rejected"],
    [403, "rejected"],
    [500, "unverified"],
  ] as const)(
    "diagnoses authenticated Jira HTTP %i as %s",
    async (status, authenticationStatus) => {
      const fetch = vi.fn(
        async () => new Response(status === 204 ? null : "private Jira body", { status }),
      );
      vi.stubGlobal("fetch", fetch);

      const response = await new DiagnoseJiraConnectionTool().toolCall({
        params: { name: "diagnose-jira-connection", arguments: {} },
      });

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toEqual({
        configured: true,
        credentialsFound: true,
        reachable: true,
        authenticationStatus,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("diagnoses reachability without credentials or an Authorization header", async () => {
    findCredentials.mockReturnValue([]);
    const fetch = vi.fn(async () => new Response("private Jira body", { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    const response = await new DiagnoseJiraConnectionTool().toolCall({
      params: { name: "diagnose-jira-connection", arguments: {} },
    });

    expect(response.structuredContent).toEqual({
      configured: true,
      credentialsFound: false,
      reachable: true,
      authenticationStatus: "unverified",
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://jira.example.test/jira/rest/api/2/myself"),
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("checks credentials independently when the Jira URL is invalid", async () => {
    vi.stubEnv("JIRA_URL", "ftp://jira.example.test/private");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await new DiagnoseJiraConnectionTool().toolCall({
      params: { name: "diagnose-jira-connection", arguments: {} },
    });

    expect(response.structuredContent).toEqual({
      configured: false,
      credentialsFound: true,
      reachable: false,
      authenticationStatus: "unverified",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    new Error("private network details"),
    new DOMException("private timeout", "TimeoutError"),
  ])("reports a failed Jira connection without leaking %s", async (failure) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw failure;
      }),
    );

    const response = await new DiagnoseJiraConnectionTool().toolCall({
      params: { name: "diagnose-jira-connection", arguments: {} },
    });

    expect(response.structuredContent).toEqual({
      configured: true,
      credentialsFound: true,
      reachable: false,
      authenticationStatus: "unverified",
    });
    expect(JSON.stringify(response)).not.toContain(failure.message);
  });

  it("rejects non-empty diagnostic input before contacting Jira", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await new DiagnoseJiraConnectionTool().toolCall({
      params: {
        name: "diagnose-jira-connection",
        arguments: { revealSecrets: true },
      },
    });

    expect(response.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
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

  it("gets the first release task page without descriptions by default", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        total: 3,
        issues: [
          {
            id: "10002",
            key: "OMS-2",
            fields: { summary: "Migrate tool", status: { name: "In Progress" } },
          },
          {
            id: "10003",
            key: "OMS-3",
            fields: { summary: "Test tool", status: { name: "To Do" } },
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
    expect(response.structuredContent).toEqual({
      tasks: [
        {
          id: "10002",
          key: "OMS-2",
          summary: "Migrate tool",
          status: "In Progress",
        },
        {
          id: "10003",
          key: "OMS-3",
          summary: "Test tool",
          status: "To Do",
        },
      ],
      total: 3,
      nextStartAt: 2,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/search?jql=fixVersion%3D18136&startAt=0&maxResults=100&fields=summary%2Cstatus",
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("gets a configured release task page with descriptions", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        total: 7,
        issues: [
          {
            id: "10005",
            key: "OMS-5",
            fields: {
              summary: "Document tool",
              status: { name: "Done" },
              description: null,
            },
          },
          {
            id: "10006",
            key: "OMS-6",
            fields: {
              summary: "Publish tool",
              status: { name: "In Progress" },
              description: "Release notes are ready",
            },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136", includeDescription: true, startAt: 5, limit: 20 },
      },
    });

    expect(response.structuredContent).toEqual({
      tasks: [
        {
          id: "10005",
          key: "OMS-5",
          summary: "Document tool",
          status: "Done",
          description: null,
        },
        {
          id: "10006",
          key: "OMS-6",
          summary: "Publish tool",
          status: "In Progress",
          description: "Release notes are ready",
        },
      ],
      total: 7,
      nextStartAt: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        "https://jira.example.test/jira/rest/api/2/search?jql=fixVersion%3D18136&startAt=5&maxResults=20&fields=summary%2Cstatus%2Cdescription",
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each([1, 100])("accepts the release task page limit boundary %i", async (limit) => {
    const fetch = vi.fn(async () => Response.json({ total: 0, issues: [] }));
    vi.stubGlobal("fetch", fetch);

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136", limit },
      },
    });

    expect(response.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL(
        `https://jira.example.test/jira/rest/api/2/search?jql=fixVersion%3D18136&startAt=0&maxResults=${limit}&fields=summary%2Cstatus`,
      ),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it.each([
    { releaseId: "18136 OR project=PRIVATE" },
    { releaseId: "" },
    { releaseId: "18136", startAt: -1 },
    { releaseId: "18136", startAt: 1.5 },
    { releaseId: "18136", limit: 0 },
    { releaseId: "18136", limit: 101 },
    { releaseId: "18136", limit: 1.5 },
    { releaseId: "18136", issueKey: "OMS-1" },
    { releaseId: "18136", jql: "project=PRIVATE" },
  ])("rejects invalid get-release-tasks input before fetch: %j", async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: input,
      },
    });

    expect(response.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null pagination for an empty final release page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ total: 4, issues: [] })),
    );

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136", startAt: 4 },
      },
    });

    expect(response.structuredContent).toEqual({ tasks: [], total: 4, nextStartAt: null });
  });

  it("rejects an empty release page when Jira claims more tasks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ total: 5, issues: [] })),
    );

    const response = await new GetReleaseTasksTool().toolCall({
      params: {
        name: "get-release-tasks",
        arguments: { releaseId: "18136", startAt: 4 },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
            message: "Jira returned an unexpected response.",
          }),
        },
      ],
      isError: true,
    });
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
