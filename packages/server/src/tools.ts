// SPDX-License-Identifier: Apache-2.0
// The built-in tools. Each registers with its manifest (M3-02 AC1); the tools themselves arrive
// with M3-08. Settings › Apps & tools lists what is here.
import { ToolRegistry } from "@opa/policy";

export const builtinTools = new ToolRegistry();
