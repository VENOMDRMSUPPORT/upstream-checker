// ============================================
// Wire — the providers that do not speak OpenAI
// ============================================
// Most providers answer an OpenAI-shaped request. A few do not: Antigravity
// answers Google's own protocol, and the app has to speak that one.
//
// A wire module is the whole of a provider's protocol: it builds the request
// the provider understands and reads the answer it sends back. It lives in
// main, so the page and the routing gateway share one implementation.
//
// The renderer reaches it through the preload surface (src/preload.js); main
// uses it directly. A provider whose id is not in here speaks OpenAI, and
// nothing changes for it.
const WIRES = {
  antigravity: require('./antigravity'),
};

// The wire for a provider, or null when the provider speaks OpenAI.
function getWire(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (!id) return null;
  return WIRES[id] || null;
}

// The wire knows how to answer one of these. A provider that speaks OpenAI
// has no wire, and the app's own OpenAI path is used instead.
function supports(providerId) {
  return Boolean(getWire(providerId));
}

// Build a request for a provider's own protocol.
//   op 'chat'         → the envelope for a conversation
//   op 'models'       → the roster
//   op 'quota'        → the same route, read for the allowance
//   op 'project'      → which project the account is on, and its plan
//   op 'quota-summary' → the grouped weekly and five-hour limits
function build(providerId, op, args) {
  const wire = getWire(providerId);
  if (!wire) return null;
  if (op === 'chat') return wire.buildChat(args || {});
  if (op === 'models' || op === 'quota') return wire.buildModels(args || {});
  if (op === 'project') return wire.buildProject(args || {});
  if (op === 'quota-summary') return wire.buildQuotaSummary(args || {});
  return null;
}

// Read an answer in a provider's own protocol.
function parse(providerId, op, body, extra) {
  const wire = getWire(providerId);
  if (!wire) return null;
  if (op === 'chat') return extra && extra.stream ? wire.parseChatStream(body) : wire.parseChat(body);
  if (op === 'models') return wire.parseModels(body);
  if (op === 'quota') return wire.parseQuota(body);
  if (op === 'quota-summary') return wire.parseQuotaSummary(body);
  if (op === 'project') return wire.parseProject(body);
  return null;
}

// What an account is: the project its requests are billed to and the plan it
// is on. A provider without a wire has no answer here, and the account keeps
// whatever it already knows.
async function discover(providerId, { baseUrl, apiKey, http } = {}) {
  const wire = getWire(providerId);
  if (!wire || typeof wire.discoverAccount !== 'function') return null;
  return wire.discoverAccount({ baseUrl, apiKey, http });
}

// A translator for a provider's own stream, so a client that speaks OpenAI
// can read it. Null when the provider speaks OpenAI already.
function stream(providerId, options) {
  const wire = getWire(providerId);
  if (!wire || typeof wire.createStreamTranslator !== 'function') return null;
  return wire.createStreamTranslator(options || {});
}

module.exports = { WIRES, getWire, supports, build, parse, stream, discover };
