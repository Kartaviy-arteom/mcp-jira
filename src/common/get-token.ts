import { findCredentials } from "@napi-rs/keyring";
import { z } from "zod";

export const getToken = (): string => {
  const [jiraCredential] = findCredentials("mcp-jira", "keyring:jira-token@mcp-jira");
  return z.string().min(1, "Jira token is not configured").parse(jiraCredential?.password);
};
