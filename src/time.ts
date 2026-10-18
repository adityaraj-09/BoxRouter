export function parseTime(value: string): Date {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) throw new Error(`Invalid time ${value}`);
  return moment;
}

export function startOfDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function startOfNextMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function endOfDay(now: Date): Date {
  return new Date(startOfDay(now).getTime() + 24 * 60 * 60 * 1000);
}
