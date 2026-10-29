import type { AssistantTurn, ReactorCapabilities, ReactorDirector } from "@intx/types/runtime";

export function turnText(turn: AssistantTurn): string {
  return turn.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
}

/** The reactor hands one stable capabilities object to `decide`; the director is built from it on first use. */
export function lazy(build: (caps: ReactorCapabilities) => ReactorDirector): ReactorDirector {
  let inner: ReactorDirector | undefined;
  return {
    async decide(event, state, caps) {
      return (inner ??= build(caps)).decide(event, state, caps);
    },
  };
}
