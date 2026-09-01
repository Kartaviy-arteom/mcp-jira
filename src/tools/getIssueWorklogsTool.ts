import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";
import { issueKeySchema } from "../jira/schemas.js";

const inputSchema = z.object({ issueKey: issueKeySchema }).strict();

const outputSchema = z.object({
  issueKey: issueKeySchema.describe("The normalized Jira issue key."),
  totalTimeSeconds: z.number().int().nonnegative(),
  contributorsCount: z.number().int().nonnegative(),
  worklogsCount: z.number().int().nonnegative(),
});

const jiraWorklogsSchema = z.object({
  total: z.number().int().nonnegative(),
  worklogs: z.array(
    z.object({
      author: z
        .object({
          key: z.string().optional(),
          name: z.string().optional(),
        })
        .refine((author) => author.key !== undefined || author.name !== undefined),
      timeSpentSeconds: z.number().int().nonnegative(),
    }),
  ),
});

class GetIssueWorklogsTool extends MCPTool {
  name = "get-issue-worklogs";
  description = "Returns an anonymous aggregate of all worklogs for a Jira issue.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  async execute(input: MCPInput<this>) {
    const result = await jiraClient.getJson({
      pathname: `rest/api/2/issue/${encodeURIComponent(input.issueKey)}/worklog`,
      schema: jiraWorklogsSchema,
      notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
    });
    if (result.worklogs.length !== result.total) {
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
    }
    const contributors = new Set<string>();
    let totalTimeSeconds = 0;
    for (const worklog of result.worklogs) {
      totalTimeSeconds += worklog.timeSpentSeconds;
      if (worklog.author.key !== undefined) contributors.add(`key:${worklog.author.key}`);
      else if (worklog.author.name !== undefined) contributors.add(`name:${worklog.author.name}`);
    }

    return {
      issueKey: input.issueKey,
      totalTimeSeconds,
      contributorsCount: contributors.size,
      worklogsCount: result.worklogs.length,
    };
  }
}

export default GetIssueWorklogsTool;
