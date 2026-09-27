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
  /** Optional HTML alternative (email-safe, inline-styled, no scripts). */
  html?: string;
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
    const content: { type: string; value: string }[] = [
      { type: "text/plain", value: msg.text },
    ];
    if (msg.html) {
      content.push({ type: "text/html", value: msg.html });
    }
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
        content,
      }),
    });
    if (!res.ok) return { sent: false };
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/** Minimal HTML escaping for merchant-controlled values in templates. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildVerificationEmail(
  name: string,
  link: string,
  _token: string
): { subject: string; text: string; html: string } {
  // NOTE: the raw token is intentionally never rendered. The link above is
  // the only activation path; `_token` stays in the signature so existing
  // callers keep compiling unchanged.
  void _token;
  const firstName = name.trim().split(/\s+/)[0] ?? "";
  const displayName = firstName !== "" ? firstName : name.trim();
  const safeName = escapeHtml(displayName);
  const safeLink = escapeHtml(link);
  const subject = "تأكيد بريدك الإلكتروني في سلة سوريا";
  const text =
    `مرحبًا ${displayName}،\n\n` +
    `شكرًا لانضمامك إلى سلة سوريا.\n\n` +
    `لتفعيل حسابك والبدء في استخدام لوحة تحكم متجرك، يرجى تأكيد بريدك الإلكتروني عبر الرابط التالي:\n\n${link}\n\n` +
    `هذا الرابط صالح لمدة 24 ساعة ويمكن استخدامه مرة واحدة فقط.\n\n` +
    `إذا لم تقم بإنشاء حساب على سلة سوريا، يمكنك تجاهل هذه الرسالة بأمان.\n\n` +
    `إذا واجهت مشكلة في تأكيد بريدك الإلكتروني، يرجى التواصل مع فريق الدعم.\n\n` +
    `مع تحياتنا،\nفريق سلة سوريا\n` +
    `© 2025 سلة سوريا — sallasyria.com — جميع الحقوق محفوظة`;
  const html =
    `<!DOCTYPE html>` +
    `<html lang="ar" dir="rtl">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<title>${subject}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f1f5f9;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="background-color:#16a34a;padding:24px 32px;text-align:center;">` +
    `<span style="font-family:Tahoma,Arial,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;">سلة سوريا</span>` +
    `</td></tr>` +
    `<tr><td style="padding:32px;font-family:Tahoma,Arial,sans-serif;color:#0f172a;font-size:15px;line-height:1.9;">` +
    `<p style="margin:0 0 8px;">مرحبًا ${safeName}،</p>` +
    `<p style="margin:0 0 16px;">شكرًا لانضمامك إلى سلة سوريا.</p>` +
    `<p style="margin:0 0 24px;">لتفعيل حسابك والبدء في استخدام لوحة تحكم متجرك، يرجى تأكيد بريدك الإلكتروني بالضغط على الزر التالي:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;"><tr>` +
    `<td align="center" bgcolor="#16a34a" style="border-radius:8px;">` +
    `<a href="${safeLink}" style="display:inline-block;padding:13px 40px;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">تأكيد البريد الإلكتروني</a>` +
    `</td></tr></table>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">هذا الرابط صالح لمدة 24 ساعة ويمكن استخدامه مرة واحدة فقط.</p>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">إذا لم تقم بإنشاء حساب على سلة سوريا، يمكنك تجاهل هذه الرسالة بأمان.</p>` +
    `<p style="margin:0;font-size:13px;color:#64748b;">إذا واجهت مشكلة في تأكيد بريدك الإلكتروني، يرجى التواصل مع فريق الدعم.</p>` +
    `<p style="margin:16px 0 0;">مع تحياتنا،<br>فريق سلة سوريا</p>` +
    `</td></tr>` +
    `<tr><td style="padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;font-family:Tahoma,Arial,sans-serif;font-size:12px;color:#94a3b8;">` +
    `© 2025 سلة سوريا — <a href="https://sallasyria.com/" style="color:#16a34a;text-decoration:none;">sallasyria.com</a> — جميع الحقوق محفوظة` +
    `</td></tr>` +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`;
  return { subject, text, html };
}

export function buildResetEmail(
  name: string,
  link: string,
  _token: string
): { subject: string; text: string; html: string } {
  // Same branded layout as buildVerificationEmail (header, 600px container,
  // CTA button, footer) — only the copy and CTA differ. Like the verify
  // template, the raw token is intentionally never rendered: the link is the
  // only reset path; `_token` stays in the signature so existing callers
  // keep compiling unchanged.
  void _token;
  const firstName = name.trim().split(/\s+/)[0] ?? "";
  const displayName = firstName !== "" ? firstName : name.trim();
  const safeName = escapeHtml(displayName);
  const safeLink = escapeHtml(link);
  const subject = "إعادة تعيين كلمة المرور في سلة سوريا";
  const text =
    `مرحبًا ${displayName}،\n\n` +
    `تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بحسابك.\n\n` +
    `لإنشاء كلمة مرور جديدة، يرجى استخدام الرابط التالي:\n\n${link}\n\n` +
    `هذا الرابط صالح لمدة ساعة واحدة ويمكن استخدامه مرة واحدة فقط.\n\n` +
    `إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذه الرسالة بأمان — ستبقى كلمة مرورك الحالية دون تغيير.\n\n` +
    `إذا واجهت مشكلة في إعادة تعيين كلمة المرور، يرجى التواصل مع فريق الدعم.\n\n` +
    `مع تحياتنا،\nفريق سلة سوريا\n` +
    `© 2025 سلة سوريا — sallasyria.com — جميع الحقوق محفوظة`;
  const html =
    `<!DOCTYPE html>` +
    `<html lang="ar" dir="rtl">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
    `<title>${subject}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f1f5f9;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">` +
    `<tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">` +
    `<tr><td style="background-color:#16a34a;padding:24px 32px;text-align:center;">` +
    `<span style="font-family:Tahoma,Arial,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;">سلة سوريا</span>` +
    `</td></tr>` +
    `<tr><td style="padding:32px;font-family:Tahoma,Arial,sans-serif;color:#0f172a;font-size:15px;line-height:1.9;">` +
    `<p style="margin:0 0 8px;">مرحبًا ${safeName}،</p>` +
    `<p style="margin:0 0 16px;">تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بحسابك.</p>` +
    `<p style="margin:0 0 24px;">لإنشاء كلمة مرور جديدة، يرجى الضغط على الزر التالي:</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;"><tr>` +
    `<td align="center" bgcolor="#16a34a" style="border-radius:8px;">` +
    `<a href="${safeLink}" style="display:inline-block;padding:13px 40px;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">إعادة تعيين كلمة المرور</a>` +
    `</td></tr></table>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">هذا الرابط صالح لمدة ساعة واحدة ويمكن استخدامه مرة واحدة فقط.</p>` +
    `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">إذا لم تطلب إعادة تعيين كلمة المرور، يمكنك تجاهل هذه الرسالة بأمان — ستبقى كلمة مرورك الحالية دون تغيير.</p>` +
    `<p style="margin:0;font-size:13px;color:#64748b;">إذا واجهت مشكلة في إعادة تعيين كلمة المرور، يرجى التواصل مع فريق الدعم.</p>` +
    `<p style="margin:16px 0 0;">مع تحياتنا،<br>فريق سلة سوريا</p>` +
    `</td></tr>` +
    `<tr><td style="padding:20px 32px;text-align:center;border-top:1px solid #e2e8f0;font-family:Tahoma,Arial,sans-serif;font-size:12px;color:#94a3b8;">` +
    `© 2025 سلة سوريا — <a href="https://sallasyria.com/" style="color:#16a34a;text-decoration:none;">sallasyria.com</a> — جميع الحقوق محفوظة` +
    `</td></tr>` +
    `</table>` +
    `</td></tr></table>` +
    `</body></html>`;
  return { subject, text, html };
}

export function buildResetSuccessEmail(name: string, sessionsRevoked = true): { subject: string; text: string } {
  return {
    subject: "Your Salla Syria password was reset",
    text:
      `Hi ${name},\n\n` +
      (sessionsRevoked
        ? `Your password was just reset and every session was signed out. ` +
          `If this was not you, contact the platform admin immediately.\n`
        : `Your password was just reset (existing sessions were kept as requested). ` +
          `If this was not you, contact the platform admin immediately.\n`),
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
