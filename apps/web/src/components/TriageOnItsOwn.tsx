import { useState, type ChangeEvent } from "react";
import { Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, hostKinds, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import { DeniedNotice } from "../lib/denied.tsx";
import { findTriageRole, GRID_KINDS, hostCased, triageScope, type TriageScope } from "../lib/automation-grid.ts";
import { canRemoveGrant, type CreateGrantInput } from "../lib/grant-actions.ts";
import type { HubGrant, HubRole, RepoRecord } from "../lib/hub-api.ts";
import { DO_NAMES } from "../lib/pack-prose.ts";

const EVERYWHERE = "*";

type TriageOnItsOwnProps = {
  roles: HubRole[];
  grants: HubGrant[];
  repos: RepoRecord[];
  loading: boolean;
  denied: boolean;
  disabled: boolean;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  removeGrants: (grants: readonly HubGrant[]) => Promise<void>;
  onError: (message: string) => void;
};

type GrantChipProps = { label: string; action: string; grant: HubGrant; disabled: boolean; onRemove: (grant: HubGrant) => void };

/** A built-in grant cannot be removed, so it shows without its ×. */
function GrantChip({ label, action, grant, disabled, onRemove }: GrantChipProps) {
  return (
    <span className="glob">
      {label}
      {canRemoveGrant(grant) && <button type="button" aria-label={`Stop ${action} on its own in ${label}`} disabled={disabled} onClick={() => onRemove(grant)}>×</button>}
    </span>
  );
}

type ScopeRowProps = {
  kind: ActionKind;
  scope: TriageScope;
  repos: RepoRecord[];
  disabled: boolean;
  add: (kind: ActionKind, repo: string) => void;
  remove: (kind: ActionKind, grant: HubGrant) => void;
};

function ScopeRow({ kind, scope, repos, disabled, add, remove }: ScopeRowProps) {
  const name = DO_NAMES[kind];
  const listed = new Set(scope.repos.map((entry) => entry.repo));
  const names = repos.map((repo) => repo.name);
  const addable = repos.filter((repo) => hostKinds(repo.source).includes(kind) && !listed.has(repo.name.toLowerCase())).map((repo) => repo.name);
  const { everywhere } = scope;

  function pick(event: ChangeEvent<HTMLSelectElement>) {
    add(kind, event.target.value);
  }

  function removeGrant(grant: HubGrant) {
    remove(kind, grant);
  }

  return (
    <TableRow>
      <TableCell>{name}</TableCell>
      <TableCell>
        <span className="tokens">
          {scope.locked && <span className="glob">All repositories, through a grant of every action</span>}
          {everywhere && <GrantChip label="All repositories" action={name} grant={everywhere} disabled={disabled} onRemove={removeGrant} />}
          {scope.repos.map((entry) => <GrantChip key={entry.repo} label={hostCased(names, entry.repo)} action={name} grant={entry.grant} disabled={disabled} onRemove={removeGrant} />)}
          {!scope.locked && (
            <Select className="add-repo" aria-label={`Add a repository where Triage does ${name} on its own`} value="" disabled={disabled} onChange={pick}>
              <option value="" disabled>Add repository…</option>
              {!everywhere && <option value={EVERYWHERE}>All repositories</option>}
              {addable.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
            </Select>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

export default function TriageOnItsOwn({ roles, grants, repos, loading, denied, disabled, addGrant, removeGrants, onError }: TriageOnItsOwnProps) {
  const [pending, setPending] = useState(false);
  const triage = findTriageRole(roles);

  async function change(kind: ActionKind, run: () => Promise<void>) {
    setPending(true);
    onError("");
    try {
      await run();
    } catch (cause) {
      onError(`Could not change where Triage does ${DO_NAMES[kind].toLowerCase()} on its own. ${errorText(cause)} Try again.`);
    } finally {
      setPending(false);
    }
  }

  function add(kind: ActionKind, repo: string) {
    if (!triage) return;
    void change(kind, async function grantRepo() {
      await addGrant({ roleId: triage.id, resource: doResource(kind, repo), action: DO_GRANT_ACTION });
    });
  }

  function remove(kind: ActionKind, grant: HubGrant) {
    void change(kind, async function revokeRepo() {
      await removeGrants([grant]);
    });
  }

  return (
    <section className="sec" aria-labelledby="sec-triage-alone">
      <header>
        <h2 id="sec-triage-alone">What Triage does on its own</h2>
        <p>Triage performs this without asking in the repositories listed. An action with none listed waits for approval everywhere.</p>
      </header>
      <div>
        {denied && <DeniedNotice section="access rules" />}
        {!denied && !loading && !triage && <p className="muted">This workspace has no {TRIAGE_ROLE} role, so Triage asks before every action.</p>}
        {!denied && !loading && triage && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Repositories</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {GRID_KINDS.map((kind) => (
                <ScopeRow key={kind} kind={kind} scope={triageScope(triage, kind, grants)} repos={repos} disabled={disabled || pending} add={add} remove={remove} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
