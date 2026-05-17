// Run with: node --test worker/test/verify.test.js
//
// These tests cover:
//   1. RFC 1321 MD5 vectors (sanity baseline; if MD5 is broken, nothing else matters)
//   2. The canonical PayFast ITN fixture in worker/test/payfast-canonical-sample.json
//      - the canonical string we reconstruct from the parsed body matches the fixture byte-for-byte
//      - the signature verifies
//      - tampering with the body invalidates the signature
//      - using the wrong passphrase invalidates the signature
//      - a body with no signature field is rejected
//
// The fixture is hand-computed from PayFast's official PHP SDK algorithm — see
// SPEC-VERIFICATION.md for sourcing. It deliberately includes a space and an
// apostrophe in `item_name` so naive JS encoders (URLSearchParams.toString,
// encodeURIComponent) will FAIL this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { md5 } from '../md5.js';
import { parseItnBody, buildCanonicalString, verifyItnSignature } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'payfast-canonical-sample.json'), 'utf8'));

test('MD5 RFC 1321 test vectors', () => {
  const vectors = [
    ['',                                                'd41d8cd98f00b204e9800998ecf8427e'],
    ['a',                                               '0cc175b9c0f1b6a831c399e269772661'],
    ['abc',                                             '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest',                                  'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz',                      'c3fcd3d76192e4007dfb496cca67e13b'],
    ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
    ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(md5(input), expected, `md5(${JSON.stringify(input).slice(0, 40)})`);
  }
});

test('parseItnBody preserves insertion order and extracts signature', () => {
  const { fields, signature } = parseItnBody(fixture.raw_post_body);
  assert.equal(signature, fixture.expected_signature, 'signature field extracted');

  const expectedKeys = fixture.fields_in_post_order.map(([k]) => k);
  const gotKeys = fields.map(([k]) => k);
  assert.deepEqual(gotKeys, expectedKeys, 'field order matches POST order');

  for (let i = 0; i < expectedKeys.length; i++) {
    const [k, v] = fixture.fields_in_post_order[i];
    assert.equal(fields[i][0], k, `field ${i} key`);
    assert.equal(fields[i][1], v, `field ${i} value (decoded)`);
  }
});

test('buildCanonicalString reproduces the fixture canonical string byte-for-byte', () => {
  // This is where a naive JS encoder would fail: the apostrophe in
  // "Nyeleti's" must become %27, the space must become +.
  const { fields } = parseItnBody(fixture.raw_post_body);
  const canonical = buildCanonicalString(fields, fixture.passphrase);
  assert.equal(canonical, fixture.expected_canonical_string);
});

test('verifyItnSignature returns true for the canonical fixture', () => {
  const { fields, signature } = parseItnBody(fixture.raw_post_body);
  assert.equal(verifyItnSignature(fields, signature, fixture.passphrase), true);
});

test('verifyItnSignature rejects a tampered amount', () => {
  const { fields, signature } = parseItnBody(fixture.negative_cases.tampered_amount.raw_post_body);
  // Same signature as the positive case, but amount_gross is mutated:
  assert.equal(signature, fixture.expected_signature, 'tampered fixture still carries the original signature');
  assert.equal(verifyItnSignature(fields, signature, fixture.passphrase), false);
});

test('verifyItnSignature rejects the right body with the wrong passphrase', () => {
  const { fields, signature } = parseItnBody(fixture.raw_post_body);
  assert.equal(
    verifyItnSignature(fields, signature, fixture.negative_cases.swapped_passphrase.passphrase),
    false,
  );
});

test('verifyItnSignature rejects a body with no signature field', () => {
  const { fields, signature } = parseItnBody(fixture.negative_cases.missing_signature.raw_post_body);
  assert.equal(signature, null);
  assert.equal(verifyItnSignature(fields, signature, fixture.passphrase), false);
});

test('verifyItnSignature is case-insensitive on the received signature hex', () => {
  // PayFast emits lowercase, but defense-in-depth: an uppercase'd version must still verify.
  const { fields, signature } = parseItnBody(fixture.raw_post_body);
  assert.equal(verifyItnSignature(fields, signature.toUpperCase(), fixture.passphrase), true);
});
