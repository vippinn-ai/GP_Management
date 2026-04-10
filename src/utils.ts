export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function currency(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(value);
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeStyle: "short"
  }).format(new Date(value));
}

export function formatMinutes(minutes: number): string {
  const safeMinutes = Math.max(0, minutes);
  const wholeHours = Math.floor(safeMinutes / 60);
  const remainingMinutes = Math.round(safeMinutes % 60);

  if (wholeHours === 0) {
    return `${remainingMinutes} min`;
  }

  if (remainingMinutes === 0) {
    return `${wholeHours} hr`;
  }

  return `${wholeHours} hr ${remainingMinutes} min`;
}

export function clampNumber(value: number, min = 0): number {
  if (Number.isNaN(value)) {
    return min;
  }

  return Math.max(min, value);
}

export function toMinuteOfDay(timeValue: string): number {
  const [hoursText, minutesText] = timeValue.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return hours * 60 + minutes;
}

export function minuteToTimeLabel(value: number): string {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor(normalized % 60)
    .toString()
    .padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function sumBy<T>(values: T[], getter: (value: T) => number): number {
  return values.reduce((total, value) => total + getter(value), 0);
}

export function isToday(value: string): boolean {
  const date = new Date(value);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
