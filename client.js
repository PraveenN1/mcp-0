import "dotenv/config";
import Groq from "groq-sdk";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const WEATHER_QUERY_PATTERN = /\b(weather|rain|precipitation|forecast)\b/i;

const mcpClient = new Client({
  name: "weather-ai-client",
  version: "1.0.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
});

async function main() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Missing GROQ_API_KEY in .env");
  }

  try {
    // 1. Connect to the MCP server.
    await mcpClient.connect(transport);

    // 2. Discover available MCP tools.
    const { tools: mcpTools } = await mcpClient.listTools();

    console.log("Discovered MCP tools:", mcpTools.map(t => t.name));

    // 3. Convert MCP tool definitions into Groq tool definitions.
    const groqTools = mcpTools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema,
      },
    }));

    // 4. Get the user's natural-language request.
    const query =
      process.argv.slice(2).join(" ") ||
      "What's the current weather in Bengaluru?";
    const requiresWeatherTool = WEATHER_QUERY_PATTERN.test(query);

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful weather assistant. " +
          "Use get_weather for current weather, rain, precipitation, and forecast questions. " +
          "Never invent live weather data. Answer concisely using tool results.",
      },
      {
        role: "user",
        content: query,
      },
    ];

    // 5. Let the LLM choose tools and handle tool results.
    const MAX_ROUNDS = 5;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await groq.chat.completions.create({
        model: MODEL,
        messages,
        tools: groqTools,
        tool_choice: round === 0 && requiresWeatherTool
          ? { type: "function", function: { name: "get_weather" } }
          : "auto",
        temperature: 0.2,
      });

      const assistantMessage = completion.choices[0].message;

      // Preserve the assistant's response, including tool calls.
      messages.push(assistantMessage);

      // No tool calls means the model has produced its final answer.
      if (!assistantMessage.tool_calls?.length) {
        console.log("\nAssistant:", assistantMessage.content);
        return;
      }

      // 6. Execute each requested tool through the MCP client.
      for (const toolCall of assistantMessage.tool_calls) {
        const name = toolCall.function.name;

        let args;

        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Error: Invalid JSON arguments.",
          });
          continue;
        }

        const tool = mcpTools.find(item => item.name === name);

        if (!tool) {
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: Unknown tool "${name}".`,
          });
          continue;
        }

        console.log(`\nLLM selected tool: ${name}`);
        console.log("Arguments:", args);

        let toolOutput;

        try {
          const result = await mcpClient.callTool({
            name,
            arguments: args,
          });

          toolOutput = (result.content || [])
            .map(item =>
              item.type === "text"
                ? item.text
                : JSON.stringify(item)
            )
            .join("\n");

          if (result.isError) {
            toolOutput = `Tool error: ${toolOutput}`;
          }

          if (!toolOutput && result.structuredContent) {
            toolOutput = JSON.stringify(result.structuredContent);
          }
        } catch (error) {
          toolOutput = `Tool execution failed: ${error.message}`;
        }

        // 7. Return the tool result to Groq.
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput || "The tool returned no content.",
        });
      }

      // The loop continues, allowing the LLM to process tool results.
    }

    throw new Error("Maximum tool-call rounds exceeded.");
  } finally {
    await mcpClient.close();
  }
}

main().catch(error => {
  console.error("Application failed:", error.message);
  process.exitCode = 1;
});
