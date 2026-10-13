// The triage steps import only this type from Interchange's workflow package. Its sources resolve only under the
// intx-src condition and pull in @intx/inference, whose providers do not type-check against the DOM lib, so the
// extension declares the one interface it passes through (copied from @intx/workflow runtime/env.ts).
declare module "@intx/workflow" {
  export interface EffectContext {
    perform(opts: { effectId: string; capability: string; run: () => Promise<unknown> }): Promise<unknown>;
  }
}
