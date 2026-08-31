import { MCPServer } from "mcp-framework";
import dotenv from "dotenv";

dotenv.config({
  path: new URL("../.env", import.meta.url),
  quiet: true,
});

const server = new MCPServer();
server.start().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
