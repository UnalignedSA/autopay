import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, toBaseUnits } from '../src/amounts.ts';

test('converts decimal strings to integer base units', () => {
	assert.equal(toBaseUnits('50.00', 18), 50000000000000000000n);
	assert.equal(toBaseUnits('0.00012345', 8), 12345n);
	assert.equal(toBaseUnits('1', 6), 1000000n);
});

test('rejects more decimals than the token has', () => {
	assert.throws(() => toBaseUnits('1.1234567', 6), AmountError);
});

test('rejects anything that is not a plain decimal', () => {
	for (const bad of ['1e3', '-1', 'abc', '', '.5', '1.']) {
		assert.throws(() => toBaseUnits(bad, 6), AmountError, bad);
	}
});
