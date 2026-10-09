import { expect, test } from "bun:test";
import { createHoldQueue, HOLD_MS, type HeldAction, type Timers } from "./held-actions.ts";

function manualTimers() {
  const due = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set(run) {
      due.set(++next, run);
      return next;
    },
    clear(id) {
      due.delete(id);
    },
  };
  function elapse() {
    const runs = [...due.values()];
    due.clear();
    for (const run of runs) run();
  }
  return { timers, elapse };
}

function action(log: string[], name: string, error?: string): HeldAction {
  return {
    pending: `${name}…`,
    async send(leaving) {
      log.push(leaving ? `send ${name} leaving` : `send ${name}`);
      if (error !== undefined) throw new Error(error);
      return { message: `${name} sent`, complete: true, kept: true };
    },
    undo: () => log.push(`undo ${name}`),
    restore: () => log.push(`restore ${name}`),
    failText: (reason) => `${name} came back: ${reason}`,
  };
}

test("an action waits out the hold, Undo cancels it, leaving sends it now, and a failed send comes back", async () => {
  const { timers, elapse } = manualTimers();
  const queue = createHoldQueue(timers, HOLD_MS);
  const log: string[] = [];

  queue.hold(action(log, "reply"));
  expect(queue.notices().held?.message).toBe("reply…");
  expect(log).toEqual([]);
  elapse();
  await queue.flush();
  expect(queue.notices()).toEqual({ held: null, outcome: { id: expect.any(Number), message: "reply sent", result: "sent" } });

  queue.hold(action(log, "merge"));
  expect(queue.undo()).toBe(true);
  expect(queue.undo()).toBe(false);

  queue.hold(action(log, "close"));
  queue.hold(action(log, "approve"));
  expect(queue.notices().held?.message).toBe("approve…");
  await queue.flush();
  expect(queue.notices().held).toBeNull();

  queue.hold(action(log, "comment", "Resource not accessible by integration"));
  elapse();
  await queue.flush();
  expect(queue.notices().outcome).toMatchObject({ message: "comment came back: Resource not accessible by integration", result: "failed" });

  expect(log).toEqual([
    "send reply",
    "undo merge",
    "send close",
    "send approve leaving",
    "send comment",
    "restore comment",
  ]);
});
