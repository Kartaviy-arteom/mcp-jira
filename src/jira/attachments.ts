import { z } from "zod";
import { JIRA_ERROR_CODE, JiraClientError } from "./client.js";
import { parseSafeHttpUrl } from "./urls.js";

export const jiraAttachmentSchema = z.object({
  self: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
});

export const jiraAttachmentWithContentSchema = jiraAttachmentSchema.extend({
  content: z.string(),
});

export const supportedImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

export const isAttachmentContentPathname = (pathname: string, attachmentId: string): boolean =>
  pathname === `attachments/${attachmentId}` ||
  pathname.match(/^secure\/attachment\/(\d+)\/[^/]+$/)?.[1] === attachmentId;

export const getAttachmentId = (self: string): string => {
  let url: URL;
  try {
    url = parseSafeHttpUrl(self);
  } catch (cause) {
    throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR, undefined, cause);
  }

  const match = url.pathname.match(/\/rest\/api\/(?:2|2\.0)\/attachments?\/(\d+)\/?$/);
  if (match?.[1] === undefined) {
    throw new JiraClientError(JIRA_ERROR_CODE.RESPONSE_FORMAT_ERROR);
  }

  return match[1];
};
