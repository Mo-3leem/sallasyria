// Admin audit events (roadmap B3). Cross-store admin access and every admin
// mutation emit a structured Workers-Logs line. Format is fixed
// (action/actor/store/result) so alerts can grep it. NEVER log tokens,
// hashes, passwords, bodies, or cookies — ids and outcomes only.

export type AuditAction =
  | "admin.store.read"
  | "admin.store.update"
  | "store.create"
  | "store.update"
  | "admin.subscription.activate"
  | "admin.subscription.cancel"
  | "admin.subscription.renew"
  | "admin.plan.create"
  | "admin.plan.update"
  | "admin.plan.delete"
  | "admin.user.password_reset"
  | "user.password_change"
  | "user.profile.update";

export function auditLog(
  action: AuditAction,
  fields: { actor: string; store?: string; result: string }
): void {
  const store = fields.store ?? "-";
  console.log(`audit action=${action} actor=${fields.actor} store=${store} result=${fields.result}`);
}
