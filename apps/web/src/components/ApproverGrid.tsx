import { useState } from "react";
import { Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, type ActionKind } from "@corbits/triage-contracts";
import { DeniedNotice } from "../lib/denied.tsx";
import { GRID_KINDS, gridCell, gridRoles, hostCased, roleName, type GridCell } from "../lib/automation-grid.ts";
import type { CreateGrantInput } from "../lib/grant-actions.ts";
import type { HubGrant, HubRole } from "../lib/hub-api.ts";
import { DO_NAMES } from "../lib/pack-prose.ts";

type ApproverGridProps = {
  roles: HubRole[];
  grants: HubGrant[];
  repos: string[];
  loading: boolean;
  denied: boolean;
  disabled: boolean;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  removeGrants: (grants: readonly HubGrant[]) => Promise<void>;
  onError: (message: string) => void;
};

type ApproverCellProps = { role: HubRole; kind: ActionKind; grants: HubGrant[]; repos: string[]; disabled: boolean; toggle: (role: HubRole, kind: ActionKind, cell: GridCell) => void };

function ApproverCell({ role, kind, grants, repos, disabled, toggle }: ApproverCellProps) {
  const held = gridCell(role, kind, grants);
  const cell = { ...held, repos: held.repos.map((repo) => hostCased(repos, repo)) };
  // A locked cell holds the action through a wider grant, so it reads as a fact rather than a dead switch.
  if (cell.locked) return <TableCell><span className="model">always</span></TableCell>;
  return (
    <TableCell>
      <Switch
        className="sw"
        checked={cell.granted}
        onCheckedChange={() => toggle(role, kind, cell)}
        label={`${roleName(role)} may approve ${DO_NAMES[kind]}`}
        disabled={disabled}
      />
      {cell.repos.length > 0 && <span className="model">only in {cell.repos.join(", ")}</span>}
    </TableCell>
  );
}

export default function ApproverGrid({ roles, grants, repos, loading, denied, disabled, addGrant, removeGrants, onError }: ApproverGridProps) {
  const [pending, setPending] = useState<string | null>(null);
  const columns = gridRoles(roles);

  async function toggle(role: HubRole, kind: ActionKind, cell: GridCell) {
    if (cell.repos.length > 0 && !window.confirm(`Stop ${roleName(role)} approving ${DO_NAMES[kind]} on ${cell.repos.join(", ")}?`)) return;
    setPending(`${role.id}:${kind}`);
    onError("");
    try {
      if (cell.granted) await removeGrants(cell.grants);
      else await addGrant({ roleId: role.id, resource: doResource(kind, "*"), action: DO_GRANT_ACTION });
    } catch (cause) {
      onError(`Could not change who may approve ${DO_NAMES[kind].toLowerCase()}. ${errorText(cause)} Try again.`);
    } finally {
      setPending(null);
    }
  }

  function startToggle(role: HubRole, kind: ActionKind, cell: GridCell) {
    void toggle(role, kind, cell);
  }

  return (
    <section className="sec" aria-labelledby="sec-approvers">
      <header>
        <h2 id="sec-approvers">Who may approve a held action</h2>
        <p>A held action waits in the inbox until someone with a ticked role approves it.</p>
      </header>
      <div>
        {denied && <DeniedNotice section="access rules" />}
        {!denied && !loading && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                {columns.map((role) => <TableHead key={role.id}>{roleName(role)}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {GRID_KINDS.map((kind) => (
                <TableRow key={kind}>
                  <TableCell>{DO_NAMES[kind]}</TableCell>
                  {columns.map((role) => <ApproverCell key={role.id} role={role} kind={kind} grants={grants} repos={repos} disabled={disabled || pending !== null} toggle={startToggle} />)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
