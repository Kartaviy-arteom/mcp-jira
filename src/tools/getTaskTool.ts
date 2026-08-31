import { MCPTool, MCPInput } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";

const issueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
  .describe("Jira issue key, for example OMSAGORA-3520");

const inputSchema = z.object({ issueKey: issueKeySchema }).strict();

const issueReferenceSchema = z.object({
  key: z.string(),
  summary: z.string(),
});

const subtaskSchema = issueReferenceSchema.extend({ status: z.string() });

const issueLinkSchema = subtaskSchema.extend({
  type: z.string(),
  direction: z.enum(["inward", "outward"]),
});

const versionSchema = z.object({
  id: z.string(),
  name: z.string(),
  released: z.boolean(),
  archived: z.boolean(),
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
    .nullable()
    .describe(
      "Detailed technical and business description of the task, requirements, and steps to reproduce if applicable.",
    ),
  status: z
    .string()
    .describe(
      "The current workflow stage of the task as a text string (e.g., 'To Do', 'In Progress', 'Done', 'Code Review').",
    ),
  issueType: z.string().describe("The Jira issue type, for example Task or Bug."),
  parent: issueReferenceSchema.nullable(),
  subtasks: z.array(subtaskSchema),
  issueLinks: z.array(issueLinkSchema),
  fixVersions: z.array(versionSchema),
  updated: z.string().describe("The time when the Jira issue was last updated."),
});

const jiraIssueReferenceSchema = z.object({
  key: z.string(),
  fields: z.object({
    summary: z.string(),
  }),
});

const jiraSubtaskSchema = jiraIssueReferenceSchema.extend({
  fields: jiraIssueReferenceSchema.shape.fields.extend({
    status: z.object({ name: z.string() }),
  }),
});

const jiraIssueLinkTypeSchema = z.object({ name: z.string() });

const jiraIssueLinkSchema = z.union([
  z.object({
    type: jiraIssueLinkTypeSchema,
    inwardIssue: jiraSubtaskSchema,
    outwardIssue: z.never().optional(),
  }),
  z.object({
    type: jiraIssueLinkTypeSchema,
    inwardIssue: z.never().optional(),
    outwardIssue: jiraSubtaskSchema,
  }),
]);

const jiraIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    description: z.string().nullable(),
    status: z.object({
      name: z.string(),
    }),
    issuetype: z.object({ name: z.string() }),
    parent: jiraIssueReferenceSchema.nullable().optional(),
    subtasks: z.array(jiraSubtaskSchema).optional().default([]),
    issuelinks: z.array(jiraIssueLinkSchema).optional().default([]),
    fixVersions: z.array(versionSchema).optional().default([]),
    updated: z.string(),
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
        query: {
          fields:
            "summary,status,description,issuetype,parent,subtasks,issuelinks,fixVersions,updated",
        },
        schema: jiraIssueSchema,
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      });

      const result = {
        id: task.id,
        key: task.key,
        summary: task.fields?.summary,
        description: task.fields?.description,
        status: task.fields?.status?.name,
        issueType: task.fields.issuetype.name,
        parent: task.fields.parent
          ? { key: task.fields.parent.key, summary: task.fields.parent.fields.summary }
          : null,
        subtasks: (task.fields.subtasks ?? []).map((subtask) => ({
          key: subtask.key,
          summary: subtask.fields.summary,
          status: subtask.fields.status.name,
        })),
        issueLinks: (task.fields.issuelinks ?? []).map((link) => {
          const isInward = link.inwardIssue !== undefined;
          const linkedIssue = isInward ? link.inwardIssue : link.outwardIssue!;

          return {
            type: link.type.name,
            direction: isInward ? ("inward" as const) : ("outward" as const),
            key: linkedIssue.key,
            summary: linkedIssue.fields.summary,
            status: linkedIssue.fields.status.name,
          };
        }),
        fixVersions: task.fields.fixVersions,
        updated: task.fields.updated,
      };

      return outputSchema.parse(result);
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default GetTaskTool;
