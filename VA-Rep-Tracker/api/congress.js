import axios from "axios";
import process from "node:process";

const CONGRESS_API_BASE_URL = "https://api.congress.gov/v3";
const CONGRESS_API_TIMEOUT_MS = 10_000;
const ALLOWED_QUERY_PARAMETERS = new Set([
  "congress",
  "currentMember",
  "limit",
]);

function getSingleQueryValue(value, name) {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${name} parameter`);
  }
  return value;
}

function isAllowedPath(path) {
  return (
    path === "/member/VA" ||
    /^\/member\/VA\/(?:[1-9]|1[01])$/.test(path) ||
    /^\/member\/[A-Z][A-Z0-9]{5,8}\/(?:sponsored|cosponsored)-legislation$/.test(
      path,
    ) ||
    path === "/bill" ||
    /^\/bill\/\d{1,3}\/[A-Z]{2,10}\/\d+\/summaries$/.test(path)
  );
}

function getAllowedParameters(query, path) {
  const parameters = {};
  for (const [name, value] of Object.entries(query)) {
    if (name === "path") continue;
    if (!ALLOWED_QUERY_PARAMETERS.has(name)) {
      throw new Error(`Unsupported Congress.gov parameter: ${name}`);
    }
    const parameterValue = getSingleQueryValue(value, name);
    if (name === "limit") {
      const limit = Number(parameterValue);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("limit must be an integer between 1 and 50");
      }
    } else if (name === "congress") {
      const congress = Number(parameterValue);
      if (!Number.isInteger(congress) || congress < 1 || congress > 200) {
        throw new Error("Invalid congress parameter");
      }
    } else if (parameterValue !== "true" && parameterValue !== "false") {
      throw new Error("currentMember must be true or false");
    }
    parameters[name] = parameterValue;
  }

  if (path.startsWith("/member/VA")) {
    parameters.currentMember ??= "true";
    parameters.limit ??= "50";
  } else if (path.includes("sponsored-legislation")) {
    parameters.limit ??= "50";
  } else if (path === "/bill") {
    parameters.congress ??= "119";
    parameters.limit ??= "50";
  } else if (path.endsWith("/summaries")) {
    parameters.limit ??= "1";
  }

  return parameters;
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  let path;
  let parameters;
  try {
    path = getSingleQueryValue(request.query?.path, "path");
    if (!isAllowedPath(path)) {
      return response.status(400).json({ error: "Unsupported Congress.gov path" });
    }
    parameters = getAllowedParameters(request.query ?? {}, path);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }

  const congressApiKey = process.env.CONGRESS_API_KEY;
  if (!congressApiKey) {
    return response.status(500).json({ error: "Congress.gov API is not configured" });
  }

  try {
    const upstreamResponse = await axios.get(
      `${CONGRESS_API_BASE_URL}${path}`,
      {
        params: {
          ...parameters,
          format: "json",
          api_key: congressApiKey,
        },
        timeout: CONGRESS_API_TIMEOUT_MS,
      },
    );
    return response.status(200).json(upstreamResponse.data);
  } catch (error) {
    const status = error.response?.status;
    return response.status(status && status >= 400 && status < 500 ? status : 502)
      .json({ error: "Congress.gov request failed" });
  }
}
