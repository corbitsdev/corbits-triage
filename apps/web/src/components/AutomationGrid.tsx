import { useState } from "react";
import { Switch } from "@corbits/react-ui";
import { DO_GRANT_ACTION, doResource, type ActionKind } from "@corbits/triage-contracts";
import { DeniedNotice } from "../lib/denied.tsx";
import { GRID_KINDS, gridCell, gridRoles, roleColumnName } from "../lib/automation-grid.ts";
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
  removeGrant: (grant: HubGrant) => Promise<void>;
  onError: (message: string) => void;
};

/** Who may approve each kind of Do, and which kinds triage runs without asking, on every repository. */
export default function AutomationGrid({ roles, grants, loading, denied, disabled, addGrant, removeGrant, onError }: AutomationGridProps) {
  const [pending, setPending] = useState<string | null>(null);
  const columns = gridRoles(roles);

  async function toggle(role: HubRole, kind: ActionKind, granted: HubGrant[]) {
    setPending(`${role.id}:${kind}`);
    onError("");
    try {
      if (granted.length > 0) for (const grant of granted) await removeGrant(grant);
      else await addGrant({ roleId: role.id, resource: doResource(kind, "*"), action: DO_GRANT_ACTION, effect: "allow" });
    } catch (cause) {
      onError(`Could not change who may ${DO_NAMES[kind].toLowerCase()}. ${cause instanceof Error ? cause.message : String(cause)} Try again.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="panel settings-panel" aria-label="Actions">
      <h2>Actions</h2>
      <p className="field-help">Who may approve each held Do, and which Dos triage runs without asking. Triage posts its reply when it holds Comment and its labels when it holds Labels.</p>
      {denied && <DeniedNotice section="access rules" />}
      {!denied && !loading && (
        <table>
          <thead>
            <tr>
              <th>Do</th>
              {columns.map((role) => <th key={role.id}>{roleColumnName(role)}</th>)}
            </tr>
          </thead>
          <tbody>
            {GRID_KINDS.map((kind) => (
              <tr key={kind}>
                <td>{DO_NAMES[kind]}</td>
                {columns.map((role) => {
                  const cell = gridCell(role, kind, grants);
                  return (
                    <td key={role.id}>
                      <Switch
                        className="sw"
                        checked={cell.granted}
                        onCheckedChange={() => void toggle(role, kind, cell.grants)}
                        label={`${roleColumnName(role)}: ${DO_NAMES[kind]}`}
                        disabled={disabled || cell.locked || pending !== null}
                      />
                      {cell.repos.length > 0 && <span className="mono muted small-text"> {cell.repos.join(", ")}</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
