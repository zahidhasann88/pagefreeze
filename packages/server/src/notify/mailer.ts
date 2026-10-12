import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Mailer } from './notifier.js';
export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export function createMailer(options: SmtpOptions): Mailer | null {
  if (!options.host) return null;

  const transporter: Transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.user ? { auth: { user: options.user, pass: options.pass } } : {}),
  });

  const from = options.from || `Pagefreeze <pagefreeze@${options.host}>`;

  return {
    async send({ to, subject, text }) {
      await transporter.sendMail({ from, to: to.join(', '), subject, text });
    },
  };
}

export class RecordingMailer implements Mailer {
  readonly sent: Array<{ to: string[]; subject: string; text: string }> = [];

  async send(options: { to: string[]; subject: string; text: string }): Promise<void> {
    this.sent.push(options);
  }
}
