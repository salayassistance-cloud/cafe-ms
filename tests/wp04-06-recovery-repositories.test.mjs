// WP04-06 R-1 — Read-only repository factory tests (DB-free).
//
// No connection is opened and no driver is imported. Fakes implement only the
// single read primitive the adapter is allowed to call.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  INVENTORY_PROJECTION,
  MOVEMENT_PROJECTION,
  ORDER_PROJECTION,
  RESERVATION_PROJECTION,
  collectEvidence,
} from "../lib/recovery/adapter.js";
import { createFakeRepositories } from "./helpers/recovery-fakes.mjs";
import {
  DEFAULT_MAX_LIMIT,
  HARD_MAX_LIMIT,
  REPOSITORY_VERSION,
  RepositoryError,
  createDriverCollectionRepository,
  createMongooseRepository,
  createReadOnlyRepository,
  createReadOnlyRepositories,
  normalizeDocument,
  toDriverValue,
} from "../lib/recovery/repositories.js";

const SINCE = "2026-11-10T00:00:00.000Z";
const HEX = "a1b2c3d4e5f60718293a4b5c";

function fakeObjectId(hex = HEX) {
  return { _bsontype: "ObjectId", toHexString: () => hex };
}

function readOnly(name = "orders", find = async () => []) {
  return createReadOnlyRepository({ name, find });
}

