'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { fuzzyScore, fuzzyFilter } = require('../lib/fuzzy');

describe('fuzzyScore', () => {
  test('returns null when the query is not a subsequence of the text', () => {
    assert.equal(fuzzyScore('herdr', 'xyz'), null);
    assert.equal(fuzzyScore('abc', 'acb'), null);
  });

  test('returns null for non-string arguments', () => {
    assert.equal(fuzzyScore(null, 'a'), null);
    assert.equal(fuzzyScore('a', undefined), null);
  });

  test('returns 0 for an empty query', () => {
    assert.equal(fuzzyScore('anything', ''), 0);
  });

  test('matches case-insensitively with identical scores', () => {
    const lowerScore = fuzzyScore('herdr-web', 'web');
    assert.notEqual(lowerScore, null);
    assert.equal(fuzzyScore('HERDR-WEB', 'web'), lowerScore);
    assert.equal(fuzzyScore('herdr-web', 'WEB'), lowerScore);
  });

  test('scores consecutive matches above scattered ones', () => {
    const consecutive = fuzzyScore('abc', 'abc');
    const scattered = fuzzyScore('axbxc', 'abc');
    assert.ok(consecutive > scattered, `expected ${consecutive} > ${scattered}`);
  });

  test('scores an exact prefix above the same match deeper in the text', () => {
    const prefix = fuzzyScore('herdr', 'herdr');
    const embedded = fuzzyScore('web-herdr', 'herdr');
    assert.ok(prefix > embedded, `expected ${prefix} > ${embedded}`);
  });
});

describe('fuzzyFilter', () => {
  test('returns the items array untouched for an empty or whitespace query', () => {
    const items = ['beta', 'alpha'];
    assert.equal(fuzzyFilter(items, ''), items);
    assert.equal(fuzzyFilter(items, '   '), items);
    assert.equal(fuzzyFilter(items, undefined), items);
  });

  test('returns an empty list for non-array items', () => {
    assert.deepEqual(fuzzyFilter(undefined, 'a'), []);
  });

  test('drops items that do not match the query', () => {
    assert.deepEqual(fuzzyFilter(['herdr', 'other'], 'hd'), ['herdr']);
  });

  test('ranks an exact-prefix match first', () => {
    const items = ['web-herdr', 'xherdrx', 'herdr'];
    assert.equal(fuzzyFilter(items, 'herdr')[0], 'herdr');
  });

  test('uses keyFn to extract the text to match against', () => {
    const items = [
      { name: 'gadget', path: '/opt/repos/gadget' },
      { name: 'widget', path: '/opt/repos/widget' },
    ];
    const filtered = fuzzyFilter(items, 'wid', (item) => item.name);
    assert.deepEqual(filtered, [{ name: 'widget', path: '/opt/repos/widget' }]);
  });

  test('breaks score ties alphabetically by key', () => {
    // 't' matches at the same non-word-start index in both, so scores tie.
    assert.deepEqual(fuzzyFilter(['cat', 'bat'], 't'), ['bat', 'cat']);
  });
});
