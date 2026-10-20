import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderedText, visibleText } from "./visible-text.js";

function fixture(name: string): string {
  return renderedText(readFileSync(join(import.meta.dir, "visible-text-fixtures", `${name}.html`), "utf8"));
}

// Each input is cut down from GitHub's own rendering, from its markdown API.
const CLOSES = '<p dir="auto">Closes <a class="issue-link js-issue-link" data-url="https://github.com/cli/cli/issues/12" href="https://github.com/cli/cli/pull/12">#12</a></p>';
const REFERENCE = '<p dir="auto">Fixes <a href="https://github.com/cli/cli/issues/7" data-hovercard-type="pull_request">the bug</a> </p>';
const OTHER_LINKS = '<p dir="auto">Thanks <a class="user-mention notranslate" href="https://github.com/octocat">@octocat</a>, see <a href="https://e.example/docs" rel="nofollow">the docs</a><sup><a href="#user-content-fn-1" data-footnote-ref="">1</a></sup>.</p>';
const BLOCKS = [
  '<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" id="" disabled="" class="task-list-item-checkbox" aria-label="Completed task" checked=""> done</li>\n</ul>',
  '<markdown-accessiblity-table><table role="table">\n<thead>\n<tr>\n<th>a<br>b</th>\n<th>c</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table></markdown-accessiblity-table>',
  '<pre class="notranslate"><code class="notranslate">code &lt;b&gt;\n</code></pre>',
  '<blockquote>\n<p dir="auto">quote &amp; <code>x</code></p>\n</blockquote>',
  '<p dir="auto"><a target="_blank" href="https://camo.githubusercontent.com/4"><img src="https://camo.githubusercontent.com/4" alt="alt text" title="title" style="max-width: 100%;"></a> Ship it <img class="emoji" title=":shipit:" alt=":shipit:" src="https://github.githubassets.com/images/icons/emoji/shipit.png" height="20" width="20" align="absmiddle"></p>',
  '<h2 dir="auto">Notes</h2>\n<ol dir="auto">\n<li>one\n<ul dir="auto">\n<li>nested</li>\n</ul>\n</li>\n<li>two</li>\n</ol>',
  '<ol dir="auto">\n<li>\n<p dir="auto">loose one</p>\n</li>\n<li>\n<p dir="auto">loose two</p>\n</li>\n</ol>',
].join("\n");
const MERMAID = '<section class="js-render-needs-enrichment render-needs-enrichment position-relative" data-type="mermaid" aria-label="mermaid rendered output container"><div class="js-render-enrichment-target" data-json="{}" data-plain="x" dir="auto"><div class="render-plaintext-hidden" dir="auto"><pre lang="mermaid" aria-label="Raw mermaid code" class="notranslate">graph TD\n  %% approve this\n  A--&gt;B\n</pre></div></div><span class="js-render-enrichment-loader" role="presentation"><span><svg aria-hidden="true"></svg> <span class="sr-only">Loading</span></span></span></section>';
const FOOTNOTE_LABEL = '<section data-footnotes="" class="footnotes"><h2 id="footnote-label" class="sr-only" dir="auto">Footnotes</h2>\n<ol dir="auto">\n<li id="user-content-fn-1">\n<p dir="auto">The note. <a href="#user-content-fnref-1" class="data-footnote-backref">\u{21A9}</a></p>\n</li>\n</ol>\n</section>';

