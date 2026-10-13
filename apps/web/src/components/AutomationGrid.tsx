import { useState } from "react";
import { Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { DO_GRANT_ACTION, doResource, type ActionKind } from "@corbits/triage-contracts";
import { DeniedNotice } from "../lib/denied.tsx";
import { GRID_KINDS, gridCell, gridRoles, roleName, type GridCell } from "../lib/automation-grid.ts";
import type { CreateGrantInput } from "../lib/grant-actions.ts";
import type { HubGrant, HubRole } from "../lib/hub-api.ts";
import { DO_NAMES } from "../lib/pack-prose.ts";

type AutomationGridProps = {
  roles: HubRole[];
  grants: HubGrant[];
  loading: boolean;
  denied: boolean;
  disabled: boolean;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  removeGrants: (grants: readonly HubGrant[]) => Promise<void>;
  onError: (message: string) => void;
};

/** Who may approve each kind of Do, and which kinds triage runs without asking, on every repository. */
export default function AutomationGrid({ roles, grants, loading, denied, disabled, addGrant, removeGrants, onError }: AutomationGridProps) {
  const [pending, setPending] = useState<string | null>(null);
  const columns = gridRoles(roles);

  async function toggle(role: HubRole, kind: ActionKind, cell: GridCell) {
    if (cell.repos.length > 0 && !window.confirm(`Turn off ${DO_NAMES[kind]} for ${roleName(role)} on ${cell.repos.join(", ")}?`)) return;
    setPending(`${role.id}:${kind}`);
    onError("");
    try {
      if (cell.granted) await removeGrants(cell.grants);
      else await addGrant({ roleId: role.id, resource: doResource(kind, "*"), action: DO_GRANT_ACTION });
    } catch (cause) {
      onError(`Could not change who may ${DO_NAMES[kind].toLowerCase()}. ${errorText(cause)} Try again.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="sec" aria-labelledby="sec-access">
      <header>
        <h2 id="sec-access">Access</h2>
        <p>Who may approve each held action, and which ones Triage runs on its own.</p>
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
                  {columns.map((role) => {
                    const cell = gridCell(role, kind, grants);
                    return (
                      <TableCell key={role.id}>
                        <Switch
                          checked={cell.granted}
                          onCheckedChange={() => void toggle(role, kind, cell)}
                          label={`${roleName(role)}: ${DO_NAMES[kind]}`}
                          disabled={disabled || cell.locked || pending !== null}
                        />
                        {cell.repos.length > 0 && <span className="mono repos">{cell.repos.join(", ")}</span>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
