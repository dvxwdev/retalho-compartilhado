import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot, buildProjectFile } from "./ui/actions";
import { App } from "./ui/App";
import { getState } from "./ui/store";
import "./ui/styles.css";

if (import.meta.env.DEV) {
  // Lets the end-to-end script read editor state; absent from production builds.
  Object.assign(window, { __retalho: { getState, buildProjectFile } });
}

if (import.meta.env.DEV || import.meta.env.VITE_RETALHO_AUTOMATION === "1") {
  // The agent bridge, window.retalho. A normal production build leaves it out entirely.
  void import("./ui/automation").then(({ installAutomation }) => installAutomation());
}

void boot()
  .catch((error) => console.error("Não foi possível restaurar o projeto salvo", error))
  .finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
