import type { CheckoutItemRow, CheckoutOrderRow } from "./checkout.js";

// Transactional email via SendGrid.
//
// Iron rules (binding):
// - Never throws: every failure path (missing config, network error,
//   non-2xx) resolves { sent: false }. Callers fire-and-log; email can
//   never fail registration, checkout, or transitions.
// - Never called inside a D1 transaction/batch: all sends happen
//   post-commit, preferably via c.executionCtx.waitUntil (see dispatchMail).
// - Secrets come only from env bindings (SENDGRID_API_KEY); the sender
//   (MAIL_FROM) must be a verified SendGrid sender. Nothing is hardcoded.
// - Absent config = log-and-skip (local/dev path), never fail-open delivery.

export interface MailDeps {
  apiKey?: string;
  from?: string;
  fetchImpl?: typeof fetch;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(
  msg: MailMessage,
  deps: MailDeps
): Promise<{ sent: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (!deps.apiKey || !deps.from || !msg.to) {
    return { sent: false };
  }
  try {
    const res = await fetchImpl("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: deps.from },
        subject: msg.subject,
        content: [{ type: "text/plain", value: msg.text }],
      }),
    });
    if (!res.ok) return { sent: false };
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

export function buildVerificationEmail(name: string, link: string, token: string): { subject: string; text: string } {
  return {
    subject: "Verify your Salla Syria email",
    text:
      `Hi ${name},\n\n` +
      `Please verify your email address to finish setting up your Salla Syria merchant account:\n\n${link}\n\n` +
      `The link expires in 24 hours and works once. If the button does not work, use this token:\n${token}\n\n` +
      `If you did not create this account, ignore this email.\n`,
  };
}

export function buildResetEmail(name: string, link: string, token: string): { subject: string; text: string } {
  return {
    subject: "Reset your Salla Syria password",
    text:
      `Hi ${name},\n\n` +
      `Reset your password here (expires in 1 hour, single use):\n\n${link}\n\n` +
      `If the button does not work, use this token:\n${token}\n\n` +
      `If you did not request this, ignore this email — your password is unchanged.\n`,
  };
}

export function buildResetSuccessEmail(name: string): { subject: string; text: string } {
  return {
    subject: "Your Salla Syria password was reset",
    text:
      `Hi ${name},\n\n` +
      `Your password was just reset and every session was signed out. ` +
      `If this was not you, contact the platform admin immediately.\n`,
  };
}

export function buildOrderConfirmationEmail(
  storeName: string,
  order: CheckoutOrderRow,
  items: CheckoutItemRow[]
): { subject: string; text: string } {
  const lines = items.map((l) => `- ${l.product_name} x${l.quantity}: ${l.line_total}`);
  return {
    subject: `Order #${order.order_number} confirmed at ${storeName}`,
    text:
      `Thank you, ${order.customer_name}!\n\n` +
      `Your order #${order.order_number} at ${storeName} is confirmed and pending preparation.\n\n` +
      `${lines.join("\n")}\n` +
      `Shipping (${order.shipping_method}): ${order.shipping_cost}\n` +
      `Total: ${order.total}\n` +
      `Status: ${order.status}\n`,
  };
}

export function buildStatusEmail(
  storeName: string,
  orderNumber: number,
  kind: "status" | "payment",
  to: string,
  previous: string | null
): { subject: string; text: string } {
  const prev = previous === null ? "" : ` (was "${previous}")`;
  return {
    subject: `Order #${orderNumber} at ${storeName}: ${kind} is now "${to}"`,
    text:
      `Your order #${orderNumber} at ${storeName} moved to "${to}"${prev}.\n\n` +
      `Thank you for shopping with Salla Syria.\n`,
  };
}

// Fire-and-log email dispatch. In the Worker, the send continues after the
// response via waitUntil; without an execution context (unit tests) it runs
// detached. Rejections are swallowed here so a mail failure can never fail
// the business operation that triggered it — callers never await this.
export function dispatchMail(c: unknown, task: Promise<{ sent: boolean }>): void {
  const done = task.then(
    () => undefined,
    () => undefined
  );
  try {
    const ctx = (c as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } })
      .executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(done);
      return;
    }
  } catch {
    // No execution context: fall through to detached run below.
  }
  void done;
}
