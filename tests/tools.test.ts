import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findCredentials } = vi.hoisted(() => ({
  findCredentials: vi.fn((): { password: string }[] => [{ password: "test-token" }]),
}));

vi.mock("@napi-rs/keyring", () => ({
  findCredentials,
}));

import DiagnoseJiraConnectionTool from "../src/tools/diagnoseJiraConnectionTool.js";
import GetIssueAttachmentTool from "../src/tools/getIssueAttachmentTool.js";
import GetIssueWorklogsTool from "../src/tools/getIssueWorklogsTool.js";
import GetReleaseTasksTool from "../src/tools/getReleaseTasksTool.js";
import GetTaskTool from "../src/tools/getTaskTool.js";
import ListIssueAttachmentsTool from "../src/tools/listIssueAttachmentsTool.js";
import { JIRA_ERROR_CODE } from "../src/jira/client.js";

type JiraAttachmentFixture = {
  self: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string;
};

const jiraAttachment = (overrides: Partial<JiraAttachmentFixture> = {}): JiraAttachmentFixture => ({
  self: "https://jira.example.test/jira/rest/api/2/attachment/12345",
  filename: "design.png",
  mimeType: "image/png",
  size: 9,
  content: "https://jira.example.test/jira/attachments/12345",
  ...overrides,
});

const jiraIssueAttachments = (...attachment: JiraAttachmentFixture[]) => ({
  fields: { attachment },
});

