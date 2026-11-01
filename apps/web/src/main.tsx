// SPDX-License-Identifier: Apache-2.0
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createMockTransport } from "./chat/mock-transport";
import { createSocketTransport } from "./chat/socket-transport";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The e2e tests and a `vite dev` without a Worker build with `VITE_MOCK_CHAT=1`.
const transport =
  import.meta.env.VITE_MOCK_CHAT === "1" ? createMockTransport() : createSocketTransport();

createRoot(root).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
