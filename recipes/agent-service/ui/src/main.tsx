import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

/*
 * assistant-ui's stylesheet is a Tailwind v4 artifact that declares an empty
 * `@layer theme` and expects the consumer to fill it — every measurement in it
 * reads `--spacing`, `--text-sm`, `--radius-3xl`. Without those it collapses,
 * which is exactly how it first looked. Tailwind's theme layer alone supplies
 * them; its preflight is not imported, because assistant-ui scopes its own
 * reset to `.aui-thread-root` and a global one would flatten the chrome.
 */
import "./theme.css";
import "@assistant-ui/styles/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root to mount into");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
