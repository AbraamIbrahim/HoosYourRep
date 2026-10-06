// Builds and validates the model request used to link campaign promises to bills.
import axios from "axios";
import process from "node:process";

const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GEMINI_REQUEST_TIMEOUT_MS = 20_000;

// Separates model reasoning text from normal response text.
function getTextParts(parts, isThinking) {
  return parts
    .filter(
      (part) =>
        typeof part.text === "string" &&
        (part.thought === true) === isThinking,
    )
    .map((part) => part.text);
}

// Parses model JSON while accepting responses wrapped in Markdown fences.
function parseJsonResponse(responseText) {
  const normalizedText = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(normalizedText);
  } catch {
    throw new Error("Gemini returned an unparseable JSON analysis");
  }
}

// Formats a bill identifier consistently with Congress.gov legislation records.
function getBillIdentifier(bill) {
  return `${bill.type.toUpperCase()} ${bill.number}`;
}

// Creates instructions that give the model numbered promises and labeled bills.
export function createAnalysisPrompt(member, promises, bills) {
  const memberDescription =
    member.chamber === "senate"
      ? `Senator for Virginia (${member.party})`
      : `District ${member.district}, Virginia (${member.party})`;
  const promiseDescriptions = promises
    .map(
      (promise, positionIndex) =>
        `${positionIndex + 1}. ${promise.topic}: ${promise.text}`,
    )
    .join("\n");
  const billDescriptions = bills
    .map((bill) => {
      const label =
        bill.relationship === "cosponsor" ? "COSPONSORED" : "SPONSORED";
      return `[${label}] ${getBillIdentifier(bill)}: ${bill.title}`;
    })
    .join("\n");

  return `
You are analyzing how well a political representative's stated campaign promises align with bills they sponsored or cosponsored.

Representative: ${member.name} (${memberDescription})

Campaign Promises (numbered):
${promiseDescriptions}

Bills (relationship, identifier, and title):
${billDescriptions || "(No bills found)"}

Return ONLY a raw JSON object (no markdown, no code fences) in this exact shape:
{
  "score": <integer 0-100>,
  "breakdown": [
    {
      "promiseNumber": <1-based number from the numbered promise list>,
      "promiseTopic": "<topic from promise>",
      "promiseText": "<full promise text>",
      "correlatingBills": ["<TYPE NUMBER identifier>"],
      "reasoning": "<one or two sentence explanation>"
    }
  ]
}

For each campaign promise, set promiseNumber to its exact 1-based number from the numbered list. List only bill identifiers from the Bills list that best correlate to it. Cite each bill in exactly the format "TYPE NUMBER" shown in the list (for example, "HR 7992" or "HCONRES 62"); do not cite a bare number. A bill may appear under multiple promises. If no bills correlate, use an empty array. Do not include bill objects or invent identifiers.

Treat sponsorship as stronger evidence of commitment than cosponsorship. A bill title alone does not prove that the bill passed or that its goals were achieved.
`;
}

// Validates model promise references and replaces echoed promise text with DB data.
export function validateAndNormalizeAnalysis(parsedAnalysis, promises, bills) {
  const numericScore = Number(parsedAnalysis?.score);
  if (!Number.isFinite(numericScore)) {
    throw new Error("Gemini analysis did not include a valid numeric score");
  }
  if (!Array.isArray(parsedAnalysis.breakdown)) {
    throw new Error("Gemini analysis did not include a valid breakdown");
  }

  const validBillIdentifiers = new Set(bills.map(getBillIdentifier));
  const seenPromisePositions = new Set();
  const breakdown = parsedAnalysis.breakdown.map((breakdownEntry) => {
    if (
      !breakdownEntry ||
      !Number.isInteger(breakdownEntry.promiseNumber) ||
      breakdownEntry.promiseNumber < 1 ||
      breakdownEntry.promiseNumber > promises.length ||
      typeof breakdownEntry.reasoning !== "string" ||
      !Array.isArray(breakdownEntry.correlatingBills)
    ) {
      throw new Error("Gemini returned an invalid analysis breakdown entry");
    }

    const promisePosition = breakdownEntry.promiseNumber - 1;
    if (seenPromisePositions.has(promisePosition)) {
      throw new Error("Gemini returned duplicate promise numbers");
    }
    seenPromisePositions.add(promisePosition);

    const promise = promises[promisePosition];
    return {
      promisePosition,
      promiseTopic: promise.topic,
      promiseText: promise.text,
      correlatingBills: breakdownEntry.correlatingBills
        .filter((billIdentifier) => typeof billIdentifier === "string")
        .filter((billIdentifier) =>
          validBillIdentifiers.has(billIdentifier),
        ),
      reasoning: breakdownEntry.reasoning,
    };
  });

  return {
    score: Math.max(0, Math.min(100, Math.trunc(numericScore))),
    breakdown,
  };
}

// Calls Gemini, parses its response, and returns normalized analysis.
export async function analyzePromises(member, promises, bills) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  let response;
  try {
    response = await axios.post(
      GEMINI_API_URL,
      {
        contents: [
          {
            parts: [{ text: createAnalysisPrompt(member, promises, bills) }],
          },
        ],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 1024 },
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey,
        },
        timeout: GEMINI_REQUEST_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const responseStatus = error.response?.status;
    throw new Error(
      responseStatus
        ? `Gemini analysis request failed (HTTP ${responseStatus})`
        : "Gemini analysis request failed",
    );
  }

  const responseParts = response.data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(responseParts)) {
    throw new Error("Gemini response did not contain candidate content");
  }

  const thinking = getTextParts(responseParts, true).join("\n");
  const responseText = getTextParts(responseParts, false).join("\n");
  if (!responseText.trim()) {
    throw new Error("Gemini response did not contain analysis text");
  }

  const parsedAnalysis = parseJsonResponse(responseText);
  const normalizedAnalysis = validateAndNormalizeAnalysis(
    parsedAnalysis,
    promises,
    bills,
  );

  return {
    ...normalizedAnalysis,
    thinking,
  };
}
