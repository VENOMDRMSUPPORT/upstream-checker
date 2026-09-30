"use strict";

// Replacing a JSON file the app owns. Every store here (source cache, provider
// snapshots, settings, notifications) is read by the next process start, so a
// crash mid-write must never leave a half-written or truncated file: serialize
// first, write a temp file beside the target, then rename over it. A rename
// within one directory is atomic on both Windows and POSIX.

const fs = require("fs");

/**
 * @param {string} filePath  target file, replaced in place
 * @param {unknown} value    anything JSON.stringify accepts
 * @param {{ space?: number }} [options]  indent for files a human may open
 */
function writeJsonAtomic(filePath, value, { space } = {}) {
  // Serialize before touching the filesystem: a value that cannot be encoded
  // must leave the previous file exactly as it was.
  const text = JSON.stringify(value, null, space);
  if (text === undefined) throw new TypeError(`cannot serialize a value for ${filePath}`);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, text);
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw error;
  }
}

module.exports = { writeJsonAtomic };
