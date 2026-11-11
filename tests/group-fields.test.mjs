import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudget } from '../prototype/group-fields.js';

test('budget parsing accepts Brazilian decimals and grouped paste without guessing malformed values', () => {
  for (const [text, expected] of [['1', 1], ['100', 100], ['1,50', 1.5], ['100.25', 100.25], ['1.000,50', 1000.5], ['100.000,00', 100000], ['10,', 10], ['0', 0], ['0,99', 0.99]]) assert.equal(parseBudget(text), expected);
  for (const text of ['', 'abc', '1e3', '-10', '1,234', '12,34,56', 'R$ 10', null, {}, Infinity]) assert(Number.isNaN(parseBudget(text)));
});
