import { config } from '../config.ts';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Sends mail through whichever provider is configured.
 *
 * With nothing configured the message is logged instead of sent, so the whole
 * reset flow can be exercised in development without an email account. That is
 * a development convenience only — `config` refuses to start in production with
 * password reset enabled and no provider.
 */
export async function sendMail(mail: Mail): Promise<void> {
  switch (config.emailProvider) {
    case 'resend':
      return sendViaResend(mail);
    case 'smtp':
      return sendViaSmtp(mail);
    default:
      console.log(
        `[email] (not configured — logging instead)\n  to: ${mail.to}\n  subject: ${mail.subject}\n${mail.text}`,
      );
  }
}

/** Resend is a plain HTTPS API, so this needs no dependency. */
async function sendViaResend(mail: Mail): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend rejected the message (${res.status}): ${await res.text()}`);
  }
}

/**
 * SMTP, for a plain mailbox (a Gmail app password is the usual case). nodemailer
 * is imported lazily so installs that use Resend — or no email at all — never
 * pay for it.
 */
async function sendViaSmtp(mail: Mail): Promise<void> {
  const { createTransport } = await import('nodemailer');
  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPassword },
  });
  await transport.sendMail({
    from: config.emailFrom,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetEmail(link: string, displayName: string): Mail {
  const name = displayName || 'there';
  return {
    to: '',
    subject: 'Reset your password',
    text:
      `Hi ${name},\n\n` +
      `Use this link to choose a new password:\n${link}\n\n` +
      `It expires in ${config.resetTokenTtlMinutes} minutes and can only be used once.\n\n` +
      `If you didn't ask for this, you can ignore this email — nothing has changed.\n`,
    html:
      `<p>Hi ${esc(name)},</p>` +
      `<p><a href="${esc(link)}">Choose a new password</a></p>` +
      `<p style="color:#666;font-size:13px">This link expires in ${config.resetTokenTtlMinutes} minutes and can only be used once. ` +
      `If you didn't ask for this, you can ignore this email — nothing has changed.</p>`,
  };
}

/**
 * Sent when the address belongs to a Google-only account. Answering "no
 * password to reset" in the email rather than in the API response keeps the
 * endpoint from revealing which addresses exist.
 */
export function googleOnlyEmail(displayName: string): Mail {
  const name = displayName || 'there';
  return {
    to: '',
    subject: 'Signing in to your account',
    text:
      `Hi ${name},\n\n` +
      `Someone asked to reset the password for this address, but this account signs in with Google — ` +
      `there's no password to change. Use "Continue with Google" and you're in.\n\n` +
      `If this wasn't you, you can ignore this email.\n`,
    html:
      `<p>Hi ${esc(name)},</p>` +
      `<p>Someone asked to reset the password for this address, but this account signs in with Google — ` +
      `there's no password to change. Use <b>Continue with Google</b> and you're in.</p>` +
      `<p style="color:#666;font-size:13px">If this wasn't you, you can ignore this email.</p>`,
  };
}
