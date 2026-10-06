// SPDX-License-Identifier: GPL-2.0-only
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Portal root missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
