/**
 * Money is integer cents everywhere (docs/design/05 §1). Providers send decimal
 * strings ("10.89"); they are converted here, exactly, never through floats.
 */
const DECIMAL = /^(-)?(\d{1,12})(?:\.(\d{1,2}))?$/;

export function parseCents(value: string): number {
  const m = DECIMAL.exec(value.trim());
  if (!m) throw new Error(`not a money amount: ${JSON.stringify(value)}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error('cents must be an integer');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** For display: "$10.89". */
export const usd = (cents: number): string => `$${formatCents(cents)}`;
