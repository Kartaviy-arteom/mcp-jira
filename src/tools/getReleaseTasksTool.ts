import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";

const inputSchema = z
  .object({
    releaseId: z
      .string()
      .regex(/^\d+$/)
      .describe("The numeric Jira release ID used to find assigned tasks."),
    includeDescription: z
      .boolean()
      .optional()
      .default(false)
      .describe("Whether to include each task description in the response."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(100)
      .describe("Maximum number of tasks to return, from 1 to 100."),
    startAt: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .default(0)
      .describe("Zero-based task offset for this page."),
  })
  .strict();

const taskSchema = z.object({
  id: z.string().describe("The unique internal numeric ID of the Jira task (e.g., '10024')."),
  key: z.string().describe("The visible project-specific task key (e.g., 'OMSAGORA-3520')."),
  summary: z.string().describe("The short title or summary describing the core goal of the task."),
  status: z.string().describe("The current workflow stage of the task."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("Detailed task description, included only when explicitly requested."),
});

const outputSchema = z.object({
  tasks: z.array(taskSchema).describe("The tasks assigned to the Jira release."),
  total: z.number().int().nonnegative().describe("Total number of matching Jira tasks."),
  nextStartAt: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Offset for the next page, or null when this is the last page."),
});

const jiraSearchResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  issues: z.array(
    z.object({
      id: z.string(),
      key: z.string(),
      fields: z.object({
        summary: z.string(),
        status: z.object({ name: z.string() }),
        description: z.string().nullable().optional(),
      }),
    }),
  ),
});

class GetReleaseTasksTool extends MCPTool {
  name = "get-release-tasks";
  description = "Get a paginated list of Jira tasks by release ID.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  async execute(input: MCPInput<this>) {
    try {
      const { issues, total } = await jiraClient.getJson({
        pathname: "rest/api/2/search",
        query: {
          jql: `fixVersion=${input.releaseId}`,
          startAt: input.startAt,
          maxResults: input.limit,
          fields: input.includeDescription ? "summary,status,description" : "summary,status",
        },
        schema: jiraSearchResponseSchema,
      });

      const nextStartAt = input.startAt + issues.length;
      if (issues.length === 0 && nextStartAt < total) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }

      return outputSchema.parse({
        tasks: issues.map((task) => ({
          id: task.id,
          key: task.key,
          summary: task.fields.summary,
          status: task.fields.status.name,
          ...(input.includeDescription ? { description: task.fields.description ?? null } : {}),
        })),
        total,
        nextStartAt: nextStartAt < total ? nextStartAt : null,
      });
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default GetReleaseTasksTool;
