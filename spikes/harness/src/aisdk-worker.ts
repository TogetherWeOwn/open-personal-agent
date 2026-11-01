// SPDX-License-Identifier: Apache-2.0
import { createAISDKHarness } from "./aisdk";
import { SessionBase, worker } from "./host";
import { createMockProvider } from "./shared";

export class AISDKSession extends SessionBase {
  protected readonly harness = createAISDKHarness(createMockProvider());
}

export default worker;
