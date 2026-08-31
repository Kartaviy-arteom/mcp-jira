import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";

const inputSchema = z.object({
  releaseId: z
    .string()
    .regex(/^\d+$/)
    .describe("The numeric Jira release ID used to find assigned tasks."),
});

const taskSchema = z.object({
  id: z.string().describe("The unique internal numeric ID of the Jira task (e.g., '10024')."),
  key: z.string().describe("The visible project-specific task key (e.g., 'OMSAGORA-3520')."),
  summary: z.string().describe("The short title or summary describing the core goal of the task."),
  description: z.string().describe("Detailed technical and business description of the task."),
});

const outputSchema = z.array(taskSchema).describe("The tasks assigned to the Jira release.");

const jiraSearchResponseSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      fields: z.object({
        summary: z.string(),
        description: z.string().nullable(),
      }),
    }),
  ),
});

class GetReleaseTasksTool extends MCPTool {
  name = "get-release-tasks";
  description = "Get a list of Jira tasks by release ID.";
  schema = inputSchema;

  async execute(input: MCPInput<this>) {
    try {
      const { issues } = await jiraClient.getJson({
        pathname: "rest/api/2/search",
        query: {
          jql: `fixVersion=${input.releaseId}`,
          startAt: 0,
          maxResults: 500,
          fields: "summary,status,description",
        },
        schema: jiraSearchResponseSchema,
      });

      return outputSchema.parse(
        issues.map((task) => ({
          id: task.id,
          key: task.key,
          summary: task.fields?.summary,
          description: task.fields?.description ?? "",
        })),
      );
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default GetReleaseTasksTool;
