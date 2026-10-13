import { Component, type ReactNode } from "react";
import { errorText } from "@corbits/common";

type State = { error: unknown };

/** Keeps a failure to show the details inside the details, rather than unmounting the whole portal. */
export class DetailsBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  render() {
    if (this.state.error !== null) return <p role="alert" className="none">Could not show the details. {errorText(this.state.error)}</p>;
    return this.props.children;
  }
}
