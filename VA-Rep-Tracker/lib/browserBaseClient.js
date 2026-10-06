// Creates the server-side Browserbase client used to scrape campaign websites.
import Browserbase from "@browserbasehq/sdk";

// Func to create a browser base client instance for agentic web scraping
// Rejects missing credentials before constructing a client.
export function createBrowserbaseClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("A Browserbase API key is required");
  }

  return new Browserbase({ apiKey: apiKey.trim(), maxRetries: 0 });
}