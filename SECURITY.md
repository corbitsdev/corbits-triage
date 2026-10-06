# Security Policy

## Reporting a Vulnerability

Please report security issues through [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository (Security tab → Report a vulnerability).

Do not open a public issue for security reports.

We will acknowledge reports as soon as practical and work with you on a fix and
disclosure timeline.

## Scope Notes

Corbits Triage classifies pull requests on repositories it is installed on and
posts labels and comments through a GitHub App. Triage write-back is gated
behind human approval unless a repository is set to automated posting. Treat
any way around that gate as security-relevant, including:

- a GitHub write (comment, label, review, merge, close) without the approval the
  repository's posting mode requires
- the GitHub App private key, webhook secret, or any vaulted credential exposed
  through any surface
- a webhook accepted without a valid signature
- a workflow or tool reaching capabilities or credentials it was never granted

When reporting, include:

- Corbits Triage version or commit
- Steps to reproduce
- Expected vs actual behavior
- Whether the issue requires a malicious pull request, webhook payload, or
  configuration
