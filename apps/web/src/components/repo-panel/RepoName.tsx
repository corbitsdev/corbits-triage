/** `owner/name`, its owner in a span a phone sets on its own line, so the name breaks only where it has a hyphen. */
export default function RepoName({ name }: { name: string }) {
  const at = name.indexOf("/") + 1;
  return <><span className="repo-own">{name.slice(0, at)}</span>{name.slice(at)}</>;
}
