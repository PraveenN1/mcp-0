
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

async function findCity(city) {
  const geoUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
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
  return geoData.results?.[0] ?? null;
}

server.registerTool(
  "get_weather",
  {
    description:
      "Get current weather and a next-24-hours rain forecast for a city. Use this for questions about weather, rain, precipitation, or forecasts.",
    inputSchema: {
      city: z.string().min(1).describe("Name of the city"),
    },
  },
  async ({ city }) => {
    try {
      // 1. Find the city's coordinates.
      const place = await findCity(city);

      if (!place) {
        return {
          content: [{
            type: "text",
            text: `City not found: ${city}`,
          }],
          isError: true,
        };
      }

      // 2. Fetch current weather and enough hourly data for the next 24 hours.
      const weatherUrl = new URL(
        "https://api.open-meteo.com/v1/forecast"
      );

      weatherUrl.search = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current:
          "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
        hourly: "precipitation_probability,precipitation",
        forecast_days: "2",
        timezone: "auto",
      });

      const weatherResponse = await fetch(weatherUrl);

      if (!weatherResponse.ok) {
        throw new Error("Weather service failed");
      }

      const weatherData = await weatherResponse.json();
      const current = weatherData.current;
      const currentHourIndex = Math.max(
        0,
        weatherData.hourly.time.findIndex((time) => time >= current.time),
      );
      const next24Hours = weatherData.hourly.time
        .slice(currentHourIndex, currentHourIndex + 24)
        .map((time, index) => ({
          time,
          precipitationMm:
            weatherData.hourly.precipitation[currentHourIndex + index],
          precipitationProbabilityPercent:
            weatherData.hourly.precipitation_probability[
              currentHourIndex + index
            ],
        }));
      const totalPrecipitationMm = next24Hours.reduce(
        (total, hour) => total + hour.precipitationMm,
        0,
      );

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
        rainForecast: {
          periodStart: next24Hours[0]?.time ?? current.time,
          periodEnd: next24Hours.at(-1)?.time ?? current.time,
          willRain: next24Hours.some((hour) => hour.precipitationMm > 0),
          maxPrecipitationProbabilityPercent: Math.max(
            0,
            ...next24Hours.map((hour) => hour.precipitationProbabilityPercent),
          ),
          totalPrecipitationMm,
        },
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
