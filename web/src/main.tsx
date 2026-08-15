import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { convex, convexConfigError } from "./lib/convex";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

root.render(
  <StrictMode>
    {convex ? (
      <ConvexAuthProvider client={convex} shouldHandleCode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexAuthProvider>
    ) : (
      <main className="config-error">
        <img src="/images/app-icon.png" alt="" />
        <h1>RoboTube needs its Convex URL</h1>
        <p>{convexConfigError}</p>
      </main>
    )}
  </StrictMode>,
);
