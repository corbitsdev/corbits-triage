import { expect, test } from "bun:test";
import { announceSignOut, onSignOutElsewhere } from "./sign-out-channel.ts";

test("another tab hears a sign-out", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  let heard = 0;
  const stop = onSignOutElsewhere(function signedOut() {
    heard += 1;
    resolve();
  });
  announceSignOut();
  await promise;
  stop();
  expect(heard).toBe(1);
});
