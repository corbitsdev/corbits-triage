import { useState, type FormEvent } from "react";
import { Button } from "@corbits/react-ui";
import { useSearchParams } from "react-router-dom";
import { claimDeviceCode, decideDeviceCode } from "../lib/hub-auth.ts";
import { useSession } from "../lib/session.tsx";

export const DEVICE_PATH = "/device";

const CLIENT_NAMES: Record<string, string> = { "corbits-cli": "Corbits CLI" };

type Step = "enter" | "decide" | "approved" | "denied";

export function Device() {
  const { session } = useSession();
  const [params] = useSearchParams();
  const [userCode, setUserCode] = useState(params.get("user_code") ?? "");
  const [step, setStep] = useState<Step>("enter");
  const [clientId, setClientId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function act(run: () => Promise<void>) {
    setPending(true);
    setError("");
    try {
      await run();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  function claim(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async function claimCode() {
      setClientId(await claimDeviceCode(userCode.trim()));
      setStep("decide");
    });
  }

  function decide(decision: "approve" | "deny") {
    void act(async function decideCode() {
      await decideDeviceCode(userCode.trim(), decision);
      setStep(decision === "approve" ? "approved" : "denied");
    });
  }

  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Sign in a device">
        <h1>Sign in a device</h1>
        {step === "enter" && (
          <form onSubmit={claim}>
            <p className="muted">Enter the code your agent or terminal shows.</p>
            <label className="field">
              Code
              <input value={userCode} onChange={(event) => setUserCode(event.target.value)} autoComplete="off" required disabled={pending} />
            </label>
            <Button type="submit" disabled={pending}>Continue</Button>
          </form>
        )}
        {step === "decide" && <>
          <p className="muted"><strong>{CLIENT_NAMES[clientId] ?? clientId}</strong> with code <strong>{userCode.trim().toUpperCase()}</strong> will act as {session?.email} with everything you can do. Approve only if you started it.</p>
          <div className="row">
            <Button type="button" disabled={pending} onClick={() => decide("approve")}>Approve</Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => decide("deny")}>Deny</Button>
          </div>
        </>}
        {step === "approved" && <p role="status">Approved. You can close this page. Sign the device out under Settings → Account.</p>}
        {step === "denied" && <p role="status">Denied. The device was not signed in.</p>}
        {error && <p role="alert" className="field-error">{error}</p>}
      </section>
    </div>
  );
}
