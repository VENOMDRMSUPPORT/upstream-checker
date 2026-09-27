// ============================================
// Request log settings, read by main from the settings row
// ============================================
// The renderer saves them with every other setting (save-settings). Main
// reads the row at startup and again after each save, so a request never
// carries them. A value that is missing or out of range reads as the default
// and is never written back.
const LOG_LEVELS = new Set(['off', 'errors', 'all']);
const LOG_DEFAULTS = Object.freeze({ logLevel: 'errors', logRetentionDays: 90, bodyRetentionDays: 7, statsRetentionMonths: 12 });

function wholeIn(value, max, fallback) {
  return Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
}

function readLogSettings(row) {
  const s = row && typeof row === 'object' ? row : {};
  return {
    // No logLevel in the row means a new install: Failed only.
    logLevel: LOG_LEVELS.has(s.logLevel) ? s.logLevel : LOG_DEFAULTS.logLevel,
    logRetentionDays: wholeIn(s.logRetentionDays, 3650, LOG_DEFAULTS.logRetentionDays),
    bodyRetentionDays: wholeIn(s.bodyRetentionDays, 3650, LOG_DEFAULTS.bodyRetentionDays),
    statsRetentionMonths: wholeIn(s.statsRetentionMonths, 120, LOG_DEFAULTS.statsRetentionMonths),
  };
}

module.exports = { readLogSettings, LOG_DEFAULTS };
