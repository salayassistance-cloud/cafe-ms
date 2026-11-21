// scripts/export-raw-collections.mjs — owner-run raw BSON export for the BONO
// sanitized stored-unit audit (Phase 2, Step 9). Replaces the `mongodump` step
// of the approved pipeline (docs/inventory-stored-unit-audit-export-spec.md
// §6.2) without installing any MongoDB tools.
//
// STRICTLY READ-ONLY BY CONSTRUCTION
// - The only database operation performed is `find` (no filter) on the six
//   approved collections. No insert/update/delete/aggregate-with-$out, no
//   indexes, no profiling, no admin commands.
// - The database name is fixed to `hotel_management`; any other value is
//   refused.
// - The dedicated read-only URI must be supplied at runtime: `--uri <uri>` or
//   the `BONO_EXPORT_URI` environment variable. This script never reads
//   `.env`, `.env.local` or any other file for credentials, and never prints
//   the URI.
// - Refuses to run without the explicit `--confirm-read-only-export` flag.
// - Refuses to overwrite existing collection files without `--overwrite`.
//
// OUTPUT
//   <output>/<collection>.bson          raw BSON document stream (mongodump shape)
//   <output>/raw-export-meta.json       counts + SHA-256 digests only (no secrets)
//
// The .bson files are then converted offline with
// lib/offlineExport/bsonToCanonical.mjs and fed to the offline sanitizer.
//
// NOTE: this script is NOT executed by any test or by the agent. Running it is
// an owner action under the §7.3 authorization.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export const APPROVED_DATABASE = "hotel_management";

export const APPROVED_COLLECTIONS = Object.freeze([
  "inventoryitems",
  "recipes",
  "stockmovements",
  "inventoryaudits",
  "inventoryreservations",
  "orders",
]);

export const CONFIRM_FLAG = "--confirm-read-only-export";
export const URI_ENV_VAR = "BONO_EXPORT_URI";
export const TOOL_NAME = "bono-raw-readonly-export";
export const TOOL_VERSION = "1.0.0";
export const DEFAULT_BATCH_SIZE = 1000;

export const USAGE = [
  "usage: node scripts/export-raw-collections.mjs --output <dir> --confirm-read-only-export",
  "         [--uri <mongodb-uri>] [--batch-size <n>] [--overwrite]",
  "",
  "  --output <dir>               local directory for <collection>.bson + raw-export-meta.json",
  "  --confirm-read-only-export   required; acknowledges a find-only export",
  "  --uri <mongodb-uri>          dedicated read-only URI (or set BONO_EXPORT_URI)",
  "  --batch-size <n>             cursor batch size (default 1000)",
  "  --overwrite                  allow replacing existing <collection>.bson files",
  "",
  `The database is fixed to "${APPROVED_DATABASE}" and the collections are fixed to:`,
  `  ${APPROVED_COLLECTIONS.join(", ")}`,
  "The URI is never logged. No environment file is read.",
].join("\n");

// Masks anything credential-shaped in text that may be printed on error.
export function redactSecrets(text) {
  return String(text)
    .replace(/mongodb(\+srv)?:\/\/[^\s"'`]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|pwd|secret|token|pass)=([^&\s"'`]+)/gi, "$1=[redacted]");
}

// Pure argument parser (exported for offline tests). Never touches the
// filesystem or a database. `env` is injectable so tests never load real env.
export function parseArgs(argv, env = process.env) {
  const config = {
    outputDir: undefined,
    uri: undefined,
    database: APPROVED_DATABASE,
    batchSize: DEFAULT_BATCH_SIZE,
    overwrite: false,
    confirmed: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--output": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: "--output requires a directory" };
        config.outputDir = value;
        i += 1;
        break;
      }
      case "--uri": {
        const value = argv[i + 1];
        if (!value || value.startsWith("--")) return { ok: false, error: "--uri requires a value" };
        config.uri = value;
        i += 1;
        break;
      }
      case "--batch-size": {
        const value = argv[i + 1];
        if (!value || !/^\d+$/.test(value) || Number(value) < 1) {
          return { ok: false, error: "--batch-size requires a positive integer" };
        }
        config.batchSize = Number(value);
        i += 1;
        break;
      }
      case "--overwrite":
        config.overwrite = true;
        break;
      case CONFIRM_FLAG:
        config.confirmed = true;
        break;
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }

  if (!config.outputDir) return { ok: false, error: "--output is required" };
  if (!config.confirmed) {
    return {
      ok: false,
      error: `refusing to run without ${CONFIRM_FLAG}; this exports data from the approved database`,
    };
  }
  if (config.database !== APPROVED_DATABASE) {
    return { ok: false, error: `database is fixed to "${APPROVED_DATABASE}"` };
  }

  if (!config.uri) config.uri = env?.[URI_ENV_VAR];
  if (!config.uri) {
    return {
      ok: false,
      error: `no URI supplied at runtime; pass --uri or set ${URI_ENV_VAR} (no env file is read)`,
    };
  }
  if (!/^mongodb(\+srv)?:\/\/\S+$/.test(config.uri)) {
    return { ok: false, error: "--uri must be a mongodb:// or mongodb+srv:// URI" };
  }
  return { ok: true, config };
}

function safeError(err) {
  const message = err && typeof err.message === "string" ? err.message : String(err);
  return redactSecrets(message);
}

async function exportCollection(db, name, outDir, batchSize) {
  const file = join(outDir, `${name}.bson`);
  const hash = createHash("sha256");
  let documents = 0;

  async function* rawDocuments() {
    const cursor = db.collection(name).find({}, { raw: true, batchSize });
    for await (const doc of cursor) {
      // Fail closed if the driver ever hands back a decoded (lossy) value.
      if (!Buffer.isBuffer(doc)) {
        throw new Error(`driver returned a non-raw document for ${name}; refusing lossy export`);
      }
      hash.update(doc);
      documents += 1;
      yield doc;
    }
  }

  await pipeline(Readable.from(rawDocuments()), createWriteStream(file));
  return {
    file: `${name}.bson`,
    documents,
    bytes: statSync(file).size,
    sha256: hash.digest("hex"),
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`EXPORT REFUSED: ${parsed.error}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const { config } = parsed;
  const outDir = resolve(config.outputDir);

  if (!config.overwrite) {
    const existing = APPROVED_COLLECTIONS.filter((c) => existsSync(join(outDir, `${c}.bson`)));
    if (existing.length > 0) {
      console.error(`EXPORT REFUSED: output already contains ${existing.join(", ")}.bson (use --overwrite)`);
      process.exitCode = 2;
      return;
    }
  }
  mkdirSync(outDir, { recursive: true });

  // Dynamic import so importing this module for argument tests never loads the
  // driver (and therefore can never connect).
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(config.uri, {
    appName: TOOL_NAME,
    serverSelectionTimeoutMS: 15000,
  });

  try {
    await client.connect();
    const db = client.db(APPROVED_DATABASE);
    const meta = {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      exportedAt: new Date().toISOString(),
      readOnly: true,
      commandSurface: ["find"],
      database: APPROVED_DATABASE,
      collections: {},
    };

    for (const name of APPROVED_COLLECTIONS) {
      const entry = await exportCollection(db, name, outDir, config.batchSize);
      meta.collections[name] = entry;
      console.log(`${name}: ${entry.documents} documents (${entry.bytes} bytes)`);
    }

    writeFileSync(join(outDir, "raw-export-meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    console.log(`export written to ${outDir}`);
  } catch (err) {
    console.error(`EXPORT FAILED: ${safeError(err)}`);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
