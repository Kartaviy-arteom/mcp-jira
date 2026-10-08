import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";
import { issueKeySchema } from "../jira/schemas.js";

const PROJECT_KEY = "OMSAGORA";
const ISSUE_TYPE_NAME = "FRONT";
const DEFAULT_EPIC_KEY = "OMSAGORA-350";
const EPIC_LINK_TYPE = "com.pyxis.greenhopper.jira:gh-epic-link";

const requiredText = z.string().refine((value) => value.trim().length > 0);
const summaryTitle = (value: string) =>
  value
    .trim()
    .replace(/^(?:\[FE\]\s*)+/i, "")
    .trim();
const inputSchema = z
  .object({
    summary: z
      .string()
      .refine((value) => summaryTitle(value).length > 0)
      .describe("Required Jira issue title; [FE] is added automatically."),
    description: requiredText.describe("Required Jira issue description."),
    epicKey: issueKeySchema
      .regex(/^OMSAGORA-[1-9]\d*$/)
      .optional()
      .describe("Existing OMSAGORA epic key; defaults to OMSAGORA-350."),
    releaseName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Exact name of an existing, unreleased and unarchived OMSAGORA release."),
  })
  .strict();
const outputSchema = z.object({
  issueKey: z
    .string()
    .regex(/^OMSAGORA-[1-9]\d*$/)
    .describe("Created Jira issue key."),
});
const projectSchema = z.object({ key: z.literal(PROJECT_KEY) });
const issueTypesSchema = z.object({
  isLast: z.boolean(),
  startAt: z.number().int().nonnegative(),
  values: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean() })),
});
const epicSchema = z.object({
  key: z.string(),
  fields: z.object({
    issuetype: z.object({ name: z.string() }),
    project: z.object({ key: z.string() }),
  }),
});
const createFieldsSchema = z.object({
  isLast: z.boolean(),
  startAt: z.number().int().nonnegative(),
  values: z.array(
    z.object({
      fieldId: z.string(),
      schema: z.object({ custom: z.string().optional() }).optional(),
    }),
  ),
});
const projectVersionsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    archived: z.boolean(),
    released: z.boolean(),
  }),
);
const createdIssueSchema = z.object({ key: outputSchema.shape.issueKey });

class CreateIssueTool extends MCPTool {
  name = "create-jira-issue";
  description =
    "Creates a FRONT issue in OMSAGORA with an existing epic and optional future release.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;
  annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  async execute(input: MCPInput<this>) {
    await jiraClient.getJson({
      pathname: `rest/api/2/project/${PROJECT_KEY}`,
      schema: projectSchema,
      notFoundCode: JIRA_ERROR_CODE.PROJECT_NOT_FOUND,
    });

    let startAt = 0;
    let issueTypeId: string | undefined;
    while (issueTypeId === undefined) {
      const page = await jiraClient.getJson({
        pathname: `rest/api/2/issue/createmeta/${PROJECT_KEY}/issuetypes`,
        query: { startAt },
        schema: issueTypesSchema,
      });
      issueTypeId = page.values.find(
        (type) => type.name.toLowerCase() === ISSUE_TYPE_NAME.toLowerCase() && !type.subtask,
      )?.id;
      if (issueTypeId !== undefined || page.isLast) break;
      if (page.values.length === 0 || page.startAt + page.values.length <= startAt) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }
      startAt = page.startAt + page.values.length;
    }

    if (issueTypeId === undefined) {
      throw new JiraClientError(JIRA_ERROR_CODE.ISSUE_TYPE_NOT_AVAILABLE);
    }

    const epicKey = input.epicKey ?? DEFAULT_EPIC_KEY;
    const epic = await jiraClient.getJson({
      pathname: `rest/api/2/issue/${epicKey}`,
      query: { fields: "issuetype,project" },
      schema: epicSchema,
      notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
    });
    if (
      epic.key !== epicKey ||
      epic.fields.project.key !== PROJECT_KEY ||
      epic.fields.issuetype.name.toLowerCase() !== "epic"
    ) {
      throw new JiraClientError(JIRA_ERROR_CODE.EPIC_NOT_AVAILABLE);
    }

    let epicFieldId: string | undefined;
    startAt = 0;
    while (epicFieldId === undefined) {
      const page = await jiraClient.getJson({
        pathname: `rest/api/2/issue/createmeta/${PROJECT_KEY}/issuetypes/${issueTypeId}`,
        query: { startAt },
        schema: createFieldsSchema,
      });
      epicFieldId = page.values.find((field) => field.schema?.custom === EPIC_LINK_TYPE)?.fieldId;
      if (epicFieldId !== undefined || page.isLast) break;
      if (page.values.length === 0 || page.startAt + page.values.length <= startAt) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }
      startAt = page.startAt + page.values.length;
    }
    if (epicFieldId === undefined) {
      throw new JiraClientError(JIRA_ERROR_CODE.EPIC_LINK_NOT_AVAILABLE);
    }

    let releaseId: string | undefined;
    if (input.releaseName !== undefined) {
      const versions = await jiraClient.getJson({
        pathname: `rest/api/2/project/${PROJECT_KEY}/versions`,
        schema: projectVersionsSchema,
      });
      const matches = versions.filter(
        (version) => version.name === input.releaseName && !version.archived && !version.released,
      );
      if (matches.length !== 1) {
        throw new JiraClientError(JIRA_ERROR_CODE.RELEASE_NOT_AVAILABLE);
      }
      releaseId = matches[0]!.id;
    }

    const created = await jiraClient.postJson({
      pathname: "rest/api/2/issue",
      body: {
        fields: {
          project: { key: PROJECT_KEY },
          issuetype: { id: issueTypeId },
          summary: `[FE] ${summaryTitle(input.summary)}`,
          description: input.description,
          [epicFieldId]: epicKey,
          ...(releaseId === undefined ? {} : { fixVersions: [{ id: releaseId }] }),
        },
      },
      schema: createdIssueSchema,
    });

    return outputSchema.parse({ issueKey: created.key });
  }
}

export default CreateIssueTool;
