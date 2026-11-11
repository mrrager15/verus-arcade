/**
 * Merkle Mountain Range zoals de Verus-daemon die bouwt bij `signdata` met
 * `createmmr: true` (fase 2b: attestaties met selective disclosure).
 * Nagerekend op de daemon-broncode (v1.2.18: wallet/rpcwallet.cpp `signdata`,
 * mmr.h `CMerkleMountainView::GetRoot`, pbaas/vdxf.cpp `CSaltedData::GetHash`)
 * en op een echte `signdata`-uitvoer van 9 nov 2026 (zie de tests).
 *
 * - Blad   = objecthash(data ‖ zout)            (objecthashtype 5 = sha256)
 * - Knoop  = mmrhash(links ‖ rechts)            (mmrhashtype 5 = sha256)
 * - Wortel = toppen ("peaks") van hoog naar laag, paarsgewijs gehasht; een
 *            oneven laatste schuift ongewijzigd door.
 * - `mmrhashes` = CVDXF_Data(VectorUint256Key, vector<uint256> van alle bladeren).
 *
 * Gedeeld tussen server en browser: geen Node-imports. De hashfunctie wordt
 * meegegeven (`(bytes: Uint8Array) => Uint8Array`, synchroon).
 */

/** VDXF-key `vrsc::data.vectoruint256` (CVDXF_Data::VectorUint256Key), zoals de daemon hem schrijft. */
export const VECTOR_UINT256_KEY_HEX = '41d826d3c6cbbc3a96992670d2f604e959fd1a8c';
export const HASH_SHA256 = 5;
/** DataDescriptor-vlag: zout aanwezig. Een openbaar gemaakt blad heeft precies deze vlag. */
export const FLAG_HAS_SALT = 2;

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Blad-hash van een gezouten waarde: hash(data ‖ zout). */
export function saltedLeafHash(data, salt, hash) {
  if (salt.length !== 32) throw new Error('Salt must be 32 bytes');
  return hash(concat(data, salt));
}

/**
 * Wortel van een MMR over de gegeven bladeren (elk 32 bytes), in de volgorde
 * waarin ze toegevoegd zijn. `hashPair(links, rechts)` geeft de ouderknoop.
 */
export function mmrRoot(leaves, hashPair) {
  if (!Array.isArray(leaves) || leaves.length === 0) throw new Error('MMR needs at least one leaf');
  for (const leaf of leaves) if (!(leaf instanceof Uint8Array) || leaf.length !== 32) throw new Error('MMR leaf must be 32 bytes');
  // Lagen: elke laag erboven heeft floor(n/2) knopen (paren van links naar rechts).
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const below = layers.at(-1);
    const above = [];
    for (let i = 0; i + 1 < below.length; i += 2) above.push(hashPair(below[i], below[i + 1]));
    layers.push(above);
  }
  // Toppen: de laatste knoop van een laag is een top als de laag erboven hem niet bevat.
  const peaks = [];
  for (let h = 0; h < layers.length; h++) {
    const size = layers[h].length;
    if (h === layers.length - 1 || layers[h + 1].length < Math.ceil(size / 2)) peaks.unshift(layers[h][size - 1]);
  }
  // Toppen samenvoegen; oneven laatste schuift door (minstens één ronde, zoals de daemon).
  let current = peaks;
  do {
    const next = [];
    for (let i = 0; i + 1 < current.length; i += 2) next.push(hashPair(current[i], current[i + 1]));
    if (current.length & 1) next.push(current[current.length - 1]);
    current = next;
  } while (current.length > 1);
  return current[0];
}

function readCompactSize(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined) throw new Error('Truncated compact size');
  if (first < 253) return [first, offset + 1];
  if (first === 253) {
    if (offset + 3 > bytes.length) throw new Error('Truncated compact size');
    const value = bytes[offset + 1] | (bytes[offset + 2] << 8);
    if (value < 253) throw new Error('Non-canonical compact size');
    return [value, offset + 3];
  }
  throw new Error('Compact size too large');
}

function writeCompactSize(n) {
  if (n < 253) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(253, n & 0xff, n >> 8);
  throw new Error('Compact size too large');
}

