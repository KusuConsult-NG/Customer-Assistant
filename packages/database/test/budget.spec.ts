/**
 * The pieces every budget figure passes through. A misread amount or a float
 * rounding here is a fabricated figure with a real source attached.
 */
import { parseAmount, formatNaira, nairaInWords, compareAmounts, sharePercent, resolveMdaNames } from '../src/budget';

describe('parseAmount', () => {
  it.each([
    ['1,234,567.89', '1234567.89'],
    ['₦ 500,000', '500000'],
    ['N500000', '500000'],
    ['NGN 12', '12'],
    ['0.10', '0.1'],
  ])('reads %p exactly', (raw, want) => {
    expect(parseAmount(raw)!.toString()).toBe(want);
  });

  it.each(['', '1.2e9', '500m', '1,00,000', '1.234,56', '-500', '1.234', 'twelve', '12,34'])('refuses %p', (raw) => {
    expect(parseAmount(raw)).toBeNull();
  });
});

describe('arithmetic', () => {
  it('adds kobo exactly where floating point would not', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    const sum = parseAmount('0.10')!.plus(parseAmount('0.20')!);
    expect(sum.toFixed(2)).toBe('0.30');
  });

  it('formats naira and drops empty kobo', () => {
    expect(formatNaira('10000000000.10')).toBe('₦10,000,000,000.10');
    expect(formatNaira('6000000000')).toBe('₦6,000,000,000');
    expect(nairaInWords('11500000000')).toBe('₦11.5 billion');
    expect(nairaInWords('950000')).toBe('₦950,000');
  });

  it('compares years exactly and refuses a percentage of zero', () => {
    const c = compareAmounts('10000000000.10', '11500000000');
    expect(c.change.toFixed(2)).toBe('1499999999.90');
    expect(c.percent!.toFixed(1)).toBe('15.0');
    expect(compareAmounts(0, 100).percent).toBeNull();
    expect(sharePercent(25, 200)!.toString()).toBe('12.5');
    expect(sharePercent(1, 0)).toBeNull();
  });
});

describe('resolveMdaNames', () => {
  const known = ['Ministry of Education', 'Universal Basic Education Board (PLSUBEB)', 'Ministry of Health', 'Plateau State Contributory Healthcare Management Agency (PLASCHEMA)'];
  it('finds every body a sector word names, so the caller can clarify', () => {
    expect(resolveMdaNames('the education budget', known)).toEqual(['Ministry of Education', 'Universal Basic Education Board (PLSUBEB)']);
  });
  it('lets a full name or acronym win outright', () => {
    expect(resolveMdaNames('budget for the ministry of health', known)).toEqual(['Ministry of Health']);
    expect(resolveMdaNames('PLASCHEMA allocation', known)).toEqual(['Plateau State Contributory Healthcare Management Agency (PLASCHEMA)']);
  });
  it('matches nothing rather than guessing', () => {
    expect(resolveMdaNames('the budget for roads', known)).toEqual([]);
  });
});
