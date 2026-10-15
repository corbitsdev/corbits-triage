import type { ReactNode } from "react";

export function SignInShell({ children }: { children: ReactNode }) {
  return (
    <div className="signin">
      <main className="signin-main">
        <div className="signin-column">{children}</div>
      </main>
      <div className="signin-brand" aria-hidden="true">
        <span className="signin-wordmark"><img src="/triage-logo.svg" width="48" height="48" alt="" />Corbits Triage</span>
      </div>
    </div>
  );
}
