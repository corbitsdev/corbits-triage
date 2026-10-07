// Smoke check: real @corbits/system-one evaluate() against the fake.
//   bun --conditions=intx-src tooling/e2e/fake-system-one.check.ts
import { evaluate } from "@corbits/system-one";
import { startFakeSystemOne } from "./fake-system-one.ts";

const fake = startFakeSystemOne({ port: 0 });
try {
  const result = await evaluate(
    {
      state: { title: "Add widget [fail:tests]" },
      questions: [
        { id: "scope", type: "noul", instructions: "Is the scope focused?" },
        { id: "tests", type: "noul", instructions: "Are there tests?" },
        { id: "kind", type: "choice", instructions: "Kind?", criteria: { fix: null, feat: null } },
        { id: "risk", type: "score", instructions: "Risk?", criteria: ["low", "mid", "high"] },
      ],
      config: { endpoint: { kind: "custom", url: fake.url }, apiKey: "test-key" },
    },
  );
  console.log(JSON.stringify(result, null, 2));
  console.log(JSON.stringify(fake.requests(), null, 2));
} finally {
  await fake.stop();
}
