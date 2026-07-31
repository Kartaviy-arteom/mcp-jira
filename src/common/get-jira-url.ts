import { z } from "zod";

export const getJiraUrl = (): string =>
  z.string().min(1, "JIRA_URL is required").parse(process.env.JIRA_URL);
