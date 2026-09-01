import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import {
  JIRA_ERROR_CODE,
  JiraClientError,
  jiraClient,
  normalizeJiraErrorDetails,
} from "../jira/client.js";
import { issueKeySchema } from "../jira/schemas.js";

const inputSchema = z
  .object({
    issueKey: issueKeySchema.describe("Jira issue key, for example OMSAGORA-3520."),
    targetStatus: z
      .string()
      .trim()
      .min(1)
      .describe("Target Jira workflow status or transition name, for example In Progress."),
  })
  .strict();

const statusSchema = z.object({
  id: z.string().describe("Jira status identifier."),
  name: z.string().describe("Jira status name."),
});

const outputSchema = z.object({
  issueKey: z.string().describe("Canonical Jira issue key returned by Jira."),
  previousStatus: statusSchema.describe("Status observed before the transition attempt."),
  newStatus: statusSchema.describe("Status observed after the transition attempt."),
  transition: z
    .object({
      id: z.string().describe("Executed Jira transition identifier."),
      name: z.string().describe("Executed Jira transition name."),
    })
    .nullable()
    .describe("Executed transition, or null when no change was needed."),
  changed: z.boolean().describe("Whether a transition was executed and verified."),
});

const jiraIssueStatusSchema = z.object({
  key: z.string(),
  fields: z.object({ status: statusSchema }),
});

const jiraFieldSchema = z.object({
  required: z.boolean(),
  name: z.string().optional(),
  hasDefaultValue: z.boolean().optional(),
  schema: z
    .object({
      type: z.string(),
      items: z.string().optional(),
      system: z.string().optional(),
      custom: z.string().optional(),
      customId: z.number().optional(),
    })
    .optional(),
});

const jiraTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: statusSchema,
  fields: z.record(jiraFieldSchema),
});

const jiraTransitionsSchema = z.object({ transitions: z.array(jiraTransitionSchema) });

const publicTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetStatus: statusSchema,
});

const requiredFieldSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  hasDefaultValue: z.boolean().optional(),
  schema: jiraFieldSchema.shape.schema.optional(),
});

const transitionNotAvailableDetailsSchema = z.object({
  targetStatus: z.string(),
  availableTransitions: z.array(publicTransitionSchema),
});

const transitionAmbiguousDetailsSchema = z.object({
  targetStatus: z.string(),
  candidates: z.array(publicTransitionSchema),
});

const transitionRequiresFieldsDetailsSchema = z.object({
  transition: publicTransitionSchema,
  requiredFields: z.array(requiredFieldSchema),
});

const executedTransitionSchema = z.object({ id: z.string(), name: z.string() });

const transitionVerificationFailedDetailsSchema = z.object({
  issueKey: z.string(),
  previousStatus: statusSchema,
  expectedStatus: statusSchema,
  transition: executedTransitionSchema,
  causeCode: z.nativeEnum(JIRA_ERROR_CODE),
});

const transitionStatusMismatchDetailsSchema = z.object({
  issueKey: z.string(),
  previousStatus: statusSchema,
  expectedStatus: statusSchema,
  actualStatus: statusSchema,
  transition: executedTransitionSchema,
});

const normalizeWorkflowName = (name: string): string => name.trim().toLowerCase();

const toPublicTransition = (transition: {
  id: string;
  name: string;
  to: z.infer<typeof statusSchema>;
}) => ({
  id: transition.id,
  name: transition.name,
  targetStatus: transition.to,
});

