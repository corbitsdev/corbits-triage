import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createSidecarPluginRegistry,
  type DestroySidecarRequest,
  type DestroySidecarResult,
  type EnsureSidecarRequest,
  type EnsureSidecarResult,
  type SidecarProvisioner,
} from "@intx/hub-sessions";

type SidecarIdentity = {
  readonly generation: number;
  readonly sidecarId: string;
};

export type ConformanceSubject = {
  readonly provisioner: SidecarProvisioner;
  /** The sidecars whose infrastructure exists for an allocation, read from the backend itself. */
  live(allocationId: string): Promise<readonly SidecarIdentity[]>;
  /**
   * One check per capability the provisioner declares available. Each throws
   * when the allocation's running sidecar does not provide the capability.
   */
  readonly capabilityChecks: Readonly<Record<string, (allocationId: string) => Promise<void>>>;
  dispose(): Promise<void>;
};

const ALLOCATION = "sal_conformance";

function ensureRequest(generation: number, sidecarId: string): EnsureSidecarRequest {
  return {
    allocationId: ALLOCATION,
    generation,
    tenantId: "tnt_conformance",
    anchorRunId: "run_conformance",
    sidecarId,
    token: `token_${sidecarId}`,
    hubWebSocketUrl: "ws://127.0.0.1:1/sidecar",
  };
}

function destroyRequest(generation: number, sidecarId: string, externalRef?: string): DestroySidecarRequest {
  return {
    allocationId: ALLOCATION,
    generation,
    sidecarId,
    ...(externalRef !== undefined && { externalRef }),
  };
}

/**
 * Registers the stock sidecar provisioner contract as bun tests, for a
 * provisioner that starts its own sidecar for each allocation. `setup`
 * returns a provisioner over an empty backend for each test.
 */
export function describeProvisionerConformance(name: string, setup: () => Promise<ConformanceSubject>): void {
  describe(`${name} provisioner conformance`, () => {
    let subject: ConformanceSubject;

    beforeEach(async () => {
      subject = await setup();
    });

    afterEach(async () => {
      await subject.dispose();
    });

    async function ensure(generation: number, sidecarId: string): Promise<EnsureSidecarResult> {
      return subject.provisioner.ensure(ensureRequest(generation, sidecarId));
    }

    async function destroy(generation: number, sidecarId: string, externalRef?: string): Promise<DestroySidecarResult> {
      return subject.provisioner.destroy(destroyRequest(generation, sidecarId, externalRef));
    }

    test("registers with the stock plugin registry", () => {
      expect(() => createSidecarPluginRegistry({ provisioners: [subject.provisioner] })).not.toThrow();
    });

    test("ensure creates the sidecar once, however often it is repeated", async () => {
      expect((await ensure(1, "sc_a")).kind).toBe("accepted");
      expect((await ensure(1, "sc_a")).kind).toBe("accepted");
      expect(await subject.live(ALLOCATION)).toEqual([{ generation: 1, sidecarId: "sc_a" }]);
    });

    test("ensure rejects a generation older than one it has seen", async () => {
      await ensure(2, "sc_a");
      expect(await ensure(1, "sc_old")).toMatchObject({ kind: "rejected", retryable: false });
      expect(await subject.live(ALLOCATION)).toEqual([{ generation: 2, sidecarId: "sc_a" }]);
    });

    test("replacement destroys the old sidecar at the next generation, then ensures a new one there", async () => {
      await ensure(1, "sc_a");
      expect(await destroy(2, "sc_a")).toEqual({ kind: "destroyed", cleanup: "confirmed" });
      expect(await subject.live(ALLOCATION)).toEqual([]);
      expect((await ensure(2, "sc_b")).kind).toBe("accepted");
      expect(await destroy(2, "sc_a")).toMatchObject({ kind: "destroyed" });
      expect(await subject.live(ALLOCATION)).toEqual([{ generation: 2, sidecarId: "sc_b" }]);
    });

    test("a late ensure for a destroyed sidecar creates nothing", async () => {
      await ensure(1, "sc_a");
      await destroy(2, "sc_a");
      expect((await ensure(1, "sc_a")).kind).toBe("rejected");
      expect((await ensure(2, "sc_a")).kind).toBe("rejected");
      expect(await subject.live(ALLOCATION)).toEqual([]);
    });

    test("an ensure still running when destroy arrives is removed by that destroy", async () => {
      const ensuring = ensure(1, "sc_a");
      const destroying = destroy(2, "sc_a");
      await Promise.allSettled([ensuring, destroying]);
      expect(await destroying).toEqual({ kind: "destroyed", cleanup: "confirmed" });
      expect(await subject.live(ALLOCATION)).toEqual([]);
    });

    test("destroy finds the sidecar with and without externalRef", async () => {
      const first = await ensure(1, "sc_a");
      if (first.kind !== "accepted") throw new Error(`ensure was rejected: ${first.message}`);
      expect(await destroy(2, "sc_a", first.externalRef)).toEqual({ kind: "destroyed", cleanup: "confirmed" });
      expect(await subject.live(ALLOCATION)).toEqual([]);

      await ensure(2, "sc_b");
      expect(await destroy(3, "sc_b")).toEqual({ kind: "destroyed", cleanup: "confirmed" });
      expect(await subject.live(ALLOCATION)).toEqual([]);
    });

    test("destroying an allocation that has nothing confirms its absence", async () => {
      expect(await destroy(1, "sc_never")).toEqual({ kind: "destroyed", cleanup: "confirmed" });
      expect(await destroy(1, "sc_never")).toEqual({ kind: "destroyed", cleanup: "confirmed" });
    });

    test("every capability declared available holds on a running sidecar", async () => {
      const available = subject.provisioner.capabilities
        .filter((declaration) => declaration.state === "available")
        .map((declaration) => declaration.capability);
      expect(Object.keys(subject.capabilityChecks).sort()).toEqual(available.sort());
      await ensure(1, "sc_a");
      for (const check of Object.values(subject.capabilityChecks)) {
        await check(ALLOCATION);
      }
    });
  });
}
