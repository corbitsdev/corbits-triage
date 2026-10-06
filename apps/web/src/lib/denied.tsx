// PortalSnapshot.denied marks sections the hub refused with 403, distinct from
// an empty list, so callers render this instead of their empty-list copy.
export function DeniedNotice({ section }: { section: string }) {
  return (
    <div role="alert" className="denied">
      <p>You do not have access to {section}. Ask an administrator for access.</p>
    </div>
  );
}