class ChangeIssueStatusTool extends MCPTool {
  name = "change-issue-status";
  description = "Changes a Jira issue's status by matching a target status or transition name.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;
  annotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  };

  get toolDefinition() {
    const definition = super.toolDefinition;
    const outputSchema = definition.outputSchema as
      | {
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        }
      | undefined;
    if (outputSchema?.properties?.transition !== undefined) {
      outputSchema.properties.transition.type = ["object", "null"];
      outputSchema.required = ["issueKey", "previousStatus", "newStatus", "transition", "changed"];
    }
    return definition;
  }

  async execute(input: MCPInput<this>) {
    const issue = await jiraClient.getJson({
      pathname: `rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
      query: { fields: "status" },
      schema: jiraIssueStatusSchema,
      notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
    });
    const previousStatus = issue.fields.status;

    if (normalizeWorkflowName(previousStatus.name) === normalizeWorkflowName(input.targetStatus)) {
      return outputSchema.parse({
        issueKey: issue.key,
        previousStatus,
        newStatus: previousStatus,
        transition: null,
        changed: false,
      });
    }

    const transitions = await jiraClient.getJson({
      pathname: `rest/api/2/issue/${encodeURIComponent(issue.key)}/transitions`,
      query: { expand: "transitions.fields" },
      schema: jiraTransitionsSchema,
      notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
    });
    const candidates = transitions.transitions.filter((transition) =>
      [transition.to.name, transition.name].some(
        (name) => normalizeWorkflowName(name) === normalizeWorkflowName(input.targetStatus),
      ),
    );

    if (candidates.length === 0) {
      throw new JiraClientError(
        JIRA_ERROR_CODE.TRANSITION_NOT_AVAILABLE,
        undefined,
        undefined,
        normalizeJiraErrorDetails(transitionNotAvailableDetailsSchema, {
          targetStatus: input.targetStatus,
          availableTransitions: transitions.transitions.map(toPublicTransition),
        }),
      );
    }

    if (candidates.length > 1) {
      throw new JiraClientError(
        JIRA_ERROR_CODE.TRANSITION_AMBIGUOUS,
        undefined,
        undefined,
        normalizeJiraErrorDetails(transitionAmbiguousDetailsSchema, {
          targetStatus: input.targetStatus,
          candidates: candidates.map(toPublicTransition),
        }),
      );
    }

    const transition = candidates[0]!;
    const requiredFields = Object.entries(transition.fields)
      .filter(([, field]) => field.required)
      .map(([id, field]) => ({
        id,
        name: field.name,
        hasDefaultValue: field.hasDefaultValue,
        schema: field.schema,
      }));
    if (requiredFields.length > 0) {
      throw new JiraClientError(
        JIRA_ERROR_CODE.TRANSITION_REQUIRES_FIELDS,
        undefined,
        undefined,
        normalizeJiraErrorDetails(transitionRequiresFieldsDetailsSchema, {
          transition: toPublicTransition(transition),
          requiredFields,
        }),
      );
    }

    await jiraClient.postJsonNoContent({
      pathname: `rest/api/2/issue/${encodeURIComponent(issue.key)}/transitions`,
      body: { transition: { id: transition.id } },
      notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
    });
    const executedTransition = { id: transition.id, name: transition.name };
    let verifiedIssue: z.infer<typeof jiraIssueStatusSchema>;
    try {
      verifiedIssue = await jiraClient.getJson({
        pathname: `rest/api/2/issue/${encodeURIComponent(issue.key)}`,
        query: { fields: "status" },
        schema: jiraIssueStatusSchema,
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      });
    } catch (cause) {
      throw new JiraClientError(
        JIRA_ERROR_CODE.TRANSITION_VERIFICATION_FAILED,
        undefined,
        cause,
        normalizeJiraErrorDetails(transitionVerificationFailedDetailsSchema, {
          issueKey: issue.key,
          previousStatus,
          expectedStatus: transition.to,
          transition: executedTransition,
          causeCode:
            cause instanceof JiraClientError ? cause.code : JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR,
        }),
      );
    }

    if (verifiedIssue.fields.status.id !== transition.to.id) {
      throw new JiraClientError(
        JIRA_ERROR_CODE.TRANSITION_STATUS_MISMATCH,
        undefined,
        undefined,
        normalizeJiraErrorDetails(transitionStatusMismatchDetailsSchema, {
          issueKey: issue.key,
          previousStatus,
          expectedStatus: transition.to,
          actualStatus: verifiedIssue.fields.status,
          transition: executedTransition,
        }),
      );
    }

    return outputSchema.parse({
      issueKey: issue.key,
      previousStatus,
      newStatus: verifiedIssue.fields.status,
      transition: executedTransition,
      changed: true,
    });
  }
}

export default ChangeIssueStatusTool;
