import { StatusDot } from "@corbits/react-ui";
import { useQueueLoadingPulse } from "../lib/open-pulls.ts";

/** Bottom-right pulse while the queue's sources are still loading, so pages can stay blank instead of guessing. */
export default function LoadingIndicator() {
  if (!useQueueLoadingPulse()) return null;
  return (
    <div className="loading-indicator">
      <StatusDot label="Loading" live tone="emphasis" />
    </div>
  );
}
