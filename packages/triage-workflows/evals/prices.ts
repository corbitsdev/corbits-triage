import type { TokenUsage } from "@intx/types/runtime";

/** Dollars per million tokens, or "unknown" when the source publishes none. */
type Rate = number | "unknown";

interface Rates {
  input: Rate;
  output: Rate;
  cacheRead: Rate;
  cacheWrite: Rate;
}

interface ModelPrice {
  source: string;
  asOf: string;
  price: Rates;
  long?: { overPrompt: number; price: Rates };
}

/** Who bills the tokens: the model's maker or a gateway in front of it, whose prices may differ. */
export type ProviderId = "anthropic" | "opencode-zen" | "typesafe";

/** The table's last revision, recorded in each baseline beside each model's price so its usage can be priced again. */
export const PRICES_AS_OF = "2026-10-20";

const ANTHROPIC = { source: "https://www.anthropic.com/pricing", asOf: "2026-10-16" };
const TYPESAFE = { source: "https://docs.typesafe.ai/models.md", asOf: "2026-10-20" };
// OpenCode Zen's FAQ: it charges what the model's provider charges, with zero markup.
const ZEN = { source: "https://opencode.ai/zen", asOf: "2026-10-20" };

// Claude prices are with 5-minute cache writes; a Haiku 5.5 call whose prompt (input, cache reads and cache writes) is
// over 100k tokens pays the long-prompt prices for all of its tokens. TypeSafe bills input only and states no cache price.
const HAIKU: ModelPrice = {
  ...ANTHROPIC,
  price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  long: { overPrompt: 100_000, price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
};
const SONNET: ModelPrice = { ...ANTHROPIC, price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
const OPUS: ModelPrice = { ...ANTHROPIC, price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } };
const JEV: ModelPrice = { ...TYPESAFE, price: { input: 0.042, output: 0, cacheRead: "unknown", cacheWrite: "unknown" } };

/** The provider's rates, sourced from the gateway that passes them on. */
function zen(provider: ModelPrice): ModelPrice {
  return { ...provider, ...ZEN };
}

/** Keyed `<provider>/<model>`. */
const PRICES: Record<string, ModelPrice> = {
  "anthropic/claude-haiku-5-5": HAIKU,
  "anthropic/claude-sonnet-5-5": SONNET,
  "anthropic/claude-opus-5-5": OPUS,
  "typesafe/jev-1.13": JEV,
  "opencode-zen/claude-haiku-5-5": zen(HAIKU),
  "opencode-zen/claude-sonnet-5-5": zen(SONNET),
  "opencode-zen/claude-opus-5-5": zen(OPUS),
  "opencode-zen/jev-1.13": zen(JEV),
};

export function priceKey(provider: ProviderId, model: string): string {
  return `${provider}/${model}`;
}

/** The table's entry for `key`; a model with no entry fails before it is called. */
export function priceOf(key: string): ModelPrice {
  const price = PRICES[key];
  if (!price) throw new Error(`${key} is not in the price table; known: ${Object.keys(PRICES).join(", ")}`);
  return price;
}

/** The call's dollars, or null when it used tokens at a rate the source does not publish. */
export function costOf(call: TokenUsage, { price: base, long }: ModelPrice): number | null {
  const price = long && call.input + call.cacheRead + call.cacheWrite > long.overPrompt ? long.price : base;
  const parts: [number, Rate][] = [[call.input, price.input], [call.output, price.output], [call.cacheRead, price.cacheRead], [call.cacheWrite, price.cacheWrite]];
  if (parts.some(([tokens, rate]) => tokens > 0 && rate === "unknown")) return null;
  const cost = parts.reduce((total, [tokens, rate]) => total + (rate === "unknown" ? 0 : tokens * rate), 0) / 1e6;
  if (!Number.isFinite(cost)) throw new Error(`cost of ${JSON.stringify(call)} is ${cost}`);
  return cost;
}

/** The sum of two costs, null when either is unknown. */
export function addCost(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}
