
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const client = new Client({
  name: "weather-demo-client",
  version: "1.0.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
});

async function main() {
  try {
    // Connect to the MCP server.
    await client.connect(transport);

    // Discover the server's tools.
    const { tools } = await client.listTools();

    console.log("\nDiscovered tools:");

    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description}`);
    }

    // Call the discovered tool directly.
    const result = await client.callTool({
      name: "get_weather",
      arguments: {
        city: process.argv[2] ?? "Bengaluru",
      },
    });

    console.log("\nWeather result:");

    for (const item of result.content ?? []) {
      if (item.type === "text") {
        console.log(item.text);
      }
    }

    if (result.isError) {
      console.error("The tool reported an error.");
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Client failed:", error);
  process.exitCode = 1;
});
