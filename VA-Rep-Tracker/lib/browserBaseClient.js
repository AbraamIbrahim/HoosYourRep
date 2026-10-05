import Browserbase from "@browserbasehq/sdk";

// Func to create a browser base client instance for agentic web scraping
export function createBrowserbaseClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("A Browserbase API key is required");
  }

  return new Browserbase({ apiKey: apiKey.trim(), maxRetries: 0 });
}