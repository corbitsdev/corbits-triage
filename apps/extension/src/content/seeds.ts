import { findCommentBox, insertDraft, setBox } from "./comment-box.ts";
import { openBodyField } from "./editors.ts";

/** Where Triage puts text for the person to finish: GitHub's comment box, or the description's editor. */
export type SeedSpot = "composer" | "body";

/** Text Triage put in one of GitHub's fields, by the action it came from; the person can take it back out in one click. */
export type Seed = { key: string; spot: SeedSpot; title: string; field: HTMLTextAreaElement; added: string };

export type Seeder = {
  /** Fills the comment box with a draft while it is empty, without moving focus or the page. */
  fillComposer(key: string, title: string, body: string): boolean;
  /** Adds a draft to the comment box at the person's request, focused and scrolled to. */
  insertComposer(key: string, title: string, body: string): void;
  /** Adds text to the end of the description's open editor, unless it already holds it. */
  appendBody(key: string, title: string, text: string, focus: boolean): boolean;
  /** The seed in a spot while its field is on the page and still ends with the text. */
  live(spot: SeedSpot): Seed | undefined;
  undo(spot: SeedSpot): void;
};

/** A seed stays Triage's only while the person has not written after it: the field still ends with what Triage added. */
function untouched(seed: Seed): boolean {
  return seed.field.isConnected && seed.field.value.endsWith(seed.added);
}

/** `onUndo` hears that a seed was taken back out. */
export function seeder(onUndo: () => void): Seeder {
  const seeds = new Map<SeedSpot, Seed>();

  function live(spot: SeedSpot): Seed | undefined {
    const seed = seeds.get(spot);
    if (seed && untouched(seed)) return seed;
    seeds.delete(spot);
    return undefined;
  }

  function fillComposer(key: string, title: string, body: string): boolean {
    const box = findCommentBox();
    // A box the person is in may be about to take their own words.
    if (!box || box.value.trim() || document.activeElement === box || live("composer")) return false;
    setBox(box, body);
    seeds.set("composer", { key, spot: "composer", title, field: box, added: body });
    return true;
  }

  function insertComposer(key: string, title: string, body: string) {
    insertDraft(body);
    seeds.set("composer", { key, spot: "composer", title, field: findCommentBox()!, added: body });
  }

  function appendBody(key: string, title: string, text: string, focus: boolean): boolean {
    const field = openBodyField();
    if (!field || field.value.includes(text.trim()) || live("body")) return false;
    const value = field.value.trim() ? `${field.value.trimEnd()}\n\n${text}` : text;
    setBox(field, value);
    if (focus || document.activeElement === field) {
      field.focus();
      field.setSelectionRange(value.length, value.length);
    }
    seeds.set("body", { key, spot: "body", title, field, added: text });
    return true;
  }

  function undo(spot: SeedSpot) {
    const seed = live(spot);
    if (!seed) return;
    const { value } = seed.field;
    const joined = `\n\n${seed.added}`;
    setBox(seed.field, value.slice(0, value.length - (value.endsWith(joined) ? joined.length : seed.added.length)));
    seeds.delete(spot);
    onUndo();
  }

  return { fillComposer, insertComposer, appendBody, live, undo };
}
