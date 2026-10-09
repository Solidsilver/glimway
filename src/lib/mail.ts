import raw from '../../content/mail.json' with { type: 'json' };
import { decodeContent } from './content-proto.ts';
import { MailSchema, type MailValid } from './gen/glimway/content/v1/mail_pb.js';

/** Mail pacing rules (content/mail.json): the server's send, history and maintenance limits. */
export type MailRules = MailValid;

/** Throws on anything content/mail.go would refuse. */
export function validateMail(value: unknown): MailRules {
  return decodeContent(MailSchema, value, 'mail', []) as MailRules;
}
export const MAIL: MailRules = validateMail(raw);
