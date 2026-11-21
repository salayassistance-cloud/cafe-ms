// DB-free helpers for the Phase 2.1 policyVersion serialization tests.
// Adds a minimal transaction session and a conditional MenuItem
// findOneAndUpdate to existing in-memory connection stubs.

export function normalizeVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : 0;
}

export function versionMatches(value, expected) {
  const current = normalizeVersion(value);
  if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
    return expected.$in.some((candidate) =>
      candidate === null ? current === 0 : current === normalizeVersion(candidate)
    );
  }
  return current === normalizeVersion(expected);
}

export function addPolicyVersionSupport(conn, options = {}) {
  if (!conn || !conn.models) return conn;
  if (typeof conn.startSession !== "function") {
    conn.startSession = async () => ({
      startTransaction() {},
      commitTransaction() {},
      abortTransaction() {},
      endSession() {},
    });
  }
  const MenuItem = conn.models.MenuItem;
  if (MenuItem && typeof MenuItem.findOneAndUpdate === "function") {
    const original = MenuItem.findOneAndUpdate.bind(MenuItem);
    MenuItem.findOneAndUpdate = async (...args) => {
      const result = await original(...args);
      if (result && typeof result.lean === "function") return result;
      return { lean: async () => result };
    };
  } else if (MenuItem) {
    const baseFind = typeof MenuItem.find === "function" ? MenuItem.find.bind(MenuItem) : null;
    MenuItem.findOneAndUpdate = async (filter, update, opts) => {
      const ids = filter?._id?.$in
        ? filter._id.$in.map(String)
        : filter?._id
          ? [String(filter._id)]
          : [];
      let docs = baseFind ? await baseFind({ _id: { $in: ids } }).lean() : [];
      if (filter?.isDeleted?.$ne === true) {
        docs = docs.filter((d) => d.isDeleted !== true);
      }
      const doc = docs.find((d) => versionMatches(d?.policyVersion, filter?.policyVersion)) || null;
      if (options?.onWrite) options.onWrite({ filter, update, opts, doc });
      const result = doc ? { ...doc, ...(update?.$set || {}) } : null;
      if (doc && result) Object.assign(doc, result);
      return { lean: async () => result };
    };
  }
  return conn;
}
