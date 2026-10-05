import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnalysisPrompt,
  validateAndNormalizeAnalysis,
} from "../lib/analyzePromises.js";

const bills = [
  { type: "HR", number: "7992", title: "Example House bill" },
  { type: "HCONRES", number: "62", title: "Example concurrent resolution" },
];

test("analysis prompt lists and requests TYPE NUMBER bill identifiers", () => {
  const prompt = createAnalysisPrompt(
    { name: "Example Member", chamber: "senate", party: "Independent" },
    [{ topic: "Health", text: "Support health care access." }],
    bills,
  );

  assert.match(prompt, /HR 7992: Example House bill/);
  assert.match(prompt, /HCONRES 62: Example concurrent resolution/);
  assert.match(prompt, /exactly the format "TYPE NUMBER"/);
  assert.match(prompt, /do not cite a bare number/);
});

test("analysis keeps only exact TYPE NUMBER identifiers from the provided bills", () => {
  const normalizedAnalysis = validateAndNormalizeAnalysis(
    {
      score: 75,
      breakdown: [
        {
          promiseTopic: "Health",
          promiseText: "Support health care access.",
          correlatingBills: [
            "HR 7992",
            "62",
            "HRES 62",
            "hr 7992",
            "HCONRES 62",
          ],
          reasoning: "These bills are relevant.",
        },
      ],
    },
    bills,
  );

  assert.deepEqual(normalizedAnalysis.breakdown[0].correlatingBills, [
    "HR 7992",
    "HCONRES 62",
  ]);
});
