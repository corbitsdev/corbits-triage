// Deterministic stand-in for the System One / Jev evaluate endpoint, served at
// POST /systemone (the provider adapter posts to the provider baseURL + /systemone).
// Every question passes (noul 0.9) unless state.title carries "[fail:<id>]" for it.
const PASS = 0.9;
const FAIL = 0.1;

type WireQuestion = { type: "noul" | "choice" | "score"; instructions: unknown; criteria?: unknown };
export type WireRequest = { model: string; state: unknown; questions: Record<string, WireQuestion> };
export type RecordedRequest = { authorization: string | null; body: WireRequest };
export type FakeSystemOne = {
  url: string;
  requests: () => RecordedRequest[];
  stop: () => Promise<void>;
};

function failed(state: unknown, id: string): boolean {
  const title = typeof state === "object" && state !== null && "title" in state ? state.title : undefined;
  return typeof title === "string" && title.includes(`[fail:${id}]`);
}

function answer(question: WireQuestion, fail: boolean) {
  if (question.type === "noul") return { type: "noul", noul: fail ? FAIL : PASS };
  if (question.type === "choice") {
    const options = Object.keys(question.criteria as Record<string, unknown>);
    const choice = fail ? options[options.length - 1]! : options[0]!;
    const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0]));
    return { type: "choice", choice, confidence: PASS, probabilities };
  }
  const levels = (question.criteria as unknown[]).length;
  const index = fail ? 0 : levels - 1;
  const keys = Array.from({ length: levels }, (_, i) => String(i));
  return {
    type: "score",
    score: index,
    confidence: PASS,
    probabilities: Object.fromEntries(keys.map((key) => [key, Number(key) === index ? 1 : 0])),
    legend: Object.fromEntries(keys.map((key) => [key, `level ${key}`])),
  };
}

export function startFakeSystemOne({ port }: { port: number }): FakeSystemOne {
  const recorded: RecordedRequest[] = [];
  const server = Bun.serve({
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "POST" || pathname !== "/systemone") return new Response("not found", { status: 404 });
      const body = (await request.json()) as WireRequest;
      recorded.push({ authorization: request.headers.get("authorization"), body });
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => [id, answer(question, failed(body.state, id))]),
      );
      return Response.json({ model: body.model, usage: { input_tokens: 100, output_tokens: 10 }, answers });
    },
  });
  return {
    url: `http://localhost:${server.port}/systemone`,
    requests: () => recorded,
    stop: async () => {
      await server.stop(true);
    },
  };
}
