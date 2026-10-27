import { expect, test } from "bun:test";
import { DOCKER_PLACE, DOCKER_REMOTE_PLACE } from "@corbits/provisioner-docker";
import { E2B_PLACE } from "@corbits/provisioner-e2b";
import { RAILWAY_PLACE } from "@corbits/provisioner-railway";
import { isolatedPlaceBootWarning } from "./code-review.js";

const PLACES = [DOCKER_PLACE, DOCKER_REMOTE_PLACE, E2B_PLACE, RAILWAY_PLACE];

test("boot warns once when no isolated place is registered, and stays quiet once one is", () => {
  const warning = isolatedPlaceBootWarning(false, PLACES);
  expect(warning?.level).toBe("warn");
  expect(warning?.msg).toBe("code_review_no_isolated_place");
  const reason = warning?.reason ?? "";
  expect(reason).not.toContain("\n");
  expect(reason).toContain("docs/provisioners/");
  for (const place of PLACES) {
    for (const line of place.env) {
      expect(reason).toContain(line.slice(0, line.indexOf("=")));
    }
  }
  expect(isolatedPlaceBootWarning(true, PLACES)).toBeUndefined();
});
