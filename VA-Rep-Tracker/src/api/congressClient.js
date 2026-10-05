import axios from "axios";

const congressClient = axios.create({ timeout: 15_000 });

congressClient.interceptors.request.use((config) => {
  const congressPath = config.url;
  config.url = "/api/congress";
  config.params = { ...config.params, path: congressPath };
  return config;
});

congressClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const status = error.response.status;
      if (status === 429) {
        console.warn("[Congress] Rate limited — slow down requests");
      } else {
        console.error(`[Congress] HTTP ${status}`);
      }
    } else if (error.code === "ECONNABORTED") {
      console.error("[Congress] Request timed out");
    } else {
      console.error("[Congress] Network error", error.message);
    }
    return Promise.reject(error);
  },
);

export default congressClient;
