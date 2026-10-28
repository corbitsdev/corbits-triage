import { createTransport } from "nodemailer";
import type { EmailSettings } from "../env.js";
import type { StallNotice } from "../triage-liveness.js";

type InviteEmail = { to: string; workspace: string; link: string; expiresAt: Date };

export type SendInviteEmail = (email: InviteEmail) => Promise<void>;

export type SendAuthEmail = (to: string, link: string) => Promise<void>;

/** Workspace names are user-chosen, so they go out as one line of plain text only. */
function plainLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

export type SendStallEmail = (notice: StallNotice & { link: string }) => Promise<void>;

export function createSmtpEmail(settings: EmailSettings): { invite: SendInviteEmail; passwordReset: SendAuthEmail; verifyEmail: SendAuthEmail; triageStall: SendStallEmail } {
  const transport = createTransport(settings.smtpUrl);
  async function invite(email: InviteEmail) {
    const workspace = plainLine(email.workspace);
    await transport.sendMail({
      from: settings.from,
      to: email.to,
      subject: `Join ${workspace} on Corbits Triage`,
      text: [
        `You are invited to ${workspace} on Corbits Triage.`,
        `Join and sign in as ${email.to}: ${email.link}`,
        `The link works once and expires at ${email.expiresAt.toUTCString()}. Ask for a new one if it has.`,
      ].join("\n\n"),
    });
  }
  async function passwordReset(to: string, link: string) {
    await transport.sendMail({
      from: settings.from,
      to,
      subject: "Set your Corbits Triage password",
      text: [`Set a new password for ${to}: ${link}`, "The link expires in an hour. Ignore this email if you did not ask for it."].join("\n\n"),
    });
  }
  async function verifyEmail(to: string, link: string) {
    await transport.sendMail({
      from: settings.from,
      to,
      subject: "Verify your Corbits Triage email",
      text: [`Verify ${to} and open Corbits Triage: ${link}`, "The link expires in an hour. Ignore this email if you did not sign up."].join("\n\n"),
    });
  }
  async function triageStall(notice: StallNotice & { link: string }) {
    const workspace = plainLine(notice.workspace);
    const since = new Date(notice.since).toUTCString();
    await transport.sendMail({
      from: settings.from,
      to: notice.to,
      subject: notice.cleared ? `Triage is starting pull requests again in ${workspace}` : `Triage has stopped starting pull requests in ${workspace}`,
      text: notice.cleared
        ? [`Triage is starting pull requests in ${workspace} again. Those that waited since ${since} are triaged now.`, `Triage settings: ${notice.link}`].join("\n\n")
        : [`Pull requests in ${workspace} have waited since ${since} for Triage to start, so they have no verdict yet.`, `Triage settings: ${notice.link}`].join("\n\n"),
    });
  }
  return { invite, passwordReset, verifyEmail, triageStall };
}
