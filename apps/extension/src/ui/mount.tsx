import "@corbits/react-ui/styles.css";
import "./app.css";
import { ThemeProvider } from "@corbits/react-ui";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { loadFonts } from "./fonts.ts";

export function mount(page: ReactNode): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("Page root missing.");
  loadFonts();
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider storageKey="corbits-triage-theme">{page}</ThemeProvider>
    </StrictMode>,
  );
}
