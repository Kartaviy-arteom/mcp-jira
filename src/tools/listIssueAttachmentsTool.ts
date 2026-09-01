import { MCPInput, MCPTool } from "mcp-framework";
import { z } from "zod";
import {
  getAttachmentId,
  jiraAttachmentSchema,
  supportedImageMimeTypeSchema,
} from "../jira/attachments.js";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";
import { issueKeySchema } from "../jira/schemas.js";

const inputSchema = z.object({ issueKey: issueKeySchema }).strict();

const attachmentSchema = z.object({
  id: z.string().describe("The numeric Jira attachment ID."),
  filename: z.string().describe("The attachment filename."),
  mimeType: z.string().describe("The attachment MIME type reported by Jira."),
  size: z.number().int().nonnegative().describe("The attachment size in bytes."),
  supported: z.boolean().describe("Whether this attachment is a supported image type."),
});

const outputSchema = z.object({
  attachments: z
    .array(attachmentSchema)
    .describe("Metadata for all attachments on the Jira issue."),
});

const jiraIssueSchema = z.object({
  fields: z.object({
    attachment: z.array(jiraAttachmentSchema),
  }),
});

class ListIssueAttachmentsTool extends MCPTool {
  name = "list-issue-attachments";
  description = "Lists Jira issue attachment metadata without downloading file content.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  async execute(input: MCPInput<this>) {
    try {
      const issue = await jiraClient.getJson({
        pathname: `rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
        query: { fields: "attachment" },
        schema: jiraIssueSchema,
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      });

      return outputSchema.parse({
        attachments: issue.fields.attachment.map((attachment) => ({
          id: getAttachmentId(attachment.self),
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          supported: supportedImageMimeTypeSchema.safeParse(attachment.mimeType).success,
        })),
      });
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default ListIssueAttachmentsTool;
