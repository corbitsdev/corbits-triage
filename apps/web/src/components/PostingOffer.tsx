import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@corbits/react-ui/ui/dialog";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, hostKinds, type ActionKind } from "@corbits/triage-contracts";
import { findTriageRole, triageRunsAlone } from "../lib/automation-grid.ts";
import type { PrItem } from "../lib/hub-api.ts";
import { reposWithoutPostingGrants } from "../lib/inbox-view.ts";
import { GRANTS_QUERY_KEY, usePortal } from "../lib/portal.tsx";
import { useGrants, useRoles } from "../lib/tenant-entities.ts";

const POSTING: readonly ActionKind[] = ["comment", "labels"];

type PostingOfferProps = { items: readonly PrItem[]; enabled: ReadonlySet<string> };

/** Asks to let Triage post on a repository whose latest verdict it was not allowed to post. A dismissal lasts until the tab closes. */
export default function PostingOffer({ items, enabled }: PostingOfferProps) {
  const { snapshot, readOnly, addGrant } = usePortal();
  const grants = useGrants();
  const roles = useRoles();
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const turnOn = useMutation({
    mutationFn: async function grantPosting({ roleId, repo, kinds }: { roleId: string; repo: string; kinds: ActionKind[] }) {
      for (const kind of kinds) await addGrant({ roleId, resource: doResource(kind, repo), action: DO_GRANT_ACTION });
      await queryClient.invalidateQueries({ queryKey: [GRANTS_QUERY_KEY] });
    },
  });
  const triage = findTriageRole(roles.rows);
  const known = ![grants, roles].some((section) => section.loading || section.unavailable || section.denied);
  if (!snapshot || readOnly || snapshot.denied.repos || !known || !triage) return null;

  const record = reposWithoutPostingGrants(items, enabled)
    .filter((name) => !dismissed.includes(name))
    .map((name) => snapshot.repos.find((record) => record.name === name))
    .find((record) => record !== undefined && !triageRunsAlone(roles.rows, grants.rows, "comment", record.name));
  if (!record) return null;
  const repo = record;

  const kinds = POSTING.filter((kind) => hostKinds(repo.source).includes(kind) && !triageRunsAlone(roles.rows, grants.rows, kind, repo.name));
  const what = hostKinds(repo.source).includes("labels") ? "Comment and labels" : "Comment and build status";

  function dismiss() {
    setDismissed((names) => [...names, repo.name]);
  }

  function dismissUnlessSaving(open: boolean) {
    if (!open && !turnOn.isPending) dismiss();
  }

  return (
    <Dialog open onOpenChange={dismissUnlessSaving}>
      <DialogContent className="key-popup">
        <DialogHeader>
          <DialogTitle>Triage can't post its verdict on {repo.name}</DialogTitle>
          <DialogDescription>Turn on {what}? Triage then posts its verdicts on the pull requests there without asking.</DialogDescription>
        </DialogHeader>
        {turnOn.error ? <p role="alert" className="field-error">Could not turn on {what}. {errorText(turnOn.error)}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" disabled={turnOn.isPending} onClick={dismiss}>Dismiss</Button>
          <Button type="button" size="sm" disabled={turnOn.isPending} onClick={() => turnOn.mutate({ roleId: triage.id, repo: repo.name, kinds })}>{turnOn.isPending ? "Turning on…" : `Turn on ${what}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
