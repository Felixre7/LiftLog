import { LocalDate } from '@js-joda/core';
import { describe, expect, it } from 'vitest';
import { chartDateLabels } from './chart-date-labels';

const start = LocalDate.of(2020, 1, 1);
const dates = Array.from({ length: 730 }, (_, index) => start.plusDays(index));
const formatDate = (date: LocalDate, options: Intl.DateTimeFormatOptions) =>
  options.day ? date.toString() : options.month ? `month-${date.monthValue()}` : `${date.year()}`;

describe('chartDateLabels', () => {
  it('keeps month/day at maximum zoom, even with sparse history', () => {
    expect(chartDateLabels([start, start.plusYears(2)], 50, false, formatDate)).toEqual(['2020-01-01', '2022-01-01']);
  });

  it('switches from dates to months and then years as spacing shrinks', () => {
    expect(chartDateLabels(dates, 50, false, formatDate)[0]).toBe('2020-01-01');
    expect(chartDateLabels(dates, 1, true, formatDate)[0]).toBe('month-1');
    expect(chartDateLabels(dates, 0.25, true, formatDate).filter(Boolean)).toEqual(['2020', '2021']);
  });

  it('does not repeat month labels within the same month and keeps labels apart', () => {
    const monthlyDates = Array.from({ length: 24 }, (_, index) => start.plusMonths(index));
    const labels = chartDateLabels(monthlyDates, 25, true, formatDate);
    expect(labels.slice(0, 5)).toEqual(['month-1', '', 'month-3', '', 'month-5']);
    expect(labels[12]).toBe('month-1');
  });

  it('handles empty and single-point series', () => {
    expect(chartDateLabels([], 50, true, formatDate)).toEqual([]);
    expect(chartDateLabels([start], 50, true, formatDate)).toEqual(['2020-01-01']);
  });
});
