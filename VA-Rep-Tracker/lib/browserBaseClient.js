// Browserbase client factory
// Keeps server-side browser setup in one place and rejects missing credentials
// before a scraping request tries to create a remote session.
import Browserbase from "@browserbasehq/sdk";

// Creates a Browserbase SDK client with retries disabled so the scraper can
// apply its own bounded retry policy and avoid duplicate remote requests.
export function createBrowserbaseClient(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("A Browserbase API key is required");
  }

  return new Browserbase({ apiKey: apiKey.trim(), maxRetries: 0 });
}