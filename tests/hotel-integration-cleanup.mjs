#!/usr/bin/env node
// Separate, explicit Hotel disposable-MongoDB integration cleanup command.
//
// This command is never imported or invoked by the integration test. It exists
// so an operator can remove test data only after inspecting the retained
// ownership marker and supplying both independent confirmation signals:
//
//   1. the --confirm CLI argument; and
//   2. HOTEL_TEST_ALLOW_CLEANUP=I_CONFIRM_DELETE_DISPOSABLE_MONGODB_DATA.
//
// It reuses the authoritative integration guard. The guard re-verifies the live
// target, the exact ownership marker, and the collection allowlist before and
// after deleting Hotel documents. It never drops a database, collection, or
// index. If any verification fails, the marker is retained.

import process from "node:process";
import { pathToFileURL } from "node:url";

import { connectToHotelDatabase, disconnectHotelDatabase } from "../lib/hotel/db/connection.js";
import {
  assertHotelIntegrationCleanupRequest,
  formatHotelIntegrationError,
  installHotelIntegrationRuntimeEnvironment,
  readHotelIntegrationOwnershipMarker,
  safeHotelIntegrationError,
} from "./helpers/hotel-integration-harness.mjs";
import {
  cleanupHotelIntegrationTarget,
  verifyHotelIntegrationConnection,
} from "./helpers/hotel-integration-guard.mjs";

const LOG_PREFIX = "[hotel:integration:cleanup]";

function defaultLog(message) {
  console.log(message);
}

function defaultErrorLog(message) {
  console.error(message);
}

export async function runHotelIntegrationCleanupCli({
  argv = process.argv.slice(2),
  env = process.env,
  connect = connectToHotelDatabase,
  disconnect = disconnectHotelDatabase,
  log = defaultLog,
  errorLog = defaultErrorLog,
} = {}) {
  let request;
  try {
    request = assertHotelIntegrationCleanupRequest({ argv, env });
  } catch (error) {
    errorLog(`${LOG_PREFIX} ${formatHotelIntegrationError(error)}`);
    errorLog(
      `${LOG_PREFIX} Cleanup not attempted. Supply --confirm and the exact cleanup confirmation environment value.`
    );
    return 2;
  }

  // Preserve the pre-mapping environment for the guard's own cleanup check. The
  // guard refuses any inherited Hotel/POS URI or secret, so this snapshot must
  // not contain the runtime ROOM_MONGODB_URI mapping installed below.
  const cleanupEnv = { ...env };
  const secrets = [request.config.mongoUri];

  let connection = null;
  let runtime = null;

  try {
    runtime = installHotelIntegrationRuntimeEnvironment({
      config: request.config,
      env,
      includeSessionSecret: false,
    });

    connection = await connect();
    await verifyHotelIntegrationConnection({
      connection,
      expectedTarget: request.config.target,
    });

    const ownership = await readHotelIntegrationOwnershipMarker({
      connection,
      expectedTarget: request.config.target,
    });

    const result = await cleanupHotelIntegrationTarget({
      connection,
      expectedTarget: request.config.target,
      ownership,
      env: cleanupEnv,
    });

    log(
      `${LOG_PREFIX} Deleted Hotel integration data from ${result.deletedCollections.length} allowed collection(s).`
    );
    log(`${LOG_PREFIX} Ownership marker released for run ${ownership.runId}.`);
    return 0;
  } catch (error) {
    const safe = safeHotelIntegrationError(error, { secrets });
    errorLog(`${LOG_PREFIX} ${safe.code}: ${safe.message}`);
    errorLog(
      `${LOG_PREFIX} Cleanup did not complete; the ownership marker is retained unless the guard confirmed release.`
    );
    return 1;
  } finally {
    if (connection) {
      await disconnect().catch(() => {});
    }
    if (runtime) runtime.restore();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const exitCode = await runHotelIntegrationCleanupCli();
  process.exitCode = exitCode;
}
