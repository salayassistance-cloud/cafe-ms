// Data-sync script: populate `categories` from the category references
// actually used by the Hotel Management System live menu (`menuitems`).
//
// For every unique category referenced by a menuitem this script upserts a
// category document carrying:
//   - `name`  : multilingual object { am, en, om } (preserved or derived)
//   - `slug`  : kebab-case slug (preserved or generated)
//   - `order` : deterministic 1..N sort key so /api/bono/items returns a
//               stable, alphabetical tab order
//
// Legacy meal categories (Breakfast/lunch/Dinner/meksis) that no menuitem
// references are intentionally left untouched — the waiter API only exposes
// categories that actually have items.
//
// Usage:
//   node --env-file=.env.local scripts/sync-menu-categories.js          # dry-run
//   node --env-file=.env.local scripts/sync-menu-categories.js --apply  # write
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

function slugify(input) {
  const s = String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'category';
}

function pickEnName(name) {
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return name.en || name.am || name.om || '';
  return '';
}

// Guarantee the { am, en, om } shape, defaulting missing locales to the en value.
function ensureMultilingual(name, fallbackEn) {
  const fallback = String(fallbackEn || '').trim() || 'Category';
  if (name && typeof name === 'object') {
    const en = String(name.en || name.am || name.om || fallback);
    return { en, am: String(name.am || en), om: String(name.om || en) };
  }
  const s = String((typeof name === 'string' && name.trim()) || fallback);
  return { en: s, am: s, om: s };
}

// Rebuild a multilingual name from the items of a category when no category
// document exists for a referenced ObjectId.
function deriveNameFromItems(categoryItems) {
  const en = [];
  const am = [];
  const om = [];
  for (const item of categoryItems) {
    const n = item.name || item.title;
    if (typeof n === 'string') {
      if (n.trim()) en.push(n.trim());
    } else if (n && typeof n === 'object') {
      if (n.en) en.push(n.en);
      if (n.am) am.push(n.am);
      if (n.om) om.push(n.om);
    }
  }
  const first = (arr) => (arr.length ? arr[0] : '');
  const enVal = first(en) || 'Category';
  return { en: enVal, am: first(am) || enVal, om: first(om) || enVal };
}

const conn = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();
const categories = conn.db.collection('categories');
const menuitems = conn.db.collection('menuitems');

// 1. Gather every distinct category reference used by the live menu.
const items = await menuitems.find({}).toArray();
const oidRefs = new Map(); // String(category ObjectId) -> item count
const strRefs = new Map(); // legacy string category name -> item count
for (const item of items) {
  const ref = item.category;
  if (ref == null) continue;
  if (ref instanceof mongoose.Types.ObjectId || typeof ref === 'object') {
    const key = String(ref);
    oidRefs.set(key, (oidRefs.get(key) || 0) + 1);
  } else {
    const key = String(ref).trim();
    if (key) strRefs.set(key, (strRefs.get(key) || 0) + 1);
  }
}

// 2. Read existing category docs so name/slug/icon are preserved on update.
const existing = await categories.find({}).toArray();
const existingById = new Map(existing.map((c) => [String(c._id), c]));
const existingBySlug = new Map(existing.map((c) => [c.slug, c]));

// 3. Build the upsert plan (identifier + canonical name/slug/icon).
const plan = [];

for (const [oid, count] of oidRefs) {
  const doc = existingById.get(oid);
  let name;
  let slug;
  let icon = '';
  if (doc) {
    name = ensureMultilingual(doc.name, pickEnName(doc.name));
    slug = doc.slug || slugify(pickEnName(doc.name));
    icon = doc.icon || '';
  } else {
    // Referenced by menuitems but missing from categories: rebuild from items.
    const categoryItems = items.filter((i) => i.category != null && String(i.category) === oid);
    name = deriveNameFromItems(categoryItems);
    slug = slugify(name.en);
  }
  plan.push({
    key: { _id: new mongoose.Types.ObjectId(oid) },
    name,
    slug,
    icon,
    count,
  });
}

for (const [str, count] of strRefs) {
  const doc = existingBySlug.get(slugify(str));
  if (doc) {
    plan.push({
      key: { _id: doc._id },
      name: ensureMultilingual(doc.name, str),
      slug: doc.slug,
      icon: doc.icon || '',
      count,
    });
  } else {
    plan.push({
      key: { slug: slugify(str) },
      name: { en: str, am: str, om: str },
      slug: slugify(str),
      icon: '',
      count,
    });
  }
}

// 4. Deterministic `order` (1..N), sorted by English name — idempotent across runs.
plan.sort((a, b) => a.name.en.toLowerCase().localeCompare(b.name.en.toLowerCase()));
plan.forEach((entry, index) => {
  entry.order = index + 1;
});

console.log(`menuitems scanned: ${items.length}`);
console.log(`distinct referenced categories: ${plan.length}`);
console.log('');

if (!APPLY) {
  console.log('--- DRY RUN (no writes) ---');
  for (const entry of plan) {
    const id = entry.key._id ? String(entry.key._id) : entry.key.slug;
    console.log(
      `  PLAN ${id} -> order=${entry.order} slug=${entry.slug} items=${entry.count} (${entry.name.en})`
    );
  }
  console.log('\nRe-run with --apply to write.');
  await conn.close();
  process.exit(0);
}

// 5. Upsert each referenced category.
let upserted = 0;
let inserted = 0;
let updated = 0;
for (const entry of plan) {
  const $set = { name: entry.name, slug: entry.slug, order: entry.order };
  if (entry.icon) $set.icon = entry.icon;

  const res = await categories.updateOne(entry.key, { $set }, { upsert: true });
  upserted += 1;
  if (res.upsertedCount) inserted += 1;
  if (res.modifiedCount) updated += 1;

  const id = entry.key._id ? String(entry.key._id) : entry.key.slug;
  console.log(
    `  ${res.upsertedCount ? 'INSERT' : 'SET   '} ${id} -> order=${entry.order} slug=${entry.slug} (${entry.name.en})`
  );
}

// 6. Verify every referenced category is present with a slug and an order.
const verified = await categories
  .find({ _id: { $in: [...oidRefs.keys()].map((k) => new mongoose.Types.ObjectId(k)) } })
  .toArray();
const missingOrder = verified.filter((c) => typeof c.order !== 'number').length;
console.log(`\nverify: referenced categories in collection: ${verified.length} of ${oidRefs.size}`);
console.log(`verify: referenced categories missing order:  ${missingOrder}`);
console.log(`done: ${upserted} upserts (${inserted} inserted, ${updated} modified)`);

await conn.close();