describe("Jira tools", () => {
  beforeEach(() => {
    findCredentials.mockReset();
    findCredentials.mockReturnValue([{ password: "test-token" }]);
    vi.stubEnv("JIRA_URL", "https://jira.example.test/jira");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns an empty anonymous worklog summary", async () => {
    const fetch = vi.fn(async () => Response.json({ total: 0, worklogs: [] }));
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueWorklogsTool().toolCall({
      params: { name: "get-issue-worklogs", arguments: { issueKey: " oms-1 " } },
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      issueKey: "OMS-1",
      totalTimeSeconds: 0,
      contributorsCount: 0,
      worklogsCount: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://jira.example.test/jira/rest/api/2/issue/OMS-1/worklog"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("sums time and deduplicates contributors in separate identifier namespaces", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total: 4,
          worklogs: [
            { author: { key: "employee-1", name: "legacy-1" }, timeSpentSeconds: 600 },
            { author: { key: "employee-1", name: "changed-name" }, timeSpentSeconds: 1200 },
            { author: { name: "legacy-1" }, timeSpentSeconds: 300 },
            { author: { key: "employee-2" }, timeSpentSeconds: 900 },
          ],
        }),
      ),
    );

    const response = await new GetIssueWorklogsTool().toolCall({
      params: { name: "get-issue-worklogs", arguments: { issueKey: "OMS-1" } },
    });

    expect(response.structuredContent).toEqual({
      issueKey: "OMS-1",
      totalTimeSeconds: 3000,
      contributorsCount: 3,
      worklogsCount: 4,
    });
  });

  it.each([
    { author: {}, timeSpentSeconds: 600, comment: "private comment" },
    { timeSpentSeconds: 600, comment: "private comment" },
  ])("rejects a worklog whose author has no supported identifier", async (worklog) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total: 1,
          worklogs: [worklog],
        }),
      ),
    );

    const response = await new GetIssueWorklogsTool().toolCall({
      params: { name: "get-issue-worklogs", arguments: { issueKey: "OMS-1" } },
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
    expect(JSON.stringify(response)).not.toContain("private comment");
  });

  it.each([{ issueKey: "invalid" }, { issueKey: "OMS-1", includeAuthors: true }])(
    "rejects invalid get-issue-worklogs input before fetch: %j",
    async (input) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const response = await new GetIssueWorklogsTool().toolCall({
        params: { name: "get-issue-worklogs", arguments: input },
      });

      expect(response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("returns ISSUE_NOT_FOUND for a missing worklog issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private Jira response", { status: 404 })),
    );

    const response = await new GetIssueWorklogsTool().toolCall({
      params: { name: "get-issue-worklogs", arguments: { issueKey: "OMS-404" } },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
            message: "Jira issue was not found.",
          }),
        },
      ],
      isError: true,
    });
  });

  it("rejects an incomplete worklog response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          total: 2,
          worklogs: [{ author: { key: "private-employee-id" }, timeSpentSeconds: 600 }],
        }),
      ),
    );

    const response = await new GetIssueWorklogsTool().toolCall({
      params: { name: "get-issue-worklogs", arguments: { issueKey: "OMS-1" } },
    });

    expect(response.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          code: JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
          message: "Jira returned an unexpected response.",
        }),
      },
    ]);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toContain("private-employee-id");
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
          }),
        },
      ],
      isError: true,
    });
  });

  it("lists supported and unsupported Jira issue attachments", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        fields: {
          attachment: [
            {
              self: "https://jira.example.test/jira/rest/api/2.0/attachments/12345",
              filename: "design.png",
              mimeType: "image/png",
              size: 248310,
            },
            {
              self: "https://jira.example.test/jira/rest/api/2/attachment/12346",
              filename: "photo.jpg",
              mimeType: "image/jpeg",
              size: 1542,
            },
            {
              self: "https://jira.example.test/jira/rest/api/2/attachment/12347",
              filename: "preview.webp",
              mimeType: "image/webp",
              size: 812,
            },
            {
              self: "https://jira.example.test/jira/rest/api/2/attachment/12348",
              filename: "notes.txt",
              mimeType: "text/plain",
              size: 32,
            },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new ListIssueAttachmentsTool().toolCall({
      params: { name: "list-issue-attachments", arguments: { issueKey: " oms-1 " } },
    });

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({
      attachments: [
        {
          id: "12345",
          filename: "design.png",
          mimeType: "image/png",
          size: 248310,
          supported: true,
        },
        {
          id: "12346",
          filename: "photo.jpg",
          mimeType: "image/jpeg",
          size: 1542,
          supported: true,
        },
        {
          id: "12347",
          filename: "preview.webp",
          mimeType: "image/webp",
          size: 812,
          supported: true,
        },
        {
          id: "12348",
          filename: "notes.txt",
          mimeType: "text/plain",
          size: 32,
          supported: false,
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://jira.example.test/jira/rest/api/2/issue/OMS-1?fields=attachment"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("returns an empty attachment list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ fields: { attachment: [] } })),
    );

    const response = await new ListIssueAttachmentsTool().toolCall({
      params: { name: "list-issue-attachments", arguments: { issueKey: "OMS-1" } },
    });

    expect(response.structuredContent).toEqual({ attachments: [] });
  });

  it.each([{ issueKey: "not a key" }, { issueKey: "OMS-1", unexpected: true }])(
    "rejects invalid list-issue-attachments input before fetch",
    async (input) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);

      const response = await new ListIssueAttachmentsTool().toolCall({
        params: { name: "list-issue-attachments", arguments: input },
      });

      expect(response.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects an incompatible Jira attachment self URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          fields: {
            attachment: [
              {
                self: "https://jira.example.test/jira/rest/api/2/attachment/not-numeric",
                filename: "design.png",
                mimeType: "image/png",
                size: 248310,
              },
            ],
          },
        }),
      ),
    );

    const response = await new ListIssueAttachmentsTool().toolCall({
      params: { name: "list-issue-attachments", arguments: { issueKey: "OMS-1" } },
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

  it("returns ISSUE_NOT_FOUND when listing attachments for a missing issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private Jira response", { status: 404 })),
    );

    const response = await new ListIssueAttachmentsTool().toolCall({
      params: { name: "list-issue-attachments", arguments: { issueKey: "OMS-404" } },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
            message: "Jira issue was not found.",
          }),
        },
      ],
      isError: true,
    });
  });

  it("returns a validated Jira PNG attachment as an MCP image", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          jiraIssueAttachments(
            jiraAttachment({
              size: png.byteLength,
              content: "https://jira.example.test/jira/secure/attachment/12345/design.png",
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(
        new Response(png, {
          headers: {
            "Content-Type": "IMAGE/PNG; charset=binary",
            "Content-Length": String(png.byteLength),
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: " oms-1 ", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
      ],
      structuredContent: {
        issueKey: "OMS-1",
        attachmentId: "12345",
        filename: "design.png",
        mimeType: "image/png",
        size: png.byteLength,
      },
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("https://jira.example.test/jira/rest/api/2/issue/OMS-1?fields=attachment"),
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("https://jira.example.test/jira/secure/attachment/12345/design.png"),
      expect.objectContaining({
        headers: { Accept: "*/*", Authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
  });

  it.each([
    ["image/jpeg", "photo.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
    [
      "image/webp",
      "preview.webp",
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
    ],
  ] as const)("returns a validated %s Jira attachment", async (mimeType, filename, bytes) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          jiraIssueAttachments(jiraAttachment({ filename, mimeType, size: bytes.byteLength })),
        ),
      )
      .mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": mimeType } }));
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response.content).toEqual([
      { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
    ]);
    expect(response.structuredContent).toMatchObject({ filename, mimeType });
  });

  it.each([
    { issueKey: "not a key", attachmentId: "12345" },
    { issueKey: "OMS-1", attachmentId: "not-numeric" },
    { issueKey: "OMS-1", attachmentId: "12345", unexpected: true },
  ])("rejects invalid get-issue-attachment input before fetch", async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: { name: "get-issue-attachment", arguments: input },
    });

    expect(response.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not download an attachment that does not belong to the issue", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        jiraIssueAttachments(
          jiraAttachment({
            self: "https://jira.example.test/jira/rest/api/2/attachment/99999",
            filename: "other.png",
            content: "https://jira.example.test/jira/attachments/99999",
          }),
        ),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
            message: "Jira attachment was not found.",
          }),
        },
      ],
      isError: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "text/plain",
      32,
      JIRA_ERROR_CODE.UNSUPPORTED_ATTACHMENT_TYPE,
      "Jira attachment type is unsupported.",
    ],
    [
      "image/png",
      5 * 1024 * 1024 + 1,
      JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE,
      "Jira attachment exceeds the supported size limit.",
    ],
  ] as const)(
    "rejects attachment metadata with MIME %s and size %i before download",
    async (mimeType, size, code, message) => {
      const fetch = vi.fn(async () =>
        Response.json(
          jiraIssueAttachments(jiraAttachment({ filename: "unsafe.bin", mimeType, size })),
        ),
      );
      vi.stubGlobal("fetch", fetch);

      const response = await new GetIssueAttachmentTool().toolCall({
        params: {
          name: "get-issue-attachment",
          arguments: { issueKey: "OMS-1", attachmentId: "12345" },
        },
      });

      expect(response).toEqual({
        content: [{ type: "text", text: JSON.stringify({ code, message }) }],
        isError: true,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "http://jira.example.test/jira/attachments/12345",
    "https://external.example.test/jira/attachments/12345",
    "https://jira.example.test/other/attachments/12345",
    "https://jira.example.test/jira/attachments/99999",
    "https://jira.example.test/jira/secure/attachment/99999/design.png",
    "https://jira.example.test/jira/secure/attachment/12345/path/design.png",
    "https://jira.example.test/jira/attachments/12345?token=private",
  ])("rejects incompatible Jira attachment content URI %s", async (content) => {
    const fetch = vi.fn(async () =>
      Response.json(jiraIssueAttachments(jiraAttachment({ content }))),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
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
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain(content);
  });

  it.each([
    ["image/jpeg", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x00])],
  ] as const)(
    "rejects an image response with Content-Type %s or an incompatible signature",
    async (responseMimeType, bytes) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(jiraIssueAttachments(jiraAttachment({ size: bytes.byteLength }))),
        )
        .mockResolvedValueOnce(
          new Response(bytes, { headers: { "Content-Type": responseMimeType } }),
        );
      vi.stubGlobal("fetch", fetch);

      const response = await new GetIssueAttachmentTool().toolCall({
        params: {
          name: "get-issue-attachment",
          arguments: { issueKey: "OMS-1", attachmentId: "12345" },
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
    },
  );

  it("rejects an oversized declared attachment before reading its body", async () => {
    const cancel = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(jiraIssueAttachments(jiraAttachment())))
      .mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(5 * 1024 * 1024 + 1),
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE,
            message: "Jira attachment exceeds the supported size limit.",
          }),
        },
      ],
      isError: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops an oversized attachment stream with an invalid Content-Length", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        if (chunk === 1) controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        else if (chunk === 2) controller.enqueue(Uint8Array.of(0));
      },
      cancel,
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(jiraIssueAttachments(jiraAttachment())))
      .mockResolvedValueOnce(
        new Response(body, {
          headers: { "Content-Type": "image/png", "Content-Length": "invalid" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE,
            message: "Jira attachment exceeds the supported size limit.",
          }),
        },
      ],
      isError: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns ATTACHMENT_NOT_FOUND when the selected attachment disappears", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(jiraIssueAttachments(jiraAttachment())))
      .mockResolvedValueOnce(new Response("private Jira response", { status: 404 }));
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
            message: "Jira attachment was not found.",
          }),
        },
      ],
      isError: true,
    });
  });

  it("returns NETWORK_TIMEOUT when the attachment body times out", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(1));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(jiraIssueAttachments(jiraAttachment())))
      .mockImplementationOnce(
        async (_input, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener(
                  "abort",
                  () => controller.error(new DOMException("private timeout", "TimeoutError")),
                  { once: true },
                );
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          ),
      );
    vi.stubGlobal("fetch", fetch);

    const response = await new GetIssueAttachmentTool().toolCall({
      params: {
        name: "get-issue-attachment",
        arguments: { issueKey: "OMS-1", attachmentId: "12345" },
      },
    });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: JIRA_ERROR_CODE.NETWORK_TIMEOUT,
            message: "Jira request timed out.",
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
          }),
        },
      ],
      isError: true,
    });
  });
});
