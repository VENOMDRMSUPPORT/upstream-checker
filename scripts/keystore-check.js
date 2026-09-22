// Throwaway verification of src/keystore.js under a real Electron process.
// Run: npx electron scripts/keystore-check.js
const { app } = require('electron');
const {
  ENC_PREFIX,
  decryptKeyEntry,
  encryptKeyEntry,
  eachStoredKey,
  countPlaintextKeys,
} = require('../src/keystore');

const quiet = { warn() {}, error() {} };
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
  if (!cond) failures += 1;
}

// Mirrors what writeConfig/readConfig do around the file.
const save = (cfg) => eachStoredKey(structuredClone(cfg), (k) => encryptKeyEntry(k, quiet));
const load = (cfg) => eachStoredKey(structuredClone(cfg), (k) => decryptKeyEntry(k, quiet));

app.whenReady().then(() => {
  const { safeStorage } = require('electron');
  console.log('OS encryption available:', safeStorage.isEncryptionAvailable(), '\n');

  const SECRET = 'sk-nry-REALKEY-0123456789-abcdef';
  const plain = () => ({ providers: { nara: { name: 'N', keys: [{ id: 'k1', name: 'Main', key: SECRET, active: true }] } } });

  // 1. plaintext -> encrypted on disk
  const disk = save(plain());
  const stored = disk.providers.nara.keys[0].key;
  check('encrypts on save', stored.startsWith(ENC_PREFIX), stored.slice(0, 24) + '...');
  check('ciphertext does not contain the key', !stored.includes('REALKEY'));

  // 2. encrypted -> plaintext on load
  const back = load(disk);
  check('round trips to the exact key', back.providers.nara.keys[0].key === SECRET);
  check('no locked flag on a good key', !back.providers.nara.keys[0].locked);

  // 3. a save/load cycle repeated (every config write re-encrypts)
  let cfg = plain();
  for (let i = 0; i < 5; i++) cfg = load(save(cfg));
  check('survives 5 save/load cycles', cfg.providers.nara.keys[0].key === SECRET);

  // 4. THE DATA-LOSS CASE: ciphertext this machine cannot open must survive a save
  const foreign = {
    providers: { nara: { name: 'N', keys: [{ id: 'k1', name: 'FromOtherPC', key: ENC_PREFIX + 'bm90LXJlYWwtY2lwaGVydGV4dA==', active: true }] } },
  };
  const opened = load(foreign);
  const k = opened.providers.nara.keys[0];
  check('undecryptable key is flagged', k.locked === true);
  check('undecryptable key exposes no value', k.key === '');
  check('ciphertext retained in memory', k.cipher === foreign.providers.nara.keys[0].key);

  const resaved = save(opened);
  check(
    'RESAVE DOES NOT DESTROY THE KEY',
    resaved.providers.nara.keys[0].key === foreign.providers.nara.keys[0].key,
    resaved.providers.nara.keys[0].key.slice(0, 24) + '...'
  );
  check('helper fields are not written to disk', !('cipher' in resaved.providers.nara.keys[0]) && !('locked' in resaved.providers.nara.keys[0]));

  // 5. migration detection
  check('counts plaintext keys', countPlaintextKeys(plain()) === 1);
  check('counts encrypted keys as 0', countPlaintextKeys(disk) === 0);
  check('counts empty/locked keys as 0', countPlaintextKeys(opened) === 0);

  // 6. double-encryption guard
  const twice = save(save(plain()));
  check('does not re-encrypt ciphertext', twice.providers.nara.keys[0].key === disk.providers.nara.keys[0].key.slice(0, 0) + twice.providers.nara.keys[0].key && load(twice).providers.nara.keys[0].key === SECRET);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  app.exit(failures === 0 ? 0 : 1);
});
