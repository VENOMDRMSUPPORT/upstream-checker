"use strict";

// Every JSON file the app owns is replaced atomically: a reader never sees a
// half-written file, and a failed write leaves the previous one untouched.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { writeJsonAtomic } = require("../../src/catalog/atomic");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "venom-router-atomic-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("writeJsonAtomic replaces the file and leaves no temp file behind", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "store.json");
    writeJsonAtomic(file, { items: [1, 2, 3] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { items: [1, 2, 3] });
    writeJsonAtomic(file, { items: [4] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { items: [4] });
    assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
  });
});

test("a value that cannot be serialized leaves the previous file intact", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "store.json");
    writeJsonAtomic(file, { items: [1] });
    const circular = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(file, circular));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { items: [1] });
    assert.deepEqual(fs.readdirSync(dir), ["store.json"]);
  });
});

// The reference version of this audit named `lib/sources.js` and
// `providers/index.js`. Those two arrive here one task at a time — `sources.js`
// lands as `src/catalog/sources.js` with Task 5 — so the guard reads the whole
// catalog plane instead of a fixed list: no module under `src/catalog` other
// than this helper may write a JSON file with `fs.writeFileSync`. A module
// added later is covered the day it lands, with no list in a test to update.
// Everything that is rows in the store is outside this rule already: atomicity
// there comes from a transaction, not from a rename.
test("every module that owns a JSON file writes it through the shared helper", () => {
  const dir = path.join(__dirname, "..", "..", "src", "catalog");
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".js") || entry === "atomic.js") continue;
    const source = fs.readFileSync(path.join(dir, entry), "utf8");
    const direct = source.match(/fs\.writeFileSync\(/g) || [];
    assert.equal(direct.length, 0, `src/catalog/${entry} still writes a JSON file directly (${direct.length} call(s))`);
  }
});
