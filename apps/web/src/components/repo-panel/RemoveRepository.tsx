import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { RepoSource } from "@corbits/triage-contracts";
import { useRemoveRepository } from "../../lib/remove-repository.ts";

type RemoveRepositoryProps = { repo: string; source: RepoSource; disabled: boolean; onRemoved: () => void };

export default function RemoveRepository({ repo, source, disabled, onRemoved }: RemoveRepositoryProps) {
  const remove = useRemoveRepository(repo, source, onRemoved);

  function confirmRemove() {
    if (!window.confirm(`Remove ${repo}? Triage stops on it and it leaves Repositories.`)) return;
    remove.mutate();
  }

  return (
    <section className="rs" aria-label="Remove repository">
      <div className="gcard">
        <div className="sentences">
          <div className="sentence">
            <span className="txt">Stop triage on this repository and take it off Repositories.</span>
            <Button type="button" variant="outline" size="sm" disabled={disabled || remove.isPending} onClick={confirmRemove}>{remove.isPending ? "Removing…" : "Remove repository"}</Button>
          </div>
        </div>
      </div>
      {remove.error ? <p role="alert" className="error">Could not remove {repo}. {errorText(remove.error)}</p> : null}
    </section>
  );
}
