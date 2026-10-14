import { Button } from "@corbits/react-ui";
import { useSignOutAfterSending } from "../../lib/held-inbox.tsx";
import { useSession } from "../../lib/session.tsx";
import { SignedInDevices } from "../SignedInDevices.tsx";

/** You, not the workspace: who is signed in, on which devices, and signing out. */
export function AccountSection() {
  const { session } = useSession();
  const signOut = useSignOutAfterSending();

  return (
    <section className="sec" id="account" aria-labelledby="sec-account">
      <header>
        <h2 id="sec-account">Your account</h2>
        <p>Only you see this. Sign out a device you no longer use.</p>
      </header>
      <div>
        <div className="sentences">
          <div className="sentence">
            <span className="txt">Signed in as <b>{session?.email}</b></span>
            <Button type="button" variant="outline" size="sm" onClick={() => void signOut()}>Sign out</Button>
          </div>
          <SignedInDevices />
        </div>
      </div>
    </section>
  );
}
