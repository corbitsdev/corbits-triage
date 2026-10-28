// The chain's lint rule: a scenario waits on the state it names, never on a fixed real duration, so a sleep or timer of
// a second or more written as a literal fails `bun run lint`.
const LIMIT_MS = 1_000;

function delayOf(node) {
  const { callee } = node;
  if (callee.type === "MemberExpression" && callee.object.name === "Bun" && callee.property.name === "sleep") return node.arguments[0];
  if (callee.type === "Identifier" && callee.name === "sleep") return node.arguments[0];
  if (callee.type === "Identifier" && callee.name === "setTimeout") return node.arguments[1];
  return undefined;
}

export default {
  meta: { name: "chain" },
  rules: {
    "no-real-sleep": {
      create(context) {
        return {
          CallExpression(node) {
            const delay = delayOf(node);
            if (delay?.type === "Literal" && typeof delay.value === "number" && delay.value >= LIMIT_MS) {
              context.report({ node, message: `Wait on the state the scenario names, not ${delay.value} ms of real time.` });
            }
          },
        };
      },
    },
  },
};
