import { useState, type FormEvent } from "react";
import type { Action, RepoRole } from "@corbits/triage-contracts";
import { removeRole, rolesUsed, setRole } from "../../lib/pack-draft.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import { CloseIcon } from "../inbox-icons.tsx";
import TokenList from "./TokenList.tsx";

type RolesEditorProps = { roles: Record<string, RepoRole>; actions: Action[]; disabled: boolean; edit: RepoPack["edit"] };

/** Named groups of people and teams that actions assign or request review from. */
export default function RolesEditor({ roles, actions, disabled, edit }: RolesEditorProps) {
  const [name, setName] = useState("");
  const missing = [...new Set(actions.flatMap(rolesUsed))].filter((role) => !Object.hasOwn(roles, role));
  const fresh = name.trim();

  function set(role: string, patch: RepoRole) {
    edit((current) => setRole(current, role, { ...current.policy.roles[role], ...patch }));
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fresh || Object.hasOwn(roles, fresh)) return;
    set(fresh, { users: [], teams: [] });
    setName("");
  }

  return (
    <section className="rs" aria-labelledby="rs-roles">
      <h3 id="rs-roles">Roles <span className="n">{Object.keys(roles).length}</span></h3>
      <p>People and teams an action can assign or ask for review by name.</p>
      <div className="sentences">
        {missing.map((role) => (
          <div key={role} className="sentence invalid" id={`rp-role-${role}`}>
            <span className="txt"><span className="mk flag">!</span><b>{role}</b> is used by an action but not defined.</span>
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => set(role, { users: [], teams: [] })}>Define it</button>
          </div>
        ))}
        {Object.entries(roles).map(([role, members]) => (
          <div key={role} className="sentence role">
            <span className="txt">
              <b>{role}</b>
              <TokenList values={members.users ?? []} noun="person" placeholder="login" disabled={disabled} onChange={(users) => set(role, { users })} />
              <TokenList values={members.teams ?? []} noun="team" placeholder="@org/team" disabled={disabled} onChange={(teams) => set(role, { teams })} />
            </span>
            <button type="button" className="btn btn-quiet btn-sm icon" aria-label={`Remove role ${role}`} disabled={disabled} onClick={() => edit((current) => removeRole(current, role))}><CloseIcon /></button>
          </div>
        ))}
        <form className="sentence" onSubmit={add} aria-label="Add a role">
          <span className="txt"><input className="val w" aria-label="Role name" placeholder="maintainers" disabled={disabled} value={name} onChange={(event) => setName(event.target.value)} /></span>
          <button type="submit" className="btn btn-sm" disabled={disabled || !fresh || Object.hasOwn(roles, fresh)}>Add role</button>
        </form>
      </div>
    </section>
  );
}
