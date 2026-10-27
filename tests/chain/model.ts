// The workspace's decision model, served locally on System One's wire: it answers each question from the test's script
// and keeps what it was asked. While held, it answers nothing until released.
export type Question = { type: "noul" | "choice" | "score"; instructions: string; criteria?: unknown };
export type Answer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export function stubModel(decide: (id: string, question: Question) => Answer) {
  const decisions: { id: string; question: Question }[] = [];
  let held: Promise<void> | undefined;

  /** Holds every answer until the returned release is called. */
  function hold(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    held = promise;
    return function release() {
      held = undefined;
      resolve();
    };
  }

  async function systemOne(req: Request): Promise<Response> {
    await held;
    const { questions } = await req.json() as { questions: Record<string, Question> };
    const answers = Object.fromEntries(Object.entries(questions).map(function answer([id, question]) {
      decisions.push({ id, question });
      return [id, decide(id, question)];
    }));
    return Response.json({ model: "stub", usage: { input_tokens: 1, output_tokens: 1 }, answers });
  }

  async function serve(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    return req.method === "POST" && pathname.endsWith("/systemone") ? systemOne(req) : new Response(null, { status: 404 });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    decisions,
    hold,
    stop(): void {
      server.stop(true);
    },
  };
}
