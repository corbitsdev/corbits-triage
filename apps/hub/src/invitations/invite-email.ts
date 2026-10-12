import { createTransport } from "nodemailer";
import type { EmailSettings } from "../env.js";

export type InviteEmail = { to: string; workspace: string; link: string; expiresAt: Date };

export type SendInviteEmail = (email: InviteEmail) => Promise<void>;

/** Workspace names are user-chosen, so they go out as one line of plain text only. */
function plainLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export function createSmtpInviteEmail(settings: EmailSettings): SendInviteEmail {
  const transport = createTransport(settings.smtpUrl);
  return async function sendInviteEmail(email) {
    const workspace = plainLine(email.workspace);
    await transport.sendMail({
      from: settings.from,
      to: email.to,
      subject: `Join ${workspace} on Corbits Triage`,
      text: [
        `You are invited to ${workspace} on Corbits Triage.`,
        `Accept the invite: ${email.link}`,
        `Sign in as ${email.to}. The link expires on ${email.expiresAt.toUTCString()}.`,
      ].join("\n\n"),
    });
  };
}
