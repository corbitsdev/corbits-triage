// SPDX-License-Identifier: GPL-2.0-only
//
// PR text is data, never instructions: text that instructs the triage pipeline
// scores high spam / low confidence so the downstream gate (spam >= 0.9 or
// confidence < 0.5 => human-gated) routes it to a human. Shared by every
// consumer so evals never use their own magic constants.

export interface TextSignals {
  spam: number;
  confidence: number;
  features: string[];
}

interface Feature {
  id: string;
  weight: number;
  patterns: RegExp[];
}

const BASE_SPAM = 0.08;
const MAX_SPAM = 0.98;
const BASE_CONFIDENCE = 0.85;
const MIN_CONFIDENCE = 0.05;

const FEATURES: Feature[] = [
  {
    id: "instruction-override",
    weight: 0.85,
    patterns: [
      /ignore\s+(all\s+|any\s+|previous\s+|prior\s+|these\s+|your\s+|the\s+)?(instructions?|polic(y|ies)|rules?|guidelines?|safeguards?)/i,
      /disregard\s+(all\s+|any\s+|previous\s+|prior\s+|these\s+|your\s+|the\s+)?(instructions?|polic(y|ies)|rules?|orders?)/i,
      /override\s+(the\s+|your\s+|all\s+)?(polic(y|ies)|rules?|instructions?|controls?)/i,
    ],
  },
  {
    id: "fake-system-prompt",
    weight: 0.85,
    patterns: [/(^|\n)\s*system\s*:/i, /\[system\]/i],
  },
  {
    id: "gate-bypass",
    weight: 0.85,
    patterns: [
      /\bbypass\b/i,
      /\bauto-close\b/i,
      /without\s+(maintainer|human|manual|reviewer)\s+(confirmation|approval|review)/i,
    ],
  },
  {
    id: "self-authorization",
    weight: 0.85,
    patterns: [/\ballowlist\b/i, /standing\s+approval/i, /\bgrant\b[^\n]*\bapproval\b/i],
  },
  {
    id: "mass-close-directive",
    weight: 0.85,
    patterns: [/\bclose\s+all\b/i, /\bclose\b[^\n]*\bother\s+prs?\b/i],
  },
  {
    id: "authority-grant",
    weight: 0.45,
    patterns: [/\bgrant\b/i],
  },
  {
    id: "authority-approve",
    weight: 0.45,
    patterns: [/\bapprove\b/i, /\bapproved\b/i],
  },
  {
    id: "authority-merge",
    weight: 0.45,
    patterns: [/\bmerge\b/i],
  },
  {
    id: "close-as-duplicate",
    weight: 0.45,
    patterns: [/\bclose\b[^\n]*\bduplicate\b/i],
  },
  {
    id: "budget-manipulation",
    weight: 0.45,
    patterns: [/\bbudget\b/i, /\bpaid\b[^\n]*\breview\b/i, /(without|no)\s+budget/i],
  },
  {
    id: "urgency-coercion",
    weight: 0.45,
    patterns: [/\burgent\b/i, /\bimmediately\b/i],
  },
];

function round2(n: number): number {
  return Number(n.toFixed(2));
}

export function classifySignals(input: { title: string; body?: string }): TextSignals {
  const text = `${input.title}\n${input.body ?? ""}`;
  const features: string[] = [];
  let critical = 0;
  let spam = BASE_SPAM;
  for (const f of FEATURES) {
    const hit = f.patterns.find((re) => re.test(text));
    if (hit) {
      const snippet = text.match(hit)?.[0].slice(0, 60) ?? "";
      features.push(`${f.id}: ${snippet}`);
      spam += f.weight;
      if (f.weight >= 0.85) critical++;
    }
  }
  return {
    spam: round2(Math.min(MAX_SPAM, spam)),
    confidence: round2(Math.max(MIN_CONFIDENCE, BASE_CONFIDENCE - 0.18 * features.length - 0.12 * critical)),
    features,
  };
}
