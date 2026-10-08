import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "@corbits/react-ui/styles.css";
import "./index.css";
import "./inbox.css";
import "./onboarding.css";
import "./repositories.css";

const root = document.getElementById("root");
if (!root) throw new Error("Portal root missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
