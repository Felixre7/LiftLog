import { LocalDate } from '@js-joda/core';

export function chartDateLabels(
  dates: LocalDate[],
  pointSpacing: number,
  zoomedOut: boolean,
  formatDate: (date: LocalDate, options: Intl.DateTimeFormatOptions) => string,
): string[] {
  const labelWidth = 50;
  const span = dates.length > 1 ? Math.abs(dates.at(-1)!.toEpochDay() - dates[0]!.toEpochDay()) : 0;
  // Points are spaced by workout, not elapsed time. Estimate how much time fits between readable labels.
  const daysPerLabel = (span / Math.max(1, dates.length - 1)) * (labelWidth / pointSpacing);
  const granularity = !zoomedOut || daysPerLabel < 28 ? 'day' : daysPerLabel < 180 ? 'month' : 'year';
  const options: Intl.DateTimeFormatOptions =
    granularity === 'day'
      ? { month: 'short', day: 'numeric' }
      : granularity === 'month'
        ? { month: 'short' }
        : { year: 'numeric' };
  let lastLabelIndex = -Infinity;
  let lastPeriod = '';
  return dates.map((date, index) => {
    const period =
      granularity === 'year'
        ? `${date.year()}`
        : granularity === 'month'
          ? `${date.year()}-${date.monthValue()}`
          : date.toString();
    if (period === lastPeriod || (index - lastLabelIndex) * pointSpacing < labelWidth) {
      return '';
    }
    lastLabelIndex = index;
    lastPeriod = period;
    return formatDate(date, options);
  });
}
