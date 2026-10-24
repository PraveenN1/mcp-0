# Weather MCP Chatbot

An HTTP weather chatbot built with Fastify, Groq, and the Model Context Protocol (MCP). It accepts a natural-language question at `POST /ask`, lets the model select the available MCP tool, and returns both a display-ready answer and structured weather data.

## Architecture

```text
HTTP client
    |
    | POST /ask { "query": "What is the weather in Bengaluru?" }
    v
api.js (Fastify API, port 3000)
    |
    | Groq tool-calling request
    v
Groq model
    |
    | get_weather({ city }) over MCP stdio
    v
server.js (MCP server)
    |
    +--> Open-Meteo geocoding API
    |
    +--> Open-Meteo forecast API
    |
    v
api.js returns { answer, weather }
```

`api.js` starts `server.js` as a child process over MCP stdio, discovers its tools once during startup, and keeps that MCP connection for subsequent requests. `server.js` owns weather lookup and data normalization; it does not expose an HTTP port. `client.js` is a command-line example/smoke test of the same Groq-to-MCP tool-calling flow.

## Prerequisites

- Node.js 20 or newer
- A [Groq API key](https://console.groq.com/keys)
- Internet access to Groq and the Open-Meteo APIs

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```dotenv
GROQ_API_KEY=your_groq_api_key
# Optional. Defaults to openai/gpt-oss-20b.
GROQ_MODEL=openai/gpt-oss-20b
# Optional. Defaults to 3000.
PORT=3000
```

Never commit `.env` or its API key.

## Run the HTTP API

Start the API:

```bash
node api.js
```

The server listens on `http://127.0.0.1:3000` by default. Interactive API documentation is available at `http://127.0.0.1:3000/docs`.

Call the endpoint:

```bash
curl -X POST http://127.0.0.1:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"What is the weather in Bengaluru?"}'
```

Example successful response:

```json
{
  "answer": "Bengaluru is currently experiencing moderate rain showers.",
  "weather": {
    "city": "Bengaluru",
    "country": "India",
    "temperatureC": 19.9,
    "feelsLikeC": 23,
    "humidityPercent": 98,
    "windSpeedKmh": 2.7,
    "precipitationMm": 1,
    "condition": "Moderate rain showers"
  }
}
```

`answer` is model-generated text for presentation. Use `weather` for programmatic consumers. It is `null` if no valid `get_weather` tool result was returned (for example, for a non-weather question or an unsuccessful lookup).

### API contract

`POST /ask`

Request body:

```json
{ "query": "What is the weather in Bengaluru?" }
```

Constraints:

- `query` is required.
- It must be a non-empty string after trimming whitespace.
- Maximum length: 2,000 characters.

Responses:

- `200 OK`: `{ "answer": string, "weather": Weather | null }`
- `400 Bad Request`: invalid JSON, a missing query, or an empty query
- `502 Bad Gateway`: Groq, MCP, or weather-processing failure

The structured `Weather` object contains `city`, `country`, `temperatureC`, `feelsLikeC`, `humidityPercent`, `windSpeedKmh`, `precipitationMm`, and `condition`.

## Run the command-line client

`client.js` is optional at runtime. It is useful for manually verifying MCP discovery and tool calling without the HTTP layer:

```bash
node client.js "What's the current weather in Bengaluru?"
```

Without an argument, it uses Bengaluru as its default query.

## Components

| File | Responsibility |
| --- | --- |
| `api.js` | Fastify API, OpenAPI/Swagger UI, Groq orchestration, MCP client, and HTTP response shaping. |
| `server.js` | MCP `get_weather` tool; geocodes a city and fetches/normalizes current weather from Open-Meteo. |
| `client.js` | Standalone terminal client for the Groq + MCP flow. |

## Troubleshooting

- **`GROQ_API_KEY is missing from .env`**: add a valid key to `.env` and restart the process.
- **`EADDRINUSE` on port 3000**: stop the process already using the port or set a different `PORT` value in `.env`.
- **`weather: null`**: inspect the API logs; the model may not have selected `get_weather`, the city may not exist, or an upstream service may have failed.
