
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({
  name: "weather-mcp-server",
  version: "1.0.0",
});

const weatherDescriptions = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  80: "Rain showers",
  81: "Moderate rain showers",
  82: "Heavy rain showers",
  95: "Thunderstorm",
};

server.registerTool(
  "get_weather",
  {
    description:
      "Get the current weather for a city. Use this when the user asks about current weather conditions.",
    inputSchema: {
      city: z.string().min(1).describe("Name of the city"),
    },
  },
  async ({ city }) => {
    try {
      // 1. Find the city's coordinates.
      const geoUrl = new URL(
        "https://geocoding-api.open-meteo.com/v1/search"
      );

      geoUrl.search = new URLSearchParams({
        name: city,
        count: "1",
        language: "en",
        format: "json",
      });

      const geoResponse = await fetch(geoUrl);

      if (!geoResponse.ok) {
        throw new Error("City lookup service failed");
      }

      const geoData = await geoResponse.json();
      const place = geoData.results?.[0];

      if (!place) {
        return {
          content: [{
            type: "text",
            text: `City not found: ${city}`,
          }],
          isError: true,
        };
      }

      // 2. Fetch the current weather.
      const weatherUrl = new URL(
        "https://api.open-meteo.com/v1/forecast"
      );

      weatherUrl.search = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current:
          "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
        timezone: "auto",
      });

      const weatherResponse = await fetch(weatherUrl);

      if (!weatherResponse.ok) {
        throw new Error("Weather service failed");
      }

      const weatherData = await weatherResponse.json();
      const current = weatherData.current;

      // 3. Return the result through MCP.
      const result = {
        city: place.name,
        country: place.country,
        temperatureC: current.temperature_2m,
        feelsLikeC: current.apparent_temperature,
        humidityPercent: current.relative_humidity_2m,
        windSpeedKmh: current.wind_speed_10m,
        precipitationMm: current.precipitation,
        condition:
          weatherDescriptions[current.weather_code] ??
          "Unknown conditions",
      };

      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Weather lookup failed: ${error.message}`,
        }],
        isError: true,
      };
    }
  }
);

serveStdio(() => server);
