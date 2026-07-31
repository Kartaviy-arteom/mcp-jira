import { MCPInput, MCPTool } from "mcp-framework";
import dotenv from "dotenv";
import { z } from "zod";
import { getJiraUrl } from "../common/get-jira-url.js";
import { getToken } from "../common/get-token.js";

dotenv.config({
  path: new URL("../../.env", import.meta.url),
  quiet: true,
});

const token = getToken();
const url = getJiraUrl();

const inputSchema = z.object({
  issueKey: z.string().min(1).describe("The Jira release ID used to find tasks assigned to the release."),
});

const taskSchema = z.object({
  id: z.string().describe("The unique internal numeric ID of the Jira task (e.g., '10024')."),
  key: z.string().describe("The visible project-specific task key (e.g., 'OMSAGORA-3520')."),
  summary: z.string().describe("The short title or summary describing the core goal of the task."),
  description: z.string().describe("Detailed technical and business description of the task."),
});

const outputSchema = z.array(taskSchema).describe("The tasks assigned to the Jira release.");

const jiraSearchResponseSchema = z.object({
  issues: z.array(z.object({
    id: z.string(),
    key: z.string(),
    fields: z.object({
      summary: z.string(),
      description: z.string().nullable(),
    }),
  })),
});

class GetReleaseTasksTool extends MCPTool {
  name = "get-release-tasks";
  description = "Get a list of Jira tasks by release ID.";
  schema = inputSchema;

  async execute(input: MCPInput<this>) {
    try {
      const response = await fetch(
        `${url}/rest/api/2/search?jql=fixVersion=${input.issueKey}&startAt=0&maxResults=500&fields=summary,status,description`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        },
      );

      if (!response.ok) {
        throw new Error("Failed to execute Jira release tasks tool.");
      }

      const { issues } = jiraSearchResponseSchema.parse(await response.json());

      return outputSchema.parse(issues.map((task) => ({
        id: task.id,
        key: task.key,
        summary: task.fields?.summary,
        description: task.fields?.description ?? "",
      })));
    } catch {
      throw new Error("Failed to execute Jira release tasks tool.");
    }
  }
}

export default GetReleaseTasksTool;