describe("WP04-06 R-1 read-only repository factory", () => {
  it("exposes exactly one enumerable key and no write/model/connection/database surface", () => {
    const repository = readOnly();
    assert.equal(REPOSITORY_VERSION, "wp04-readonly-repository-v1");
    assert.deepEqual(Object.keys(repository), ["findBounded"]);
    assert.equal(Object.isFrozen(repository), true);
    for (const forbidden of [
      "insertOne",
      "insertMany",
      "updateOne",
      "updateMany",
      "replaceOne",
      "deleteOne",
      "deleteMany",
      "bulkWrite",
      "createIndex",
      "createIndexes",
      "dropIndex",
      "dropIndexes",
      "syncIndexes",
      "createCollection",
      "dropCollection",
      "dropDatabase",
      "collection",
      "db",
      "connection",
      "model",
      "find",
      "aggregate",
      "watch",
    ]) {
      assert.equal(repository[forbidden], undefined, `${forbidden} must not be reachable`);
    }
  });

  it("rejects invalid configuration", () => {
    assert.throws(() => createReadOnlyRepository(null), /INVALID_CONFIG|config/);
    assert.throws(() => createReadOnlyRepository({ name: "", find: () => [] }), RepositoryError);
    assert.throws(() => createReadOnlyRepository({ name: "orders", find: "nope" }), RepositoryError);
    assert.throws(
      () => createReadOnlyRepository({ name: "orders", find: () => [], maxLimit: 1e9 }),
      RepositoryError,
    );
    assert.throws(
      () => createReadOnlyRepository({ name: "orders", find: () => [], maxLimit: 0 }),
      RepositoryError,
    );
  });

  it("enforces a positive limit inside the configured ceiling", async () => {
    const repository = createReadOnlyRepository({
      name: "orders",
      maxLimit: 10,
      find: async () => [],
    });
    await assert.rejects(
      () => repository.findBounded({}, { _id: 1 }, { limit: 11 }),
      (error) => error.code === "INVALID_LIMIT",
    );
    await assert.rejects(
      () => repository.findBounded({}, { _id: 1 }, { limit: 0 }),
      (error) => error.code === "INVALID_LIMIT",
    );
    await assert.rejects(
      () => repository.findBounded({}, { _id: 1 }, {}),
      (error) => error.code === "INVALID_LIMIT",
    );
    assert.equal(DEFAULT_MAX_LIMIT, 5000);
    assert.equal(HARD_MAX_LIMIT, 10000);
  });

  it("accepts only a single consistent projection shape", async () => {
    const repository = readOnly();
    await assert.rejects(
      () => repository.findBounded({}, { a: 1, b: 0 }, { limit: 5 }),
      (error) => error.code === "INVALID_PROJECTION",
    );
    await assert.rejects(
      () => repository.findBounded({}, { $natural: 1 }, { limit: 5 }),
      (error) => error.code === "INVALID_PROJECTION",
    );
    await assert.rejects(
      () => repository.findBounded({}, {}, { limit: 5 }),
      (error) => error.code === "INVALID_PROJECTION",
    );
    await assert.rejects(
      () => repository.findBounded({}, { a: "1" }, { limit: 5 }),
      (error) => error.code === "INVALID_PROJECTION",
    );
    await assert.rejects(
      () => repository.findBounded({}, { a: 1 }, { limit: 5, sort: { a: 0 } }),
      (error) => error.code === "INVALID_SORT",
    );
  });

  it("accepts nested projections while preserving strict validation", async () => {
    const repository = readOnly();
    const captured = [];
    const capturing = createReadOnlyRepository({
      name: "orders",
      find: async (filter, projection) => {
        captured.push(projection);
        return [];
      },
    });

    const nestedInclude = {
      _id: 1,
      paymentAccountSnapshot: { _id: 1 },
      items: {
        lineId: 1,
        components: { stockQuantity: 1 },
      },
    };

    await capturing.findBounded({}, nestedInclude, { limit: 5 });
    assert.deepEqual(captured[0], nestedInclude);

    // Nested exclusion is valid when the whole projection is exclusion.
    await repository.findBounded({}, { status: 0, items: { secret: 0 } }, { limit: 5 });

    // The top-level _id exception is preserved.
    await repository.findBounded({}, { _id: 0, items: { lineId: 1 } }, { limit: 5 });
    await repository.findBounded({}, { _id: 1, status: 0 }, { limit: 5 });

    for (const projection of [
      { items: { lineId: 1, secret: 0 } },
      { status: 1, items: { secret: 0 } },
      { items: {} },
      { items: { lineId: "1" } },
      { items: [{ lineId: 1 }] },
      { items: { $slice: 1 } },
      { items: { nested: { keep: 1, _id: 0 } } },
    ]) {
      await assert.rejects(
        () => repository.findBounded({}, projection, { limit: 5 }),
        (error) => error.code === "INVALID_PROJECTION",
        JSON.stringify(projection),
      );
    }
  });

  it("accepts every adapter projection through the read-only repository", async () => {
    const captured = [];
    const repository = createReadOnlyRepository({
      name: "probe",
      find: async (filter, projection) => {
        captured.push(projection);
        return [];
      },
    });
    const projections = [
      ORDER_PROJECTION,
      RESERVATION_PROJECTION,
      MOVEMENT_PROJECTION,
      INVENTORY_PROJECTION,
    ];
    for (const projection of projections) {
      await repository.findBounded({}, projection, { limit: 1 });
    }
    assert.deepEqual(captured, projections);
  });

  it("rejects server-side JavaScript and write operators anywhere in the filter", async () => {
    const repository = readOnly();
    for (const filter of [
      { $where: "this.a === 1" },
      { status: { $expr: { $eq: ["$status", "PAID"] } } },
      { $and: [{ $function: { body: "return true" } }] },
      { nested: [{ $accumulator: {} }] },
      { $out: "other" },
      { $merge: { into: "other" } },
      { $lookup: { from: "other" } },
    ]) {
      await assert.rejects(
        () => repository.findBounded(filter, { _id: 1 }, { limit: 5 }),
        (error) => error.code === "FORBIDDEN_OPERATOR",
      );
    }
  });

  it("normalizes BSON ObjectIds to $oid tags in returned documents", async () => {
    const objectId = fakeObjectId();
    const repository = readOnly("orders", async () => [
      { _id: objectId, nested: { item: objectId }, list: [objectId] },
    ]);
    const result = await repository.findBounded({}, { _id: 1 }, { limit: 5 });
    assert.deepEqual(result.docs[0]._id, { $oid: HEX });
    assert.deepEqual(result.docs[0].nested.item, { $oid: HEX });
    assert.deepEqual(result.docs[0].list[0], { $oid: HEX });
    assert.equal(
      normalizeDocument({ a: new Date("2026-01-01T00:00:00.000Z") }).a.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("translates $oid tags back into driver ObjectIds for the query", async () => {
    class FakeObjectId {
      constructor(hex) {
        this.hex = hex;
        this._bsontype = "ObjectId";
      }
      toHexString() {
        return this.hex;
      }
    }
    const captured = [];
    const collection = {
      find(filter, options) {
        captured.push({ filter, options });
        return {
          limit() {
            return this;
          },
          sort() {
            return this;
          },
          async toArray() {
            return [{ _id: new FakeObjectId(HEX) }];
          },
        };
      },
    };
    const repository = createDriverCollectionRepository({
      name: "orders",
      collection,
      ObjectId: FakeObjectId,
    });
    const projection = {
      _id: 1,
      items: { lineId: 1, components: { stockQuantity: 1 } },
    };
    const result = await repository.findBounded(
      { _id: { $in: [{ $oid: HEX }] } },
      projection,
      { limit: 5 },
    );
    assert.ok(captured[0].filter._id.$in[0] instanceof FakeObjectId);
    assert.equal(captured[0].filter._id.$in[0].hex, HEX);
    assert.deepEqual(captured[0].options.projection, projection);
    assert.deepEqual(result.docs[0]._id, { $oid: HEX });
  });

  it("reports truncation instead of silently returning an unbounded page", async () => {
    const docs = [{ _id: fakeObjectId("000000000000000000000001") }, { _id: fakeObjectId("000000000000000000000002") }, { _id: fakeObjectId("000000000000000000000003") }];
    let observedLimit = null;
    const repository = createReadOnlyRepository({
      name: "orders",
      find: async (filter, projection, limit) => {
        observedLimit = limit;
        return docs.slice(0, limit);
      },
    });
    const result = await repository.findBounded({}, { _id: 1 }, { limit: 2 });
    assert.equal(observedLimit, 3, "the factory asks for one extra document");
    assert.equal(result.truncated, true);
    assert.equal(result.docs.length, 2);

    const flagged = createReadOnlyRepository({
      name: "orders",
      find: async () => ({ docs: [], truncated: true }),
    });
    const flaggedResult = await flagged.findBounded({}, { _id: 1 }, { limit: 2 });
    assert.equal(flaggedResult.truncated, true);
  });

  it("fails closed in the adapter when a repository reports truncation", async () => {
    const base = createFakeRepositories();
    const repositories = {
      orders: { findBounded: async () => ({ docs: [], truncated: true }) },
      reservations: base.reservations,
      movements: base.movements,
      inventory: base.inventory,
    };
    await assert.rejects(
      () => collectEvidence(repositories, { since: SINCE }),
      (error) => error.code === "EVIDENCE_BOUND_EXCEEDED" && error.field === "orders",
    );

    const tooMany = {
      ...repositories,
      orders: {
        findBounded: async () => Array.from({ length: 3 }, () => ({ _id: fakeObjectId() })),
      },
    };
    await assert.rejects(
      () => collectEvidence(tooMany, { since: SINCE, maxOrders: 2 }),
      (error) => error.code === "EVIDENCE_BOUND_EXCEEDED",
    );
  });

  it("propagates query errors unchanged without wrapping payloads", async () => {
    const sentinel = new Error("query failed for private payload");
    const repository = createReadOnlyRepository({
      name: "orders",
      find: async () => {
        throw sentinel;
      },
    });
    await assert.rejects(
      () => repository.findBounded({}, { _id: 1 }, { limit: 5 }),
      (error) => error === sentinel,
    );

    const base = createFakeRepositories();
    const repositories = {
      orders: {
        findBounded: async () => {
          throw sentinel;
        },
      },
      reservations: base.reservations,
      movements: base.movements,
      inventory: base.inventory,
    };
    await assert.rejects(
      () => collectEvidence(repositories, { since: SINCE }),
      (error) => error === sentinel,
    );
  });

  it("builds the four adapter repositories and refuses a missing primitive", () => {
    const repository = readOnly();
    const repositories = createReadOnlyRepositories({
      orders: repository,
      reservations: repository,
      movements: repository,
      inventory: repository,
    });
    assert.deepEqual(Object.keys(repositories).sort(), [
      "inventory",
      "movements",
      "orders",
      "reservations",
    ]);
    assert.equal(Object.isFrozen(repositories), true);
    assert.throws(
      () =>
        createReadOnlyRepositories({
          orders: {},
          reservations: repository,
          movements: repository,
          inventory: repository,
        }),
      (error) => error.code === "INVALID_REPOSITORY",
    );
    assert.throws(() => createReadOnlyRepositories(null), RepositoryError);
  });

  it("bridges a Mongoose model without exposing it", async () => {
    class FakeObjectId {
      constructor(hex) {
        this.hex = hex;
        this._bsontype = "ObjectId";
      }
      toHexString() {
        return this.hex;
      }
    }
    const captured = [];
    const model = {
      base: { Types: { ObjectId: FakeObjectId } },
      find(filter, projection) {
        captured.push({ filter, projection });
        return {
          sort() {
            return this;
          },
          limit() {
            return this;
          },
          lean() {
            return this;
          },
          async exec() {
            return [{ _id: new FakeObjectId(HEX) }];
          },
        };
      },
    };
    const repository = createMongooseRepository({ name: "orders", model });
    assert.deepEqual(Object.keys(repository), ["findBounded"]);
    const projection = { _id: 1, items: { lineId: 1 } };
    const result = await repository.findBounded(
      { _id: { $in: [{ $oid: HEX }] } },
      projection,
      { limit: 5 },
    );
    assert.ok(captured[0].filter._id.$in[0] instanceof FakeObjectId);
    assert.deepEqual(captured[0].projection, projection);
    assert.deepEqual(result.docs[0]._id, { $oid: HEX });

    assert.throws(
      () => createMongooseRepository({ name: "orders", model: {} }),
      (error) => error.code === "INVALID_MODEL",
    );
  });

  it("round-trips $oid tags without losing other structures", () => {
    class FakeObjectId {
      constructor(hex) {
        this.hex = hex;
      }
    }
    const translated = toDriverValue(
      { a: { $oid: HEX }, b: [{ $oid: HEX }], c: 1 },
      FakeObjectId,
    );
    assert.ok(translated.a instanceof FakeObjectId);
    assert.ok(translated.b[0] instanceof FakeObjectId);
    assert.equal(translated.c, 1);
  });

  it("preserves Date boundaries when translating a filter for the driver", () => {
    const since = new Date("2026-11-10T00:00:00.000Z");
    const until = new Date("2026-11-11T00:00:00.000Z");
    const translated = toDriverValue(
      { updatedAt: { $gte: since, $lte: until }, nested: [{ at: since }] },
      class FakeObjectId {},
    );
    assert.ok(translated.updatedAt.$gte instanceof Date);
    assert.ok(translated.updatedAt.$lte instanceof Date);
    assert.equal(translated.updatedAt.$gte.getTime(), since.getTime());
    assert.equal(translated.updatedAt.$lte.getTime(), until.getTime());
    assert.notEqual(translated.updatedAt.$gte, since);
    assert.ok(translated.nested[0].at instanceof Date);
    assert.equal(translated.nested[0].at.getTime(), since.getTime());
  });
});
