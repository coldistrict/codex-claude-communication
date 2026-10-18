import { render } from "preact";
import { App } from "./app.tsx";
import "./styles.css";

// Apply a stored explicit theme before the first paint. CSP forbids inline
// scripts, so this module (loaded before any markup exists) is the earliest
// point available. "system" leaves the attribute off and follows the OS.
try {
  const stored = localStorage.getItem("collab.theme");
  if (stored === "light" || stored === "dark") document.documentElement.dataset.theme = stored;
} catch {
  // Storage unavailable: follow the OS preference.
}

// Opening a launch link in an existing tab can be a same-document navigation.
// Restart bootstrap for capability fragments; ordinary anchors stay in-page.
window.addEventListener("hashchange", () => {
  if (/^#[A-Za-z0-9_-]{43}$/.test(window.location.hash)) window.location.reload();
});

render(<App />, document.getElementById("app")!);
