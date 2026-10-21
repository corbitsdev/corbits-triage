import type { ReactNode } from "react";

/** `footer` sits under the panel, for a way to the other form such as signing up. */
export function SignInShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="signin">
      <p className="signin-brand"><img src="/triage-logo.svg" width="40" height="40" alt="" />Corbits Triage</p>
      <main className="signin-panel">{children}</main>
      {footer && <p className="signin-footer">{footer}</p>}
    </div>
  );
}
