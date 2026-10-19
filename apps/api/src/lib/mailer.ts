import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { Env } from '../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** Sends through any SMTP provider. STARTTLS is required when the connection does not start with TLS. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    env: Pick<Env, 'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASS'>,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      requireTLS: !env.SMTP_SECURE,
      ...(env.SMTP_USER && env.SMTP_PASS ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}),
      // Plain text bodies built here never reference files or URLs; refuse them anyway.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}

/**
 * Development: writes each email to a text file in the outbox folder (and logs where), instead of sending it.
 * Open the file to follow a password-reset link.
 */
export class OutboxMailer implements Mailer {
  constructor(
    private readonly dir: string,
    private readonly from: string,
    private readonly logger?: Logger,
  ) {}

  async send(message: MailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = message.subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const file = path.resolve(this.dir, `${stamp}-${slug}.txt`);
    const body = `From: ${this.from}\nTo: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`;
    await writeFile(file, body, 'utf8');
    this.logger?.info({ to: message.to, subject: message.subject, file }, 'Email written to the outbox (SMTP not configured)');
  }
}

/** Tests: keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  /** The most recent message to an address. */
  lastTo(to: string): MailMessage | undefined {
    return this.sent.filter((m) => m.to === to).at(-1);
  }
}

export function createMailer(env: Env, logger?: Logger): Mailer {
  return env.SMTP_HOST ? new SmtpMailer(env, env.MAIL_FROM) : new OutboxMailer(env.MAIL_OUTBOX_DIR, env.MAIL_FROM, logger);
}
