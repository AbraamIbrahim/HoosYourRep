import { Buffer } from "node:buffer";
import process from "node:process";
import { analyzePromises } from "../lib/analyzePromises.js";

const MAX_REQUEST_BYTES = 100_000;
const MAX_PROMISES = 20;
const MAX_BILLS = 50;
const MAX_MEMBER_NAME_LENGTH = 200;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isText(value, maximumLength) {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximumLength;
}

function validateAnalysisInput(body) {
  if (!isRecord(body) || !isRecord(body.member)) return false;
  if (
    !isText(body.member.name, MAX_MEMBER_NAME_LENGTH) ||
    !isText(body.member.party, 100) ||
    !["house", "senate"].includes(body.member.chamber)
  ) {
    return false;
  }
  if (
    body.member.chamber === "house" &&
    !isText(String(body.member.district ?? ""), 20)
  ) {
    return false;
  }
  if (
    !Array.isArray(body.promises) ||
    body.promises.length < 1 ||
    body.promises.length > MAX_PROMISES ||
    !body.promises.every(
      (promise) =>
        isRecord(promise) &&
        isText(promise.topic, 200) &&
        isText(promise.text, 2_000),
    )
  ) {
    return false;
  }
  return (
    Array.isArray(body.bills) &&
    body.bills.length <= MAX_BILLS &&
    body.bills.every(
      (bill) =>
        isRecord(bill) &&
        isText(String(bill.type ?? ""), 20) &&
        isText(String(bill.number ?? ""), 30) &&
        isText(bill.title, 1_000),
    )
  );
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  if (!process.env.GEMINI_API_KEY) {
    return response.status(500).json({ error: "Gemini API is not configured" });
  }

  const body = request.body;
  if (
    Buffer.byteLength(JSON.stringify(body ?? null), "utf8") > MAX_REQUEST_BYTES ||
    !validateAnalysisInput(body)
  ) {
    return response.status(400).json({ error: "Invalid analysis request" });
  }

  try {
    const analysis = await analyzePromises(
      body.member,
      body.promises,
      body.bills,
    );
    return response.status(200).json(analysis);
  } catch {
    return response.status(502).json({ error: "Gemini analysis request failed" });
  }
}
