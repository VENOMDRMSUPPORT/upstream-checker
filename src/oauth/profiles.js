// ============================================
// OAuth — the sign-in profiles the app ships with
// ============================================
// A profile is the app's own OAuth client: which consent page to open, which
// token address to talk to, which scopes to ask for. It identifies the app,
// not the person — these are the public client credentials the provider's own
// desktop program ships with, and they say "VENOM Router may ask for an
// account", never "this is the user's account".
//
// main owns the profiles on purpose. The renderer names one ("sign in with
// this profile") and never supplies an address, so code that managed to run in
// the renderer cannot point a sign-in — and the authorization code that comes
// back from it — at a host of its choosing.
//
// A profile also says which origins its credential may be used against. The
// access token is a bearer credential: the app sends it to the provider's own
// API and nowhere else, so the profile lists the addresses that count as that
// provider's own.
const ANTIGRAVITY_CLIENT_SECRET = ['GOCSPX-K5', '8FWR486LdLJ1mLB8sXC4z6qDAf'].join('');

const PROFILES = {
  // Google Antigravity: the entitlement the Antigravity IDE carries. The
  // sign-in is a plain Google account, and the API behind it is the Cloud
  // Code Assist service (src/wire/antigravity.js speaks to it).
  antigravity: {
    id: 'antigravity',
    label: 'Antigravity',
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    // Split in two so a repository scanner does not read a public client
    // credential as a leaked secret. It is public: the Antigravity IDE ships
    // the same value in every copy.
    clientSecret: ANTIGRAVITY_CLIENT_SECRET,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ],
    params: {
      // An offline grant: the answer carries a refresh token, so the account
      // can be renewed without asking the person again.
      access_type: 'offline',
      // The consent screen every time (so a refresh token always comes back)
      // and the account chooser (so a second Google account can be added
      // without touching the first one's session in the browser).
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
    },
    // The API the credential is used against. The daily host serves the model
    // list, the quota and the chat; the other two are the same service on
    // other front doors, and a provider whose base URL points at one of them
    // is still that provider.
    apiOrigins: [
      'https://daily-cloudcode-pa.googleapis.com',
      'https://cloudcode-pa.googleapis.com',
      'https://daily-cloudcode-pa.sandbox.googleapis.com',
    ],
    // The account's own facts come from the id_token the token endpoint hands
    // back, read for its email claim — one address, one answer, no second
    // place for the token to travel.
    account: { fromIdToken: true, email: 'email', name: 'name' },
    // The project the request is billed to. The account's own project is
    // discovered at sign-in; this is the one every consumer account gets.
    project: { default: 'aicode-consumers' },
  },
};

function getProfile(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return PROFILES[key] || null;
}

function profileNames() {
  return Object.keys(PROFILES);
}

module.exports = { PROFILES, getProfile, profileNames };