/** `mmrhashes.objectdata` → lijst van blad-hashes. Weigert alles wat niet exact dit formaat is. */
export function decodeMmrHashes(objectDataHex) {
  const bytes = hexToBytes(objectDataHex);
  if (bytesToHex(bytes.subarray(0, 20)) !== VECTOR_UINT256_KEY_HEX) throw new Error('mmrhashes is not a vector of uint256');
  if (bytes[20] !== 1) throw new Error('Unsupported mmrhashes version');
  const [length, afterLength] = readCompactSize(bytes, 21);
  if (afterLength + length !== bytes.length) throw new Error('mmrhashes length mismatch');
  const [count, afterCount] = readCompactSize(bytes, afterLength);
  if (afterCount + count * 32 !== bytes.length) throw new Error('mmrhashes count mismatch');
  return Array.from({ length: count }, (_, i) => bytes.slice(afterCount + i * 32, afterCount + (i + 1) * 32));
}

/** Omgekeerde van `decodeMmrHashes` (voor tests en om zelf een descriptor te bouwen). */
export function encodeMmrHashes(leaves) {
  const vector = concat(writeCompactSize(leaves.length), ...leaves);
  return bytesToHex(concat(hexToBytes(VECTOR_UINT256_KEY_HEX), Uint8Array.of(1), writeCompactSize(vector.length), vector));
}

/**
 * Controleert een (gedeeltelijk) openbaar gemaakte `mmrdescriptor` zoals
 * `signdata` hem geeft, met alleen de te tonen `datadescriptors` erin:
 *   - sha256 voor bladeren en knopen (de enige vorm die we aanvaarden);
 *   - de wortel volgt uit álle blad-hashes in `mmrhashes`;
 *   - elk getoond blad (data + zout) hasht naar precies één van die bladeren.
 * Controleert NIET de handtekening op de wortel: daarvoor is de identiteit van
 * de ondertekenaar op tekenhoogte nodig (server: daemon of SDK; browser: fase 4).
 * @returns {{ root: string, leafCount: number, disclosed: Array<{ index: number, data: Uint8Array }> }}
 */
export function verifyMmrDisclosure(descriptor, { sha256 }) {
  if (!descriptor || Number(descriptor.version) !== 1) throw new Error('Unsupported MMR descriptor version');
  if (descriptor.objecthashtype !== HASH_SHA256 || descriptor.mmrhashtype !== HASH_SHA256) throw new Error('Only sha256 MMR descriptors are accepted');
  const plain = (dd) => dd && Number(dd.version) === 1 && Number(dd.flags) === 0 && typeof dd.objectdata === 'string';
  if (!plain(descriptor.mmrroot) || !plain(descriptor.mmrhashes)) throw new Error('Root and hashes must be plain data descriptors');
  const root = hexToBytes(descriptor.mmrroot.objectdata);
  if (root.length !== 32) throw new Error('MMR root must be 32 bytes');
  const leaves = decodeMmrHashes(descriptor.mmrhashes.objectdata);
  if (leaves.length === 0) throw new Error('MMR has no leaves');
  const hashPair = (left, right) => sha256(concat(left, right));
  if (!equalBytes(mmrRoot(leaves, hashPair), root)) throw new Error('Leaves do not hash to the MMR root');
  const disclosed = (descriptor.datadescriptors ?? []).map((dd) => {
    if (Number(dd.version) !== 1 || Number(dd.flags) !== FLAG_HAS_SALT || typeof dd.objectdata !== 'string' || typeof dd.salt !== 'string') {
      throw new Error('Disclosed field must be a plain salted data descriptor');
    }
    const data = hexToBytes(dd.objectdata);
    const leaf = saltedLeafHash(data, hexToBytes(dd.salt), sha256);
    const matches = leaves.flatMap((l, i) => (equalBytes(l, leaf) ? [i] : []));
    if (matches.length !== 1) throw new Error('Disclosed field does not match exactly one leaf');
    return { index: matches[0], data };
  });
  return { root: bytesToHex(root), leafCount: leaves.length, disclosed };
}
