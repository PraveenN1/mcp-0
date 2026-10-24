import "dotenv/config";
import swagger from "@fastify/swagger";
import swaggerUI from "@fastify/swagger-ui";
import Fastify from "fastify";
import Groq from "groq-sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";


const app = Fastify({ logger: true });

await app.register(swagger, {
  openapi: {
    info: {
      title: "Weather Chatbot API",
      description: "Ask questions using Groq and MCP tools",
      version: "1.0.0",
    },
    servers: [{ url: "http://127.0.0.1:3000" }],
  },
});

await app.register(swaggerUI, {
  routePrefix: "/docs",
});


const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const mcpClient = new Client({
  name: "weather-chatbot-client",
  version: "1.0.0",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
});

let mcpTools = [];

function parseWeatherResult(result) {
  if (result.isError) {
    return null;
  }

  const text = (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  try {
    const weather = JSON.parse(text);

    if (
      typeof weather.city === "string" &&
      typeof weather.country === "string" &&
      typeof weather.temperatureC === "number" &&
      typeof weather.feelsLikeC === "number" &&
      typeof weather.humidityPercent === "number" &&
      typeof weather.windSpeedKmh === "number" &&
      typeof weather.precipitationMm === "number" &&
      typeof weather.condition === "string"
    ) {
      return weather;
    }
  } catch {
    // The tool may return a non-JSON error message.
  }

  return null;
}

// Execute one user's request using Groq + MCP.
async function answerQuestion(query) {
  const messages = [
    {
      role: "system",
      content:
        "You are a helpful assistant. Use available tools when needed. " +
        "Never invent weather data. Answer the user concisely using actual tool results.",
    },
    {
      role: "user",
      content: query,
    },
  ];

  const maxRounds = 5;
  let weather = null;

  for (let round = 0; round < maxRounds; round++) {
    // Ask Groq to answer or select a tool.
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools: mcpTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: "auto",
      temperature: 0.2,
    });

    const assistantMessage = completion.choices[0].message;

    messages.push(assistantMessage);

    // No tool call means Groq has generated its final answer.
    if (!assistantMessage.tool_calls?.length) {
      return {
        answer: assistantMessage.content || "",
        weather,
      };
    }

    // Execute each requested tool through MCP.
    for (const toolCall of assistantMessage.tool_calls) {
      const name = toolCall.function.name;

      const tool = mcpTools.find((item) => item.name === name);

      if (!tool) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Unknown tool: ${name}`,
        });
        continue;
      }

      let args;

      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Invalid JSON arguments supplied for the tool.",
        });
        continue;
      }

      app.log.info({ tool: name }, "Executing MCP tool");

      let output;

      try {
        const result = await mcpClient.callTool({
          name,
          arguments: args,
        });

        if (name === "get_weather") {
          weather = parseWeatherResult(result);
        }

        output = (result.content || [])
          .map((item) =>
            item.type === "text" ? item.text : JSON.stringify(item),
          )
          .join("\n");

        if (!output && result.structuredContent) {
          output = JSON.stringify(result.structuredContent);
        }

        if (result.isError) {
          output = `Tool error: ${output}`;
        }
      } catch (error) {
        output = `Tool execution failed: ${error.message}`;
      }

      // Feed the MCP result back to Groq.
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output || "The tool returned no content.",
      });
    }
  }

  throw new Error("Maximum tool-call rounds exceeded.");
}

// Chatbot API endpoint.
app.post(
  "/ask",
  {
    schema: {
      summary: "Ask the AI chatbot a question",
      description:
        "Accepts a natural-language query and returns the AI-generated answer.",
      tags: ["Chatbot"],
      body: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: "The user's question",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            answer: { type: "string" },
            weather: {
              type: ["object", "null"],
              properties: {
                city: { type: "string" },
                country: { type: "string" },
                temperatureC: { type: "number" },
                feelsLikeC: { type: "number" },
                humidityPercent: { type: "number" },
                windSpeedKmh: { type: "number" },
                precipitationMm: { type: "number" },
                condition: { type: "string" },
              },
              required: [
                "city",
                "country",
                "temperatureC",
                "feelsLikeC",
                "humidityPercent",
                "windSpeedKmh",
                "precipitationMm",
                "condition",
              ],
              additionalProperties: false,
            },
          },
          required: ["answer", "weather"],
        },
        400: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
        502: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const query = request.body.query.trim();

    if (!query) {
      return reply.code(400).send({
        error: "Query cannot be empty.",
      });
    }

    try {
      return await answerQuestion(query);
    } catch (error) {
      request.log.error({ err: error }, "Failed to answer question");

      return reply.code(502).send({
        error: "Unable to process your question right now.",
      });
    }
  },
);

async function start() {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing from .env");
  }

  // Connect once when the API starts, not on every request.
  await mcpClient.connect(transport);

  const discovered = await mcpClient.listTools();
  mcpTools = discovered.tools;

  app.log.info(
    { tools: mcpTools.map((tool) => tool.name) },
    "MCP tools discovered",
  );

  app.addHook("onClose", async () => {
    await mcpClient.close();
  });

  await app.listen({
    port: Number(process.env.PORT || 3000),
    host: "127.0.0.1",
  });
}

start().catch(async (error) => {
  app.log.error(error, "Application startup failed");

  try {
    await mcpClient.close();
  } catch {
    console.error("MCP client not connected. Please restart the server!");
  }

  process.exitCode = 1;
});
