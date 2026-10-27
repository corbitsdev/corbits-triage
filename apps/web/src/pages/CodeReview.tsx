import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { PolicyPatchChange, PolicyPatched } from "@corbits/triage-contracts";
import { CodeReviewSection } from "../components/settings/CodeReviewSection.tsx";
import { DecisionModelForm } from "../components/DecisionModelForm.tsx";
import { KeyRow } from "../components/settings/KeyRow.tsx";
import { PolicyEditor } from "../components/code-review/PolicyEditor.tsx";
import { RepoSwitcher, repoKey } from "../components/code-review/RepoSwitcher.tsx";
import { ExternalIcon } from "../components/inbox-icons.tsx";
import { HOST_NAME } from "../components/repo-panel/PolicyMove.tsx";
import { modelSecrets } from "../lib/credential-actions.ts";
import { exportPolicyFile, isActiveCredential, patchPolicyFile, type RepoRecord } from "../lib/hub-api.ts";
import { createHubTransport } from "../lib/hub-transport.ts";
import { usePolicyFile } from "../lib/policy-file.ts";
import { policyFromText, touchedIds } from "../lib/policy-edits.ts";
import { usePolicyUpgrade, usePolicyUpgradeActions, POLICY_UPGRADES_QUERY_KEY } from "../lib/policy-upgrades.ts";
import { usePortal } from "../lib/portal.tsx";

type OpenPull = { number: number; url: string; state: "open"; headSha?: string; shaAtOpen?: string; touched: string[] };

function JudgeModel() {
  const { snapshot, removeDecisionModel } = usePortal();
  if (!snapshot) return null;
  const saved = snapshot.decisionModel;
  const words = saved ? <>Judge pull requests with <b>{saved.model}</b></> : "Judge pull requests with a decision model";
  return (
    <div className="gcard source" id="judging-model" aria-labelledby="judging-model-title" role="group">
      <header>
        <b id="judging-model-title">Judging</b>
        <span>The model is set once for every repository.</span>
      </header>
      <div className="sentences">
        <KeyRow
          words={words}
          name="decision model"
          keys={modelSecrets(snapshot.credentials).filter(isActiveCredential)}
          denied={snapshot.denied.credentials}
          remove={removeDecisionModel}
          error={snapshot.credentialsError}
          editor={(onSaved) => <DecisionModelForm onSaved={onSaved} />}
        />
      </div>
    </div>
  );
}

function OpenRequest({ pull, host, busy, onMerge }: { pull: OpenPull; host: string; busy: boolean; onMerge: () => void }) {
  return (
    <div className="sentences">
      <div className="sentence">
        <span className="txt">Pull request #{pull.number} open, waiting for review</span>
        {pull.headSha ? (
          <>
            <Button asChild variant="ghost" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Review on {host} <ExternalIcon /></a></Button>
            <Button type="button" size="sm" disabled={busy} onClick={onMerge}>Merge</Button>
          </>
        ) : (
          <Button asChild variant="outline" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Review on {host} <ExternalIcon /></a></Button>
        )}
      </div>
    </div>
  );
}

