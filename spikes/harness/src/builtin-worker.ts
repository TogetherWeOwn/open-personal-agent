// SPDX-License-Identifier: Apache-2.0
import { createBuiltinHarness } from "./builtin";
import { SessionBase, worker } from "./host";
import { createMockProvider } from "./shared";

export class BuiltinSession extends SessionBase {
  protected readonly harness = createBuiltinHarness(createMockProvider());
}

export default worker;
