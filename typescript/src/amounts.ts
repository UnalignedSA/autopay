export class AmountError extends Error {}

/**
 * Turns a decimal string such as "50.00" into integer base units (wei, lamports, satoshis...).
 * Pure integer arithmetic: crypto amounts never go through a float.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
	const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
	if (!match) throw new AmountError(`not a plain decimal amount: "${amount}"`);
	const whole = match[1] ?? '0';
	const fraction = match[2] ?? '';
	if (fraction.length > decimals) {
		throw new AmountError(`"${amount}" has more than ${decimals} decimals`);
	}
	return BigInt(whole + fraction.padEnd(decimals, '0'));
}
