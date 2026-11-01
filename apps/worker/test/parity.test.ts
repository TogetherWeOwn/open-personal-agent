// SPDX-License-Identifier: Apache-2.0
import { env as workerEnv } from "cloudflare:workers";
import { blobStoreContract, databaseContract } from "../../../test/contract/storage";
import type { Env } from "../src/env";

const env = workerEnv as unknown as Env;

databaseContract("D1", () => env.DB);
blobStoreContract("R2", () => env.FILES);