export default function CodeReview() {
  const { snapshot, readOnly } = usePortal();
  const repos = snapshot?.repos ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const selected = repos.find((repo) => repoKey(repo) === picked) ?? repos[0];
  const [opened, setOpened] = useState<{ key: string; pull: OpenPull } | null>(null);
  const [applyError, setApplyError] = useState("");
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  const file = usePolicyFile(selected?.name ?? "", opened?.key === (selected ? repoKey(selected) : ""));
  const upgrade = usePolicyUpgrade(selected?.name ?? "");
  const actions = usePolicyUpgradeActions(selected?.name ?? "", function settled() {
    setOpened(null);
  });

  if (opened && selected && repoKey(selected) === opened.key && file.data?.sha && opened.pull.shaAtOpen && file.data.sha !== opened.pull.shaAtOpen) {
    setOpened(null);
  }

  const listedPull = upgrade?.pull;
  const own = opened && selected && repoKey(selected) === opened.key ? opened.pull : null;
  const pull: OpenPull | null = own ?? (listedPull ? { number: listedPull.number, url: listedPull.url, state: "open", headSha: listedPull.headSha, touched: [] } : null);

  const text = useQuery({
    queryKey: ["policy-file-text", tenantId, selected?.name, selected?.source, file.data?.sha ?? null],
    enabled: tenantId !== undefined && selected !== undefined && file.data !== undefined && file.data !== null && file.data.problem === undefined,
    retry: false,
    queryFn: async function readFileText() {
      if (tenantId === undefined || selected === undefined) throw new Error("The workspace is not known yet.");
      // The policy-file read does not include the text. Preview writes nothing and returns it.
      const preview = await patchPolicyFile(createHubTransport(), tenantId, { repo: selected.name, source: selected.source, changes: [{ kind: "code-review", on: true }], preview: true });
      if (!("before" in preview)) throw new Error("The preview did not return the file.");
      return preview.before;
    },
  });

  const parsed = text.data && selected ? policyFromText(text.data, selected.name) : undefined;
  const applying = useMutation({
    mutationFn: async function apply(changes: readonly PolicyPatchChange[]): Promise<PolicyPatched> {
      if (tenantId === undefined || selected === undefined) throw new Error("The workspace is not known yet.");
      const result = await patchPolicyFile(createHubTransport(), tenantId, { repo: selected.name, source: selected.source, changes });
      if (!("number" in result)) throw new Error("The pull request was not opened.");
      return result;
    },
    onSuccess: async function openedPull(result, changes) {
      if (!selected) return;
      setApplyError("");
      setOpened({ key: repoKey(selected), pull: { number: result.number, url: result.url, state: result.state, headSha: result.headSha, shaAtOpen: file.data?.sha, touched: touchedIds(changes) } });
      await Promise.all([POLICY_UPGRADES_QUERY_KEY, "policy-file", "policy-file-text"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
    },
  });

  const start = useMutation({
    mutationFn: function startFile() {
      if (tenantId === undefined || selected === undefined) throw new Error("The workspace is not known yet.");
      return exportPolicyFile(createHubTransport(), tenantId, selected.name);
    },
    onSuccess: async function started(result) {
      if (!selected) return;
      setOpened({ key: repoKey(selected), pull: { number: result.number, url: result.url, state: "open", headSha: result.headSha, shaAtOpen: file.data?.sha, touched: [] } });
      await queryClient.invalidateQueries({ queryKey: [POLICY_UPGRADES_QUERY_KEY, tenantId] });
    },
  });

  function select(repo: RepoRecord) {
    setPicked(repoKey(repo));
    setApplyError("");
  }

  async function apply(changes: readonly PolicyPatchChange[]) {
    try {
      await applying.mutateAsync(changes);
    } catch (cause) {
      setApplyError(errorText(cause));
      throw cause;
    }
  }

  async function preview(changes: readonly PolicyPatchChange[]) {
    if (tenantId === undefined || selected === undefined) throw new Error("The workspace is not known yet.");
    const result = await patchPolicyFile(createHubTransport(), tenantId, { repo: selected.name, source: selected.source, changes, preview: true });
    if (!("before" in result)) throw new Error("The preview did not return the file.");
    return { before: result.before, after: result.after };
  }

  function merge() {
    if (!pull?.headSha || !selected) return;
    actions.merge.mutate({ number: pull.number, headSha: pull.headSha });
  }

  function body() {
    if (!selected) return <p className="help">No repository is connected yet.</p>;
    if (file.isLoading || (file.data && text.isLoading)) return <p className="help">Loading the policy.</p>;
    if (file.isError) return <p role="alert" className="error">{errorText(file.error)}</p>;
    if (file.data === null) {
      if (pull) return null;
      return (
        <p className="help">This repository has no policy yet. <Button type="button" size="sm" disabled={readOnly || start.isPending} onClick={() => start.mutate()}>Start from {selected.name}&apos;s</Button></p>
      );
    }
    if (file.data?.problem || (parsed && "problem" in parsed)) {
      const reason = file.data?.problem ?? (parsed && "problem" in parsed ? parsed.problem : "");
      return <p className="help">This policy can&apos;t be changed until the file is fixed. {reason}</p>;
    }
    if (text.isError) return <p role="alert" className="error">{errorText(text.error)}</p>;
    if (!parsed || "problem" in parsed) return null;
    return (
      <PolicyEditor
        key={repoKey(selected)}
        repo={selected.name}
        pack={parsed.pack}
        reviewOn={parsed.codeReviewOn}
        hasModel={snapshot?.decisionModel !== undefined}
        hasPlace={snapshot?.codeReviewPlace !== null && snapshot?.codeReviewPlace !== undefined}
        readOnly={readOnly}
        touched={pull?.touched ?? []}
        applying={applying.isPending}
        applyError={applyError}
        preview={preview}
        onApply={apply}
      />
    );
  }

  const host = selected ? HOST_NAME[selected.source] : "GitHub";

  return (
    <main className="settings" id="main">
      <h1>Code review</h1>
      <p className="lede">Rules, judging and code review for one repository, changed by a pull request. The model and where reviews run are set once for every repository.</p>
      <RepoSwitcher repos={repos} selected={selected} onSelect={select} />
      {pull && selected ? <OpenRequest pull={pull} host={host} busy={actions.merge.isPending} onMerge={merge} /> : null}
      {actions.merge.error ? <p role="alert" className="error">{errorText(actions.merge.error)}</p> : null}
      {start.error ? <p role="alert" className="error">{errorText(start.error)}</p> : null}
      {body()}
      <JudgeModel />
      {snapshot ? <CodeReviewSection snapshot={snapshot} /> : null}
    </main>
  );
}
