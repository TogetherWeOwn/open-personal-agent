// SPDX-License-Identifier: Apache-2.0
// The built-in tools. Settings › Apps & tools lists what is here: the manifests come from the
// tools themselves (`@opa/tools-builtin`, the memory tools, the task tool), so the page always
// names the same tools the engine can call. Only manifests live here — the registry never
// executes, so no ports or services are needed.
import { FORGET_MANIFEST, RECALL_MANIFEST, REMEMBER_MANIFEST } from "@opa/db/memory-tools";
import { TASK_MANIFEST } from "@opa/db/task-tools";
import { ToolRegistry } from "@opa/policy";
import {
  CREATE_ARTIFACT_MANIFEST,
  READ_FILE_MANIFEST,
  SEARCH_HISTORY_MANIFEST,
  WEB_FETCH_MANIFEST,
} from "@opa/tools-builtin";

export const builtinTools = new ToolRegistry();

for (const manifest of [
  WEB_FETCH_MANIFEST,
  SEARCH_HISTORY_MANIFEST,
  CREATE_ARTIFACT_MANIFEST,
  READ_FILE_MANIFEST,
  REMEMBER_MANIFEST,
  RECALL_MANIFEST,
  FORGET_MANIFEST,
  TASK_MANIFEST,
])
  builtinTools.register({ manifest });
