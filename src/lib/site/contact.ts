// Single source of truth for the public-facing support email and any
// other "where does the user reach us" surface. Change here, propagates
// everywhere — the footer, the pricing page support note, the account
// page receipt help link, and (later) the reply-to address on outbound
// transactional email.
//
// NOTE: this is the *contact* email shown to users. The "from" address
// for transactional email lives in lib/email/sender.ts because Resend
// requires it to be on a verified domain — Gmail won't work as the
// from. We use this address as the reply-to instead.
//
// Also keep in lockstep with the Stripe Dashboard support email setting
// (Settings → Public Details → Support email). Stripe stamps that on
// receipts and the customer portal.

export const SUPPORT_EMAIL = "pylonadmin@gmail.com";

// `mailto:` href with optional subject. Use this in links so any
// formatting changes (utm tags, prefilled bodies) happen here once.
export function mailtoHref(subject?: string): string {
  const base = `mailto:${SUPPORT_EMAIL}`;
  if (!subject) return base;
  return `${base}?subject=${encodeURIComponent(subject)}`;
}
