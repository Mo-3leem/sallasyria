// Admin audit events (roadmap B3). Cross-store admin access and every admin
// mutation emit a structured Workers-Logs line. Format is fixed
// (action/actor/store/result) so alerts can grep it. NEVER log tokens,
// hashes, passwords, bodies, or cookies — ids and outcomes only.

export type AuditAction =
  | "admin.store.read"
  | "admin.store.update"
  | "store.create"
  | "store.update"
  | "store.publish"
  | "admin.subscription.activate"
  | "admin.subscription.cancel"
  | "admin.subscription.renew"
  | "admin.plan.create"
  | "admin.plan.update"
  | "admin.plan.delete"
  | "admin.user.password_reset"
  | "admin.users.read"
  | "admin.audit.read"
  | "admin.merchant.update"
  | "admin.merchant.delete"
  | "admin.merchants.read"
  | "admin.merchant.read"
  | "admin.store.delete"
  | "admin.customers.read"
  | "admin.customer.read"
  | "admin.customer.update"
  | "admin.customer.delete"
  | "admin.subscriptions.read"
  | "admin.subscription.read"
  | "admin.plans.read"
  | "admin.plan.read"
  | "user.password_change"
  | "user.profile.update"
  | "merchant.self.delete"
  | "merchant.store.delete"
  | "store.status"
  | "billing.checkout.start"
  | "billing.webhook.success"
  | "billing.webhook.failed"
  | "billing.webhook.amount_mismatch"
  | "billing.webhook.duplicate"
  | "store.trial.grant"
  | "store.theme.publish";

export function auditLog(
  action: AuditAction,
  fields: { actor: string; store?: string; result: string }
): void {
  const store = fields.store ?? "-";
  console.log(`audit action=${action} actor=${fields.actor} store=${store} result=${fields.result}`);
}
