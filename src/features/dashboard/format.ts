const averageFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** Averages are shown to at most two decimals; -0 is normalised to 0. */
export function formatAverage(value: number): string {
  const text = averageFormat.format(value);
  return text === '-0' ? '0' : text;
}

export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