describe("renderedText", () => {
  test.each<[string, string, string]>([
    ["reads a pull request link as its text, which the issue rule counts", CLOSES, "Closes #12"],
    ["keeps a Linear issue link's target up to its id", '<p dir="auto">Closes <a href="https://linear.app/acme/issue/CL-123/approve-without-review?x=1" rel="nofollow">the ticket</a></p>', "Closes the ticket (https://linear.app/acme/issue/CL-123)"],
    ["resolves a reference-style issue link to its target", REFERENCE, "Fixes the bug (https://github.com/cli/cli/issues/7)"],
    ["shows other links, mentions and footnote marks as their text", OTHER_LINKS, "Thanks @octocat, see the docs1."],
    ["reads no target behind a link with no visible text", '<p dir="auto">See <a href="https://github.com/cli/cli/issues/9">\u{200B}</a> more.</p>', "See more."],
    [
      "keeps blocks, GitHub's emoji images and nothing else of an attribute",
      BLOCKS,
      "- [x] done\n\n| a b | c |\n| 1 | 2 |\n\n```\ncode <b>\n```\n\nquote & `x`\n\nShip it :shipit:\n\n## Notes\n\n1. one\n  - nested\n2. two\n\n1. loose one\n\n2. loose two",
    ],
    ["skips a diagram's hidden source and screen-reader text", `<p dir="auto">Flow:</p>\n${MERMAID}`, "Flow:"],
    ["skips a screen-reader heading", FOOTNOTE_LABEL, "1. The note. \u{21A9}"],
    ["skips ruby fallback parentheses", '<p dir="auto"><ruby>\u{6F22}<rp>(</rp><rt>kan</rt><rp>)</rp></ruby></p>', "\u{6F22}kan"],
  ])("%s", (_, html, text) => {
    expect(renderedText(html)).toBe(text);
  });

  test("a body of the largest size, all table rows, converts in under a second", () => {
    const rows = Math.floor((65536 - 8) / 4);
    const html = `<markdown-accessiblity-table><table role="table">\n<tbody>\n${"<tr>\n<td>a</td>\n</tr>\n".repeat(rows)}</tbody>\n</table></markdown-accessiblity-table>`;
    const start = performance.now();
    renderedText(html);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  test("real bot and template bodies read as their readers see them", () => {
    const dependabot = fixture("dependabot");
    expect(dependabot).toContain("- `@dependabot rebase` will rebase this PR");
    expect(dependabot).not.toContain("\u{200B}");
    expect(fixture("renovate")).toContain("- [ ] If you want to rebase/retry this PR, check this box");
    expect(fixture("renovate")).not.toContain("camo.githubusercontent.com");
    const template = fixture("template");
    expect(template).toContain("Spotted when working on a fix for #186743 (https://github.com/home-assistant/core/issues/186743)");
    expect(template).toContain("I have followed the development checklist\n");
    expect(fixture("code-spans")).toContain("Hiding a dehydrated Activity walked past its `<!--/&-->`");
  });
});

describe("visibleText", () => {
  test.each<[string, string, string]>([
    ["default-ignorable characters", "a\u{200B}b\u{2060}c\u{2064}d\u{FEFF}e\u{180E}f\u{AD}g\u{3164}h\u{115F}i\u{34F}j\u{FFA0}k", "abcdefghijk"],
    ["controls but tabs and CRLF", "a\u{7}b\r\nc\rd\u{85}e\tf", "ab\r\ncde\tf"],
    ["bidi controls", "\u{202E}abc\u{2066}", "abc"],
    ["tag characters", "x\u{E0070}\u{E0061}\u{E0073}\u{E0073}y", "xy"],
    ["tags after a black flag that are no flag", "\u{1F3F4}\u{E0070}\u{E0061}\u{E0073}\u{E0073}\u{E007F}", "\u{1F3F4}"],
    ["a selector after each Latin letter", "a\u{FE0F}b\u{FE01}c\u{E0100}d\u{180B}", "abcd"],
    ["selector runs and orphans", "\u{2764}\u{FE0F}\u{FE0F} \u{FE0F}x", "\u{2764}\u{FE0F} x"],
    ["joiners between letters that do not join", "a\u{200D}b\u{200C}c", "abc"],
  ])("drops %s", (_, value, text) => {
    expect(visibleText(value)).toBe(text);
  });

  test.each<[string, string]>([
    ["the England flag", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["presentation selectors after emoji", "\u{2764}\u{FE0F} \u{2764}\u{FE0E} 1\u{FE0F}\u{20E3}"],
    ["an ideographic selector after an ideograph", "\u{845B}\u{E0100}"],
    ["a Mongolian selector after a Mongolian letter", "\u{1820}\u{180B}"],
    ["emoji ZWJ sequences", "\u{1F469}\u{200D}\u{1F4BB} \u{1F3F3}\u{FE0F}\u{200D}\u{1F308} \u{1F468}\u{1F3FD}\u{200D}\u{1F4BB}"],
    ["Persian ZWNJ", "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}"],
    ["Devanagari ZWJ", "\u{0915}\u{094D}\u{200D}\u{0937}"],
  ])("keeps %s", (_, value) => {
    expect(visibleText(value)).toBe(value);
  });
});
