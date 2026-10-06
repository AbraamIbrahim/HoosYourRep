import assert from "node:assert/strict";
import process from "node:process";
import { afterEach, beforeEach, test } from "node:test";
import handler from "../api/refresh.js";

const environmentNames = [
  "CRON_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];
let originalEnvironment;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  environmentNames.forEach((name) => delete process.env[name]);
});

afterEach(() => {
  environmentNames.forEach((name) => {
    if (originalEnvironment[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnvironment[name];
    }
  });
});

function makeResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

async function invoke(request) {
  const response = makeResponse();
  await handler(request, response);
  return response;
}

test("returns 500 when CRON_SECRET is not configured", async () => {
  const response = await invoke({
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    ok: false,
    error: "Server configuration error",
  });
});

test("returns 401 when the authorization header is missing", async () => {
  process.env.CRON_SECRET = "test-token";
  const response = await invoke({ method: "GET", headers: {} });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { ok: false, error: "Unauthorized" });
});

test("returns 401 when the authorization token is incorrect", async () => {
  process.env.CRON_SECRET = "test-token";
  const response = await invoke({
    method: "GET",
    headers: { authorization: "Bearer wrong-token" },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { ok: false, error: "Unauthorized" });
});

test("returns 405 for DELETE with a valid token", async () => {
  process.env.CRON_SECRET = "test-token";
  const response = await invoke({
    method: "DELETE",
    headers: { authorization: "Bearer test-token" },
  });

  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, "GET, POST");
  assert.deepEqual(response.body, {
    ok: false,
    error: "Method not allowed",
  });
});

test("returns 400 when limit exceeds the supported maximum", async () => {
  process.env.CRON_SECRET = "test-token";
  const response = await invoke({
    method: "GET",
    headers: { authorization: "Bearer test-token" },
    query: { limit: "99" },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /limit must be an integer/);
});

test("returns 500 when Supabase configuration is missing after valid auth", async () => {
  process.env.CRON_SECRET = "test-token";
  const response = await invoke({
    method: "GET",
    headers: { authorization: "Bearer test-token" },
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    ok: false,
    error: "Server configuration error",
  });
});
