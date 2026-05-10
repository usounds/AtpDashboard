export function formatRelativeDayOffsetLabel(dayOffset: number, isMonthlyBucket: boolean): string {
  if (dayOffset === 0) {
    return 'Today';
  }
  const daysAgo = Math.abs(dayOffset);
  if (isMonthlyBucket && daysAgo % 30 === 0) {
    const monthsAgo = Math.max(daysAgo / 30, 1);
    return `${monthsAgo}m`;
  }
  return `${daysAgo}d`;
}

export function buildRelativeDayOffsetCategories(rows: { day_offset: number }[]): string[] {
  const isMonthlyBucket = rows.some((row) => Math.abs(row.day_offset) >= 60 && row.day_offset % 30 === 0);
  return rows.map((row) => formatRelativeDayOffsetLabel(row.day_offset, isMonthlyBucket));
}

export function removeApexSvgTitle(chartContext: { el?: Element } | undefined): void {
  chartContext?.el?.querySelectorAll('svg title').forEach((element) => element.remove());
}
