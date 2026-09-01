import { z } from "zod";

export const issueKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
  .describe("Jira issue key, for example OMSAGORA-3520");
