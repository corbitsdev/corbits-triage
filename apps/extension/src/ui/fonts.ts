import redHatDisplay from "@fontsource-variable/red-hat-display/files/red-hat-display-latin-wght-normal.woff2?url";
import spaceMono400 from "@fontsource/space-mono/files/space-mono-latin-400-normal.woff2?url";
import spaceMono700 from "@fontsource/space-mono/files/space-mono-latin-700-normal.woff2?url";

/** Registered under the family names the Corbits theme asks for; Fontsource's variable font names itself differently. */
export function loadFonts(): void {
  document.fonts.add(new FontFace("Red Hat Display", `url(${redHatDisplay}) format("woff2")`, { weight: "300 900" }));
  document.fonts.add(new FontFace("Space Mono", `url(${spaceMono400}) format("woff2")`, { weight: "400" }));
  document.fonts.add(new FontFace("Space Mono", `url(${spaceMono700}) format("woff2")`, { weight: "700" }));
}
