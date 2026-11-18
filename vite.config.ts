import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Lets the speech model use every processor core. Without these it still works, on one core. */
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { include: ["@huggingface/transformers"] },
  worker: { format: "es" },
});
