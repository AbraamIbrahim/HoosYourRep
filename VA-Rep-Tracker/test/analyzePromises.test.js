import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnalysisPrompt,
  validateAndNormalizeAnalysis,
} from "../lib/analyzePromises.js";

const promises = [
  { topic: "Health", text: "Support health care access." },
  { topic: "Housing", text: "Expand affordable housing." },
];

const bills = [
  {
    type: "HR",
    number: "7992",
    title: "Example House bill",
    relationship: "sponsor",
  },
  {
    type: "HCONRES",
    number: "62",
    title: "Example concurrent resolution",
    relationship: "cosponsor",
  },
];

test("analysis prompt labels bill relationships and explains evidence limitations", () => {
  const prompt = createAnalysisPrompt(
    { name: "Example Member", chamber: "senate", party: "Independent" },
    promises,
    bills,
  );

  assert.match(prompt, /\[SPONSORED\] HR 7992: Example House bill/);
  assert.match(
    prompt,
    /\[COSPONSORED\] HCONRES 62: Example concurrent resolution/,
  );
  assert.match(prompt, /promiseNumber/);
  assert.match(prompt, /sponsorship as stronger evidence of commitment/);
  assert.match(prompt, /bill title alone does not prove that the bill passed/);
});

test("analysis links numbered promises to canonical database promise text", () => {
  const normalizedAnalysis = validateAndNormalizeAnalysis(
    {
      score: 75,
      breakdown: [
        {
          promiseNumber: 2,
          promiseTopic: "model echo",
          promiseText: "model echo",
          correlatingBills: [
            "HR 7992",
            "62",
            "HRES 62",
            "hr 7992",
            "HCONRES 62",
          ],
          reasoning: "The cosponsored bill is relevant.",
        },
        {
          promiseNumber: 1,
          promiseTopic: "different echo",
          promiseText: "different echo",
          correlatingBills: ["HR 7992"],
          reasoning: "The sponsored bill is relevant.",
        },
      ],
    },
    promises,
    bills,
  );

  assert.deepEqual(normalizedAnalysis.breakdown, [
    {
      promisePosition: 1,
      promiseTopic: "Housing",
      promiseText: "Expand affordable housing.",
      correlatingBills: ["HR 7992", "HCONRES 62"],
      reasoning: "The cosponsored bill is relevant.",
    },
    {
      promisePosition: 0,
      promiseTopic: "Health",
      promiseText: "Support health care access.",
      correlatingBills: ["HR 7992"],
      reasoning: "The sponsored bill is relevant.",
    },
  ]);
});

test("analysis rejects missing, non-integer, and out-of-range promise numbers", () => {
  for (const promiseNumber of [undefined, 0, 3, 1.5, "1"]) {
    assert.throws(
      () =>
        validateAndNormalizeAnalysis(
          {
            score: 75,
            breakdown: [
              {
                promiseNumber,
                reasoning: "Reason",
                correlatingBills: [],
              },
            ],
          },
          promises,
          bills,
        ),
      /invalid analysis breakdown entry/,
    );
  }
});

test("analysis rejects duplicate promise numbers", () => {
  assert.throws(
    () =>
      validateAndNormalizeAnalysis(
        {
          score: 75,
          breakdown: [
            {
              promiseNumber: 1,
              reasoning: "First",
              correlatingBills: [],
            },
            {
              promiseNumber: 1,
              reasoning: "Duplicate",
              correlatingBills: [],
            },
          ],
        },
        promises,
        bills,
      ),
    /duplicate promise numbers/,
  );
});
