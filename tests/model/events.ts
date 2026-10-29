// The events a pull request's sequence is made of, each played on the stack as GitHub and the hub would see it, and the
// seeded random walks the rules are checked over past the sequences played in full.
import { pullOf, sha, type CheckRun } from "../chain/github.ts";
import type { modelStack } from "./stack.ts";

type Stack = Awaited<ReturnType<typeof modelStack>>;

export const LETTERS = ["push", "ci-pending", "ci-success", "ci-failure", "ci-cancelled", "ci-stale", "edit", "draft", "ready", "duplicate", "run-first", "run-second"] as const;
export type Letter = (typeof LETTERS)[number];

/** One pull request a sequence plays on: its number, every head it had, newest last, and whether it is a draft. */
export type Played = { number: number; heads: string[]; draft: boolean };

const BUILD = "build";

function current(pull: Played): string {
  return pull.heads.at(-1)!;
}

/**
 * The bridge takes in no webhook of a draft but its conversion to one (apps/hub/src/github/bridge.ts), so a draft's
 * events reach the hub as nothing.
 */
async function webhook(stack: Stack, pull: Played, event: Parameters<Stack["webhook"]>[1], head = current(pull)): Promise<void> {
  if (pull.draft && event !== "drafted") return;
  await stack.webhook(pull.number, event, head);
}

/** CI on the head settles; GitHub sends a webhook only for a completed check, never for one still running. */
async function checks(stack: Stack, pull: Played, run: CheckRun, head = current(pull)): Promise<void> {
  stack.github.setChecks(stack.repo, head, [run]);
  if (run.status === "completed") await webhook(stack, pull, "checks", head);
}

/** Plays `letter`; false when it changes nothing in this state, so the sequence equals a shorter one. */
export async function play(stack: Stack, pull: Played, letter: Letter): Promise<boolean> {
  switch (letter) {
    case "push": {
      const head = sha(`${pull.number}-${pull.heads.length}`);
      pull.heads.push(head);
      stack.github.pull(stack.repo, pull.number).head = head;
      stack.github.setChecks(stack.repo, head, []);
      await webhook(stack, pull, "updated");
      return true;
    }
    case "ci-pending":
      await checks(stack, pull, { name: BUILD, status: "in_progress", conclusion: null });
      return true;
    case "ci-success":
      await checks(stack, pull, { name: BUILD, status: "completed", conclusion: "success" });
      return true;
    case "ci-failure":
      await checks(stack, pull, { name: BUILD, status: "completed", conclusion: "failure" });
      return true;
    case "ci-cancelled":
      await checks(stack, pull, { name: BUILD, status: "completed", conclusion: "cancelled" });
      return true;
    case "ci-stale": {
      const old = pull.heads.at(-2);
      if (old === undefined) return false;
      await checks(stack, pull, { name: BUILD, status: "completed", conclusion: "success" }, old);
      return true;
    }
    case "edit":
      await webhook(stack, pull, "updated");
      return true;
    case "draft":
      if (pull.draft) return false;
      pull.draft = true;
      stack.github.pull(stack.repo, pull.number).draft = true;
      await webhook(stack, pull, "drafted");
      return true;
    case "ready":
      if (!pull.draft) return false;
      pull.draft = false;
      stack.github.pull(stack.repo, pull.number).draft = false;
      await webhook(stack, pull, "ready");
      return true;
    case "duplicate":
      if (stack.queue.length === 0) return false;
      stack.duplicate(0);
      return true;
    case "run-first":
      if (stack.queue.length === 0) return false;
      await stack.run(0);
      return true;
    case "run-second":
      if (stack.queue.length < 2) return false;
      await stack.run(1);
      return true;
  }
}

/** Opens pull request `number` at its first head. */
export async function open(stack: Stack, number: number): Promise<Played> {
  const pull = { number, heads: [sha(`${number}-0`)], draft: false };
  await stack.open(pullOf(number, current(pull)));
  return pull;
}

/**
 * Lets the pull request settle as it does once people stop acting on it: a draft is marked ready, CI on its head
 * finishes, and every mail is run.
 */
export async function settle(stack: Stack, pull: Played): Promise<void> {
  if (pull.draft) await play(stack, pull, "ready");
  await stack.drain();
  const [run] = stack.github.checksOf(stack.repo, current(pull));
  if (run?.status !== "completed") await play(stack, pull, "ci-success");
  await stack.drain();
}

/** A random walk of `length` letters from `seed`, the same on every machine. */
export function walk(seed: number, length: number): Letter[] {
  let state = seed >>> 0;
  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }
  return Array.from({ length }, () => LETTERS[Math.floor(next() * LETTERS.length)]!);
}
