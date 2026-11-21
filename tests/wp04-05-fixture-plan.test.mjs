// WP04-05 L2 — synthetic D01–D10 fixture plan tests (DB-FREE).
//
// These tests prove the fixture plan is complete, deterministic and genuinely
// exercises all ten classifier rules through the real (unmodified) evidence
// projector and classifier. They create no connection and write nothing.

import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { projectEvidence } from "../lib/recovery/evidence.js";
import { classifyBundles } from "../lib/recovery/classifier.js";

import { digestDocument } from "./integration/support/wp04-05/l2/canonicalBsonDigest.mjs";
import {
  COLLECTIONS,
  EXPECTED_RULES,
  FIXTURE_CASES,
  INVENTORY_ITEMS,
  WINDOW,
  caseEvidenceInput,
  expectedCollectionCounts,
  fixtureDocuments,
} from "./integration/support/wp04-05/l2/l2FixturePlan.mjs";

const CLASSIFY_OPTIONS = Object.freeze({
  now: new Date(WINDOW.until),
  since: new Date(WINDOW.since),
  until: new Date(WINDOW.until),
});

function projectCase(entry) {
  return projectEvidence(caseEvidenceInput(entry));
}

function classifyOne(entry) {
  return classifyBundles([{ evidence: projectCase(entry) }], CLASSIFY_OPTIONS);
}

function codes(report) {
  return report.findings.map((finding) => `${finding.rule}/${finding.code}`).sort();
}

describe("WP04-05 L2 fixture plan — shape", () => {
  test("declares exactly one case per D01–D10 rule", () => {
    assert.equal(FIXTURE_CASES.length, 10);
    assert.deepEqual([...EXPECTED_RULES], [
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
    assert.equal(new Set(EXPECTED_RULES).size, EXPECTED_RULES.length);
    for (const entry of FIXTURE_CASES) {
      assert.equal(entry.rule.startsWith("D"), true);
      assert.ok(entry.order && typeof entry.order === "object");
      assert.ok(Array.isArray(entry.expected) && entry.expected.length > 0);
      assert.ok(Array.isArray(entry.allowedExtra));
    }
  });

  test("collection names match the persisted V1 collection names", () => {
    assert.equal(COLLECTIONS.orders, "orders");
    assert.equal(COLLECTIONS.reservations, "inventoryreservations");
    assert.equal(COLLECTIONS.movements, "stockmovements");
    assert.equal(COLLECTIONS.inventory, "inventoryitems");
    assert.deepEqual(
      Object.keys(expectedCollectionCounts()).sort(),
      Object.values(COLLECTIONS).sort(),
    );
  });

  test("document counts are exact and every fixture is inside the scan window", () => {
    const documents = fixtureDocuments();
    assert.deepEqual(expectedCollectionCounts(), {
      orders: 10,
      inventoryreservations: 6,
      stockmovements: 6,
      inventoryitems: 3,
    });
    assert.equal(documents.orders.length, 10);
    assert.equal(documents.reservations.length, 6);
    assert.equal(documents.movements.length, 6);
    assert.equal(documents.inventory.length, INVENTORY_ITEMS.length);

    const since = new Date(WINDOW.since).getTime();
    const until = new Date(WINDOW.until).getTime();
    assert.ok(since < until);
    for (const order of documents.orders) {
      assert.ok(order.createdAt instanceof Date, `${order.orderNumber} createdAt must be a Date`);
      assert.ok(order.updatedAt instanceof Date, `${order.orderNumber} updatedAt must be a Date`);
      assert.ok(order.createdAt.getTime() >= since, `${order.orderNumber} is before the window`);
      assert.ok(order.updatedAt.getTime() < until, `${order.orderNumber} is after the window`);
    }
  });

  test("plan construction is deterministic and frozen", () => {
    const first = fixtureDocuments();
    const second = fixtureDocuments();
    assert.equal(digestDocument(first), digestDocument(second));
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(FIXTURE_CASES), true);
    assert.equal(digestDocument(FIXTURE_CASES), digestDocument(FIXTURE_CASES));
  });

  test("fixtures contain no credential or secret-shaped keys", () => {
    const text = JSON.stringify(fixtureDocuments());
    for (const forbidden of [
      "password",
      "passwd",
      "credential",
      "secret",
      "authorization",
      "connectionString",
      "mongodb://",
    ]) {
      assert.equal(text.includes(forbidden), false, `fixture plan leaked ${forbidden}`);
    }
  });
});

describe("WP04-05 L2 fixture plan — classification coverage", () => {
  for (const entry of FIXTURE_CASES) {
    test(`${entry.rule} produces its expected finding and no unexplained finding`, () => {
      const report = classifyOne(entry);
      const observed = codes(report);
      const expected = entry.expected.map((item) => `${item.rule}/${item.code}`).sort();
      const allowed = entry.allowedExtra.map((item) => `${item.rule}/${item.code}`).sort();

      for (const code of expected) {
        assert.ok(observed.includes(code), `${entry.rule} did not emit ${code}; observed ${observed}`);
      }
      const unexplained = observed.filter(
        (code) => !expected.includes(code) && !allowed.includes(code),
      );
      assert.deepEqual(unexplained, [], `${entry.rule} emitted unexplained findings`);
    });
  }

  test("classifying all fixtures together still covers D01–D10", () => {
    const bundles = FIXTURE_CASES.map((entry) => ({ evidence: projectCase(entry) }));
    const report = classifyBundles(bundles, CLASSIFY_OPTIONS);
    const observedRules = [...new Set(report.findings.map((finding) => finding.rule))].sort();
    assert.deepEqual(observedRules, [...EXPECTED_RULES]);

    for (const entry of FIXTURE_CASES) {
      for (const expected of entry.expected) {
        const matched = report.findings.some(
          (finding) =>
            finding.rule === expected.rule &&
            finding.code === expected.code &&
            finding.orderNumber === entry.order.orderNumber,
        );
        assert.ok(
          matched,
          `${expected.rule}/${expected.code} was not attributed to ${entry.order.orderNumber}`,
        );
      }
    }
  });

  test("every finding is read-only and never creates a recovery task", () => {
    const bundles = FIXTURE_CASES.map((entry) => ({ evidence: projectCase(entry) }));
    const report = classifyBundles(bundles, CLASSIFY_OPTIONS);
    assert.ok(report.findings.length > 0);
    assert.equal(report.readOnly, true);
    for (const finding of report.findings) {
      assert.equal(finding.readOnly, true);
      assert.equal(finding.autoRecovery, "PROHIBITED");
      assert.equal(finding.createsRecoveryTask, false);
      assert.equal(finding.task, null);
    }
  });

  test("classification is deterministic across repeated runs", () => {
    const bundles = FIXTURE_CASES.map((entry) => ({ evidence: projectCase(entry) }));
    const first = classifyBundles(bundles, CLASSIFY_OPTIONS);
    const second = classifyBundles(bundles, CLASSIFY_OPTIONS);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});
