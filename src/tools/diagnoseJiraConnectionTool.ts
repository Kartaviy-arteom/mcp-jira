import { MCPTool } from "mcp-framework";
import { z } from "zod";
import { jiraClient } from "../jira/client.js";

const inputSchema = z.object({}).strict();

const outputSchema = z.object({
  configured: z.boolean(),
  credentialsFound: z.boolean(),
  reachable: z.boolean(),
  authenticationStatus: z.enum(["authenticated", "rejected", "unverified"]),
});

class DiagnoseJiraConnectionTool extends MCPTool {
  name = "diagnose-jira-connection";
  description = "Checks Jira configuration, credentials, reachability and authentication safely.";
  schema = inputSchema;
  protected outputSchemaShape = outputSchema;

  async execute() {
    const probe = await jiraClient.probe({ pathname: "rest/api/2/myself" });
    const result = {
      configured: probe.configured,
      credentialsFound: probe.credentialsFound,
      reachable: probe.status !== undefined,
      authenticationStatus: "unverified" as "authenticated" | "rejected" | "unverified",
    };

    if (probe.credentialsFound && probe.status !== undefined) {
      if (probe.status >= 200 && probe.status < 300) {
        result.authenticationStatus = "authenticated";
      } else if (probe.status === 401 || probe.status === 403) {
        result.authenticationStatus = "rejected";
      }
    }

    return outputSchema.parse(result);
  }
}

export default DiagnoseJiraConnectionTool;
