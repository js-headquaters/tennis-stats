import { getCalendarPeriod, type DateRange } from '../../domain/statistics';

export type PeriodUnit = 'week' | 'month';

// Fixed English labels keep output deterministic across ICU versions (en-GB short September varies between "Sep" and "Sept").
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Calendar period `offset` steps from the one containing `reference` (0 = current, negative = earlier). */
export function periodAt(reference: Date, unit: PeriodUnit, offset: number): DateRange {
  let range = getCalendarPeriod(reference, unit);
  for (let step = 0; step > offset; step -= 1) range = previousPeriod(range, unit);
  for (let step = 0; step < offset; step += 1) range = getCalendarPeriod(range.end, unit);
  return range;
}

export function previousPeriod(range: DateRange, unit: PeriodUnit): DateRange {
  return getCalendarPeriod(new Date(range.start.getTime() - 1), unit);
}

function lastDay(range: DateRange) {
  return new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
}

export function formatDay(date: Date) {
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function periodLabel(range: DateRange, unit: PeriodUnit): string {
  const first = range.start;
  if (unit === 'month') return `${LONG_MONTHS[first.getMonth()]} ${first.getFullYear()}`;
  const last = lastDay(range);
  if (first.getFullYear() !== last.getFullYear()) return `${formatDay(first)} – ${formatDay(last)}`;
  if (first.getMonth() !== last.getMonth()) return `${first.getDate()} ${SHORT_MONTHS[first.getMonth()]} – ${formatDay(last)}`;
  return `${first.getDate()}–${formatDay(last)}`;
}

export function shortPeriodLabel(range: DateRange, unit: PeriodUnit): string {
  const first = range.start;
  return unit === 'month' ? SHORT_MONTHS[first.getMonth()] : `${first.getDate()} ${SHORT_MONTHS[first.getMonth()]}`;
}
