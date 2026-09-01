import { MCPInput, MCPTool, ToolResponse } from "mcp-framework";
import { z } from "zod";
import {
  getAttachmentId,
  isAttachmentContentPathname,
  jiraAttachmentWithContentSchema,
  supportedImageMimeTypeSchema,
} from "../jira/attachments.js";
import { JIRA_ERROR_CODE, JiraClientError, jiraClient } from "../jira/client.js";
import { issueKeySchema } from "../jira/schemas.js";

const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

const inputSchema = z
  .object({
    issueKey: issueKeySchema,
    attachmentId: z.string().regex(/^\d+$/).describe("The numeric Jira attachment ID to download."),
  })
  .strict();

const outputSchema = z.object({
  issueKey: issueKeySchema.describe("The normalized Jira issue key."),
  attachmentId: z.string().describe("The numeric Jira attachment ID."),
  filename: z.string().describe("The attachment filename."),
  mimeType: supportedImageMimeTypeSchema.describe("The canonical image MIME type."),
  size: z.number().int().nonnegative().describe("The attachment size reported by Jira in bytes."),
});

const downloadResultSchema = z.object({
  data: z.string(),
  mimeType: supportedImageMimeTypeSchema,
  metadata: outputSchema,
});

const jiraIssueSchema = z.object({
  fields: z.object({
    attachment: z.array(jiraAttachmentWithContentSchema),
  }),
});

const readBytes = async (response: Response): Promise<Uint8Array> => {
  const contentLength = response.headers.get("Content-Length");
  if (/^\d+$/.test(contentLength ?? "") && Number(contentLength) > MAX_ATTACHMENT_SIZE) {
    await response.body?.cancel();
    throw new JiraClientError(JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE);
  }

  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ATTACHMENT_SIZE) {
      await reader.cancel();
      throw new JiraClientError(JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const hasSignature = (
  mimeType: z.infer<typeof supportedImageMimeTypeSchema>,
  bytes: Uint8Array,
) => {
  if (mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    );
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
};

class GetIssueAttachmentTool extends MCPTool {
  name = "get-issue-attachment";
  description = "Safely downloads a supported image attachment belonging to a Jira issue.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  protected createSuccessResponse(data: unknown): ToolResponse {
    const result = downloadResultSchema.parse(data);
    return {
      content: [{ type: "image", data: result.data, mimeType: result.mimeType }],
      structuredContent: result.metadata,
    };
  }

  async execute(input: MCPInput<this>) {
    try {
      const issue = await jiraClient.getJson({
        pathname: `rest/api/2/issue/${encodeURIComponent(input.issueKey)}`,
        query: { fields: "attachment" },
        schema: jiraIssueSchema,
        notFoundCode: JIRA_ERROR_CODE.ISSUE_NOT_FOUND,
      });
      const attachment = issue.fields.attachment.find(
        (candidate) => getAttachmentId(candidate.self) === input.attachmentId,
      );
      if (attachment === undefined) {
        throw new JiraClientError(JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND);
      }
      const mimeType = supportedImageMimeTypeSchema.safeParse(attachment.mimeType);
      if (!mimeType.success) {
        throw new JiraClientError(JIRA_ERROR_CODE.UNSUPPORTED_ATTACHMENT_TYPE);
      }
      if (attachment.size > MAX_ATTACHMENT_SIZE) {
        throw new JiraClientError(JIRA_ERROR_CODE.ATTACHMENT_TOO_LARGE);
      }

      const pathname = jiraClient.getInternalPathname(attachment.content);
      if (!isAttachmentContentPathname(pathname, input.attachmentId)) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }

      const response = await jiraClient.getBinary({
        pathname,
        notFoundCode: JIRA_ERROR_CODE.ATTACHMENT_NOT_FOUND,
      });
      const responseMimeType = response.headers
        .get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (responseMimeType !== mimeType.data) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }

      const bytes = await readBytes(response);
      if (!hasSignature(mimeType.data, bytes)) {
        throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
      }

      return {
        data: Buffer.from(bytes).toString("base64"),
        mimeType: mimeType.data,
        metadata: {
          issueKey: input.issueKey,
          attachmentId: input.attachmentId,
          filename: attachment.filename,
          mimeType: mimeType.data,
          size: attachment.size,
        },
      };
    } catch (cause) {
      if (cause instanceof JiraClientError) throw cause;
      throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
    }
  }
}

export default GetIssueAttachmentTool;
