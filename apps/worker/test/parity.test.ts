// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import {
  blobStoreContract,
  databaseContract,
  usageLedgerContract,
} from "../../../test/contract/storage";
import type { Env } from "../src/env";

const env = workerEnv as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

databaseContract("D1", () => env.DB);
blobStoreContract("R2", () => env.FILES);
usageLedgerContract("D1", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  return env.DB;
});
