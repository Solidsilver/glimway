import raw from '../../content/mail.json' with { type: 'json' };

export interface MailRules {
  maxOutstandingSent: number;
  maxOutstandingReceived: number;
  maxSendsPerWindow: number;
  sendWindowSeconds: number;
  historyPageSize: number;
  returnAfterDays: number;
  maintenanceBatch: number;
  maintenanceIntervalSeconds: number;
}
export function validateMail(value: unknown): MailRules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid mail rules');
  const m = value as MailRules;
  for (const [n, max] of [
    [m.maxOutstandingSent, 100], [m.maxOutstandingReceived, 100],
    [m.maxSendsPerWindow, 100], [m.sendWindowSeconds, 86400],
    [m.historyPageSize, 100], [m.returnAfterDays, 365],
    [m.maintenanceBatch, 500], [m.maintenanceIntervalSeconds, 3600],
  ]) {
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('invalid mail rules');
  }
  return m;
}
export const MAIL = validateMail(raw);
