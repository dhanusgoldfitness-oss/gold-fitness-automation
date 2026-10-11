// Offline test: GOOGLE_SERVICE_ACCOUNT_JSON accepted in every common paste format. Uses a throwaway key.
const assert = require('assert');
const crypto = require('crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const { _parseCreds } = require('../src/sheets');

const email = 'svc@test.iam.gserviceaccount.com';
const obj = { type: 'service_account', client_email: email, private_key: privateKey };
const json = JSON.stringify(obj);
const pretty = JSON.stringify(obj, null, 2);
const b64 = (s) => Buffer.from(s).toString('base64');

const forms = {
  'raw one line': json,
  'raw pretty': pretty,
  'raw with spaces around': `  \n${json}\n  `,
  'single quotes': `'${json}'`,
  'double quotes (escaped string)': JSON.stringify(json),
  'base64': b64(json),
  'base64 of pretty file': b64(pretty),
  'base64 wrapped lines': b64(json).replace(/(.{76})/g, '$1\n'),
  'base64 in quotes': `"${b64(json)}"`,
  'key newlines double-escaped': JSON.stringify({ ...obj, private_key: privateKey.replace(/\n/g, '\\n') }),
};

for (const [name, value] of Object.entries(forms)) {
  const c = _parseCreds(value);
  assert.strictEqual(c.client_email, email, name);
  assert.strictEqual(c.private_key, privateKey, `${name}: private key must come out with real newlines`);
  // The parsed key must actually be usable for signing.
  assert.ok(crypto.createSign('RSA-SHA256').update('x').sign(c.private_key).length > 0, name);
}

// Bad input: clear message, and the value never appears in the error.
for (const bad of ['not json at all', '{"client_email":"a@b.c"}', '}garbage{', '""']) {
  let message = '';
  try {
    _parseCreds(bad);
  } catch (e) {
    message = e.message;
  }
  assert.match(message, /could not be read/, `bad input: ${bad}`);
  assert.ok(!message.includes(bad), 'error must not echo the value');
}
assert.throws(() => _parseCreds(''), /is not set/);

console.log(`All credential format tests passed (${Object.keys(forms).length} formats)`);
