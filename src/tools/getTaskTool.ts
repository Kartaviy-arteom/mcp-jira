import { MCPTool, MCPInput } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";

const inputSchema = z.object({
  issueKey: z.string().describe("Jira issue key, for example OMSAGORA-3520"),
});

const outputSchema = z.object({
  id: z.string().describe("The unique internal numeric ID of the Jira task (e.g., '10024')."),
  key: z
    .string()
    .describe(
      "The visible project-specific task key (e.g., 'OMSAGORA-3520'). Use this to reference the task.",
    ),
  summary: z.string().describe("The short title or summary describing the core goal of the task."),
  description: z
    .string()
    .describe(
      "Detailed technical and business description of the task, requirements, and steps to reproduce if applicable.",
    ),
  status: z
    .string()
    .describe(
      "The current workflow stage of the task as a text string (e.g., 'To Do', 'In Progress', 'Done', 'Code Review').",
    ),
});

const jiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.string().nullable(),
    status: z.object({
      name: z.string(),
    }),
  }),
});

class GetTaskTool extends MCPTool {
  name = "get-jira-issue";
  description = "Retrieves a Jira issue by its issue key, for example OMSAGORA-3520.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  async execute(input: MCPInput<this>) {
    try {
      const task = await jiraClient.getJson({
        pathname: `rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
        query: { fields: "summary,status,description" },
        schema: jiraIssueSchema,
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      });

      const result = {
        id: task.id,
        key: task.key,
        summary: task.fields?.summary,
        description: task.fields?.description ?? "",
        status: task.fields?.status?.name,
      };

      return outputSchema.parse(result);
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default GetTaskTool;
