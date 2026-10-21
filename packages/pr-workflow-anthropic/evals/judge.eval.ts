// The triage judge eval (@corbits/triage-workflows/evals/judge.eval) through the PR workflow, with code review off, so
// System One is the only model it calls.
//
//   bun run eval   (in packages/pr-workflow-anthropic)
import { VERDICTS } from "@corbits/triage-contracts";
import { judgeEval } from "@corbits/triage-workflows/evals/judge.eval";
import * as actions from "../src/actions/index.js";
import * as directors from "../src/directors.js";
import { credentialBindingsFor, workflow } from "../src/pr-workflow.js";

const OFF = { codeReview: { on: false, for: ["everyone"], triage: [...VERDICTS], groups: ["everyone"] } };

await judgeEval({ workflow, directors: Object.values(directors), actions, credentialBindings: credentialBindingsFor(["github"]) }, "pr-workflow-anthropic", OFF);
