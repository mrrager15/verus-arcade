#!/usr/bin/env node
/**
 * Parity test: decode the dev's sample GenericRequest login QR and assert on
 * every field we plan to produce from createChallenge(). This is the known-good
 * reference we'll compare our own output against during the auth.ts refactor.
 *
 * Sample QR shared by the dev — verus://1/<base64url GenericRequest>.
 * Run: node test-parity-genericrequest.cjs
 */

const {
  GenericRequest,
  AuthenticationRequestOrdinalVDXFObject,
  ResponseURI,
} = require('verus-typescript-primitives');

const SAMPLE_URI =
  'verus://1/AYUAAAIFAQEOTW96ZWs5MC52YWx1aWRJAgWEED4AAUEgnWDsiDO7n-ipbNTizHqV2gICSELjLYiKMRS5RDESjHZh_k-rlhe9FWk8SdmlMgdV7B5GDvarwwNO-WejsGc8X_5c8wZqAgEBAAECEGh0dHA6Ly92ZXJ1cy5pby8';

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${expected}`);
    console.log(`      actual:   ${actual}`);
    failed++;
  }
}

function checkTruthy(label, actual) {
  const ok = !!actual;
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}  (got ${actual})`);
    failed++;
  }
}

console.log('Decoding sample QR ...');
const req = GenericRequest.fromWalletDeeplinkUri(SAMPLE_URI);

console.log('\nEnvelope shape:');
check('version', req.version.toString(), '1');
check('flags', req.flags.toString(), '133');
check('isSigned', req.isSigned(), true);
check('isTestnet', req.isTestnet(), false);
check('hasCreatedAt', req.hasCreatedAt(), true);
check('hasResponseURIs', req.hasResponseURIs(), true);
check('hasMultiDetails', req.hasMultiDetails(), false);
check('hasRequestID', req.hasRequestID(), false);
check('hasSalt', req.hasSalt(), false);

console.log('\nDetails:');
check('details count', req.details.length, 1);
check(
  'detail[0] class',
  req.details[0]?.constructor?.name,
  'AuthenticationRequestOrdinalVDXFObject',
);
checkTruthy(
  'detail[0] is AuthenticationRequestOrdinalVDXFObject instance',
  req.details[0] instanceof AuthenticationRequestOrdinalVDXFObject,
);

console.log('\nResponse URIs:');
check('responseURIs count', req.responseURIs?.length, 1);
check(
  'responseURIs[0].uri',
  req.responseURIs?.[0]?.uri?.toString('utf-8'),
  'http://verus.io/',
);
check(
  'responseURIs[0].type == TYPE_REDIRECT (2)',
  req.responseURIs?.[0]?.type?.toString(),
  '2',
);

console.log('\nSignature:');
checkTruthy('signature present', req.signature);
check(
  'signature.identityID',
  req.signature?.identityID?.toAddress?.() ??
    req.signature?.identityID?.toIAddress?.(),
  'i3bs2GMoGJKCQfVj5Ybm97DqjFVJsthZWw',
);
check(
  'signature.systemID (= VRSC i-addr)',
  req.signature?.systemID?.toAddress?.() ??
    req.signature?.systemID?.toIAddress?.(),
  'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV',
);
check('signature byte length', req.signature?.signatureAsVch?.length, 73);

console.log('\ncreatedAt:');
checkTruthy('createdAt is a positive integer', req.createdAt?.gt?.(0));

console.log('\nRound-trip:');
check('toWalletDeeplinkUri() === input', req.toWalletDeeplinkUri(), SAMPLE_URI);
check(
  'fromBuffer(toBuffer()) round-trip preserves bytes',
  GenericRequest.fromQrString(req.toQrString()).toBuffer().toString('hex'),
  req.toBuffer().toString('hex'),
);

console.log('\nHash (for requestHash-based challenge identifier):');
const sha256 = req.getRawDataSha256().toString('hex');
console.log(`  request sha256 = ${sha256}`);
check('sha256 hex length', sha256.length, 64);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
