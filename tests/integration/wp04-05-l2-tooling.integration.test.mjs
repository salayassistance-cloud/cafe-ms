// WP04-05 L2 — disposable integration tests for the four test-only components
// (auth-enabled replica set, credentials, fixture seeder, canonical digest,
// independent verifier).
//
// Scope: TOOLING ONLY. This file does not run the L2 scanner proof, does not
// invoke the production scan CLI, and does not persist any recovery task.
//
// Safety:
//   * every mongod is spawned by this test on 127.0.0.1 and the dedicated port;
//   * the database name is per-run and carries the disposable prefix;
//   * credentials, URIs and hosts are never printed or asserted verbatim;
//   * teardown drops only this run's database and stops only this run's process.
//
// Run: node --test tests/integration/wp04-05-l2-tooling.integration.test.mjs
// Skip (e.g. no local mongod): set WP04_05_L2_SKIP=1.

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import mongoose from "mongoose";
import { ObjectId, deserialize, serialize } from "bson";

import { projectEvidence } from "../../lib/recovery/evidence.js";
import { classifyBundles } from "../../lib/recovery/classifier.js";

import {
  L2_DB_PREFIX,
  L2_MONGOD_PATH,
  L2_PORT,
  startL2Cluster,
  verifyCredentialBoundaries,
} from "./support/wp04-05/l2/l2Cluster.mjs";
import {
  FixtureSeederError,
  assertDisposableTarget,
  reseedFixtures,
  seedFixtures,
} from "./support/wp04-05/l2/l2FixtureSeeder.mjs";
import {
  FIXTURE_CASES,
  WINDOW,
  expectedCollectionCounts,
  fixtureDocuments,
} from "./support/wp04-05/l2/l2FixturePlan.mjs";
import {
  compareSnapshots,
  redactionViolations,
  snapshotDatabase,
  verifyReadOnlyScan,
} from "./support/wp04-05/l2/l2Verifier.mjs";
import { digestDocument } from "./support/wp04-05/l2/canonicalBsonDigest.mjs";

const EXPLICIT_SKIP = process.env.WP04_05_L2_SKIP === "1";
const MONGOD_PRESENT = fs.existsSync(L2_MONGOD_PATH);
const SKIP_REASON = EXPLICIT_SKIP
  ? "WP04_05_L2_SKIP=1"
  : MONGOD_PRESENT
    ? false
    : "local mongod not found";

const COLLECTION_NAMES = Object.freeze([
  "inventoryitems",
  "inventoryreservations",
  "orders",
  "stockmovements",
]);

const CLASSIFY_OPTIONS = Object.freeze({
  now: new Date(WINDOW.until),
  since: new Date(WINDOW.since),
  until: new Date(WINDOW.until),
});

async function withConnection(uri, operation) {
  const connection = await mongoose
    .createConnection(uri, {
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
      maxPoolSize: 2,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 5000,
    })
    .asPromise();
  try {
    return await operation(connection);
  } finally {
    await connection.close();
  }
}

function codes(violations) {
  return violations.map((entry) => entry.code);
}

async function snapshot(cluster) {
  return withConnection(cluster.uriFor("scanner"), (connection) =>
    snapshotDatabase(connection, cluster.dbName),
  );
}

/**
 * Read the fixture database through the read-only scanner account and build a
 * classifier report locally. This is a tooling test: it deliberately does not
 * invoke the production scan CLI (the L2 proof is a separate instruction).
 */
async function buildReportFromScanner(cluster) {
  return withConnection(cluster.uriFor("scanner"), async (connection) => {
    const db = connection.db;
    const [orders, reservations, movements, inventory] = await Promise.all([
      db.collection("orders").find({}).toArray(),
      db.collection("inventoryreservations").find({}).toArray(),
      db.collection("stockmovements").find({}).toArray(),
      db.collection("inventoryitems").find({}).toArray(),
    ]);

    const bundles = orders.map((order) => {
      const orderId = String(order._id);
      return {
        evidence: projectEvidence({
          order,
          reservation: reservations.find((entry) => String(entry.orderId) === orderId) ?? null,
          movements: movements.filter((entry) => String(entry.refOrderId) === orderId),
          inventory,
        }),
      };
    });

    const report = classifyBundles(bundles, CLASSIFY_OPTIONS);
    // The production scanner adds `persisted: false`; mirror that contract.
    return Object.freeze({ ...report, persisted: false });
  });
}

