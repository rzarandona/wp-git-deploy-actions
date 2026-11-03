import { createPublicKey, randomBytes, sign } from 'node:crypto';
import { privateKey, decodeStrict } from './signing.mjs';

/** Off-site only: callers explicitly choose where to store/display the secret. */
export function generateCredential() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const entropy = randomBytes(10);
  let value = BigInt(Date.now()) << 80n;
  for (let i = 0; i < 10; i++) value |= BigInt(entropy[i]) << BigInt((9-i)*8);
  let keyId = '';
  for (let i = 0; i < 26; i++) { keyId = alphabet[Number(value & 31n)] + keyId; value >>= 5n; }
  const seed = randomBytes(32);
  try {
    const secret = `dak1.${keyId}.${seed.toString('base64url')}`;
    const publicDer = createPublicKey(privateKey(secret).key).export({format:'der', type:'spki'});
    return {keyId, secret, publicKey:publicDer.subarray(-32).toString('base64url')};
  } finally { seed.fill(0); }
}

export function proofOfPossession(secret, siteUuid, challenge) {
  if (typeof siteUuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(siteUuid) || siteUuid.length !== 36) throw new Error('invalid site UUID');
  decodeStrict(challenge, 32);
  const credential = privateKey(secret);
  const message = `DEPLOY-POP-V1\n${siteUuid}\n${credential.id}\n${challenge}`;
  return {message, signature:sign(null, Buffer.from(message), credential.key).toString('base64url')};
}
