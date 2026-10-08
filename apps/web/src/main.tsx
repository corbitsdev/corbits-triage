import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "sonner/dist/styles.css";
import "@corbits/react-ui/styles.css";
import "./index.css";
import "./inbox.css";

const root = document.getElementById("root");
if (!root) throw new Error("Portal root missing.");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