describe(
  "WP04-05 L2 tooling — auth-enabled disposable replica set",
  { skip: SKIP_REASON },
  () => {
    let cluster = null;
    let writerUri = null;

    before(async () => {
      cluster = await startL2Cluster();
      writerUri = cluster.uriFor("writer");
    });

    after(async () => {
      if (cluster) await cluster.stop();
    });

    test("spawns an auth-enabled, loopback-only replica set on the dedicated port", () => {
      assert.equal(cluster.port, L2_PORT);
      assert.equal(cluster.replSet, "bonorecoveryl2rs");
      assert.equal(cluster.dbName.startsWith(L2_DB_PREFIX), true);
      assert.equal(cluster.config.authorization, "enabled");
      assert.equal(cluster.config.keyFile, true);
      const hosts = cluster.config.bindIp.split(",").map((entry) => entry.trim());
      assert.deepEqual(hosts, ["127.0.0.1"]);
      assert.ok(Number.isSafeInteger(cluster.pid) && cluster.pid > 0);
    });

    test("scanner and writer credentials are role-scoped and boundary-proven", async () => {
      const result = await verifyCredentialBoundaries(cluster);

      assert.deepEqual(
        result.scannerRoles.map((role) => `${role.role}@${role.db}`),
        [`read@${cluster.dbName}`],
      );
      assert.deepEqual(
        result.writerRoles.map((role) => `${role.role}@${role.db}`),
        [`readWrite@${cluster.dbName}`],
      );

      const denied = codeSet(result.checks.filter((entry) => entry.denied).map((entry) => entry.check));
      const allowed = codeSet(result.checks.filter((entry) => !entry.denied).map((entry) => entry.check));
      for (const label of [
        "UNAUTHENTICATED_READ",
        "SCANNER_INSERT",
        "SCANNER_CREATE_INDEX",
        "SCANNER_CREATE_COLLECTION",
        "SCANNER_DROP_DATABASE",
        "SCANNER_FOREIGN_READ",
        "WRITER_FOREIGN_DATABASE_INSERT",
        "WRITER_FOREIGN_ADMIN_READ",
        "WRITER_DROP_DATABASE",
      ]) {
        assert.ok(denied.has(label), `${label} was not denied`);
      }
      for (const label of ["SCANNER_READ", "WRITER_INSERT", "WRITER_DROP_OWN_COLLECTION"]) {
        assert.ok(allowed.has(label), `${label} was not allowed`);
      }
    });

    test("seeder refuses non-disposable or non-writer targets before writing", async () => {
      const dbName = `${L2_DB_PREFIX}guard`;
      const valid = `mongodb://127.0.0.1:${L2_PORT}/${dbName}`;

      assert.deepEqual(assertDisposableTarget(valid, dbName), { port: L2_PORT, dbName });

      const refusals = [
        [valid, "bono_recovery_other", "DB_NAMESPACE_REFUSED"],
        [`mongodb://127.0.0.1:27017/${dbName}`, dbName, "URI_PORT_REFUSED"],
        [`mongodb://db.example.com:${L2_PORT}/${dbName}`, dbName, "URI_NON_LOOPBACK_REFUSED"],
        [`mongodb+srv://127.0.0.1/${dbName}`, dbName, "URI_SCHEME_REFUSED"],
        [`mongodb://127.0.0.1:${L2_PORT}/other`, dbName, "URI_DB_MISMATCH"],
        [`mongodb://127.0.0.1:${L2_PORT},127.0.0.1:${L2_PORT}/${dbName}`, dbName, "URI_MULTI_HOST_REFUSED"],
      ];
      for (const [uri, targetDb, code] of refusals) {
        assert.throws(
          () => assertDisposableTarget(uri, targetDb),
          (error) => error instanceof FixtureSeederError && error.code === code,
          `expected ${code}`,
        );
      }

      // The read-only scanner account cannot be used as the fixture writer.
      await assert.rejects(
        seedFixtures({ uri: cluster.uriFor("scanner"), dbName: cluster.dbName }),
        (error) => error instanceof FixtureSeederError && error.code === "WRITER_SCOPE_REFUSED",
      );

      // Interrupted/busy targets are refused too: an occupied database is not re-seeded.
      // (Run after the guard probes; the real seed below happens once.)
    });

    test("writer seeds exactly the four V1 collections with the expected counts", async () => {
      const result = await seedFixtures({ uri: writerUri, dbName: cluster.dbName });
      assert.deepEqual(result.counts, expectedCollectionCounts());
      assert.deepEqual([...result.collections], COLLECTION_NAMES);
      assert.deepEqual([...result.rules], FIXTURE_CASES.map((entry) => entry.rule));

      await assert.rejects(
        seedFixtures({ uri: writerUri, dbName: cluster.dbName }),
        (error) => error instanceof FixtureSeederError && error.code === "DATABASE_NOT_EMPTY",
      );
    });

    test("snapshots preserve BSON types, counts, indexes and a deterministic digest", async () => {
      const first = await snapshot(cluster);
      const second = await snapshot(cluster);
      assert.equal(first.dbName, cluster.dbName);
      assert.deepEqual(
        first.collections.map((entry) => entry.name),
        COLLECTION_NAMES,
      );
      assert.deepEqual(
        Object.fromEntries(first.collections.map((entry) => [entry.name, entry.count])),
        expectedCollectionCounts(),
      );
      assert.equal(first.totalDocuments, 25);
      assert.equal(first.databaseDigest, second.databaseDigest);
      assert.equal(first.indexInventoryDigest, second.indexInventoryDigest);
      assert.equal(JSON.stringify(first), JSON.stringify(second));

      const orders = first.collections.find((entry) => entry.name === "orders");
      assert.ok(orders.indexes.some((index) => index.name === "_id_"));
      assert.match(orders.documentDigest, /^[0-9a-f]{64}$/);
      assert.match(first.databaseDigest, /^[0-9a-f]{64}$/);
    });

    test("independent verifier accepts a read-only scan and proves no mutation", async () => {
      const before = await snapshot(cluster);
      const report = await buildReportFromScanner(cluster);
      const after = await snapshot(cluster);

      const verification = verifyReadOnlyScan({
        before,
        after,
        report,
        repeatReport: await buildReportFromScanner(cluster),
        cases: FIXTURE_CASES,
        forbiddenStrings: [
          cluster.credentialsFor("admin").password,
          cluster.credentialsFor("scanner").password,
          cluster.credentialsFor("writer").password,
        ],
      });

      assert.equal(report.persisted, false);
      assert.equal(report.readOnly, true);
      assert.deepEqual(verification.rulesObserved, [
        "D01",
        "D02",
        "D03",
        "D04",
        "D05",
        "D06",
        "D07",
        "D08",
        "D09",
        "D10",
      ]);
      assert.deepEqual(verification.violations, []);
      assert.equal(verification.ok, true);
      assert.equal(verification.comparison.ok, true);

      const leaks = redactionViolations(report, {
        forbiddenStrings: [
          cluster.credentialsFor("scanner").password,
          cluster.credentialsFor("writer").password,
        ],
      });
      assert.deepEqual(leaks, []);
    });

    test("verifier detects a deliberate count change, then reseed restores the digest", async () => {
      const baseline = await snapshot(cluster);

      await withConnection(writerUri, async (connection) => {
        await connection.db.collection("orders").insertOne({
          _id: new ObjectId(),
          orderNumber: "L2-TAMPER-COUNT",
          createdAt: new Date(WINDOW.since),
          updatedAt: new Date(WINDOW.since),
        });
      });

      const tampered = await snapshot(cluster);
      const comparison = compareSnapshots(baseline, tampered);
      assert.equal(comparison.ok, false);
      assert.ok(codes(comparison.violations).includes("COUNT_CHANGED"));
      assert.ok(codes(comparison.violations).includes("TOTAL_COUNT_CHANGED"));
      assert.ok(codes(comparison.violations).includes("DOCUMENT_DIGEST_CHANGED"));
      assert.ok(codes(comparison.violations).includes("DATABASE_DIGEST_CHANGED"));

      await reseedFixtures({ uri: writerUri, dbName: cluster.dbName });
      const restored = await snapshot(cluster);
      assert.equal(restored.databaseDigest, baseline.databaseDigest);
      assert.equal(compareSnapshots(baseline, restored).ok, true);
    });

    test("verifier detects a value change without a count change", async () => {
      const baseline = await snapshot(cluster);
      const target = FIXTURE_CASES[0].order._id;

      await withConnection(writerUri, async (connection) => {
        await connection.db
          .collection("orders")
          .updateOne({ _id: target }, { $set: { totalAmount: 987654 } });
      });

      const tampered = await snapshot(cluster);
      const comparison = compareSnapshots(baseline, tampered);
      assert.equal(comparison.ok, false);
      assert.equal(comparison.countsMatch, true);
      assert.equal(comparison.digestsMatch, false);
      assert.ok(codes(comparison.violations).includes("DOCUMENT_DIGEST_CHANGED"));
      assert.ok(codes(comparison.violations).includes("DATABASE_DIGEST_CHANGED"));
      assert.equal(codes(comparison.violations).includes("COUNT_CHANGED"), false);

      await reseedFixtures({ uri: writerUri, dbName: cluster.dbName });
      assert.equal((await snapshot(cluster)).databaseDigest, baseline.databaseDigest);
    });

    test("verifier detects an index inventory change", async () => {
      const baseline = await snapshot(cluster);

      await withConnection(writerUri, async (connection) => {
        await connection.db
          .collection("orders")
          .createIndex({ totalAmount: 1 }, { name: "l2_tamper_index" });
      });

      const tampered = await snapshot(cluster);
      const comparison = compareSnapshots(baseline, tampered);
      assert.equal(comparison.ok, false);
      assert.equal(comparison.countsMatch, true);
      assert.equal(comparison.digestsMatch, true);
      assert.equal(comparison.indexesMatch, false);
      assert.ok(codes(comparison.violations).includes("INDEX_SET_CHANGED"));
      assert.ok(codes(comparison.violations).includes("INDEX_INVENTORY_DIGEST_CHANGED"));

      await reseedFixtures({ uri: writerUri, dbName: cluster.dbName });
      assert.equal((await snapshot(cluster)).indexInventoryDigest, baseline.indexInventoryDigest);
    });

    test("redaction check rejects leaked URIs, hosts and secret-shaped values", () => {
      const leaks = redactionViolations({
        note: `mongodb://scanner:${cluster.credentialsFor("scanner").password}@127.0.0.1:${cluster.port}/db`,
        nested: { password: "not-a-real-password" },
      });
      assert.ok(leaks.some((entry) => entry.detail.includes("URI_LEAK")));
      assert.ok(leaks.some((entry) => entry.detail.includes("HOST_LEAK")));
      assert.ok(leaks.some((entry) => entry.detail.includes("SECRET_KEY_LEAK")));
    });

    test("fixture writer cannot write outside its namespace", async () => {
      // Explicit negative control independent of the boundary suite.
      await assert.rejects(
        withConnection(
          `mongodb://${encodeURIComponent(cluster.credentialsFor("writer").username)}:` +
            `${encodeURIComponent(cluster.credentialsFor("writer").password)}@127.0.0.1:${cluster.port}/` +
            `${L2_DB_PREFIX}escaped?directConnection=true&replicaSet=${cluster.replSet}` +
            `&authSource=${cluster.dbName}`,
          (connection) =>
            connection.db.collection("probe").insertOne({ escaped: true }),
        ),
        (error) => error?.code === 13 || error?.codeName === "Unauthorized",
      );
    });

    test("the digest of the seeded documents equals the plan digest", async () => {
      // Proves the writer/reader round-trip preserves every canonical byte that
      // the digest covers (types, nesting, dates, ObjectIds and key ordering).
      const seeded = await withConnection(cluster.uriFor("scanner"), async (connection) => {
        const docs = await connection.db
          .collection("orders")
          .find({}, { promoteValues: false })
          .toArray();
        return docs.sort((left, right) =>
          left._id.toHexString() < right._id.toHexString() ? -1 : 1,
        );
      });
      const expected = fixtureDocuments().orders
        .map((document) => deserialize(serialize(document), { promoteValues: false }))
        .sort((left, right) => (left._id.toHexString() < right._id.toHexString() ? -1 : 1));
      assert.equal(seeded.length, expected.length);
      seeded.forEach((document, index) => {
        assert.equal(digestDocument(document), digestDocument(expected[index]));
      });
    });
  },
);

function codeSet(values) {
  return new Set(values);
}
