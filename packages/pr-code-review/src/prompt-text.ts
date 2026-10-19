// The tags the review's messages wrap pull request text in. Only a `<` that would open or close one of them is
// rewritten, so code with arrows, generics or markup reaches the model as written.
const TAGS = [
  "pull_request", "title", "description", "diff", "changed_files", "plan", "findings", "finding", "candidate",
  "quoted_code", "file", "cited_code", "repository", "budget", "stopped_early",
];
// A model may still read a tag broken up by invisible format characters, or by spaces after its slash.
const TAG_START = new RegExp(`<(?=\\p{Cf}*(?:/[\\s\\p{Cf}]*)?(?:${TAGS.join("|")})\\b)`, "gu");

/** Text from the pull request, its files or a model's reply about them, unable to open or close a prompt tag. */
export function promptText(text: string): string {
  return text.replace(TAG_START, "\\u003c");
}

/** `promptText` for a double-quoted tag attribute, which a `"` would otherwise end. */
export function promptAttribute(text: string): string {
  return promptText(text).replaceAll('"', "&quot;");
}
