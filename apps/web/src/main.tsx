// SPDX-License-Identifier: Apache-2.0
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createMockTransport } from "./chat/mock-transport";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Mocked until the Assistant DO transport (M2-13) lands.
const transport = createMockTransport();

createRoot(root).render(
  <StrictMode>
    <App transport={transport} />
  </StrictMode>,
);
