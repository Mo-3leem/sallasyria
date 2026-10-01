import Link from "next/link";
import type { ReactNode } from "react";
import { RequireAdmin } from "@/components/guards/RequireAdmin";

/** Platform-admin area: admin-only guard (backend requireRole is authoritative). */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAdmin>
      <div className="shell-page-head">
        <h1>إدارة المنصة</h1>
        <p>عمليات مدير المنصة — كل إجراء مسجّل تدقيقياً على الخادم.</p>
      </div>
      <nav className="admin-subnav" aria-label="تنقل الإدارة">
        <Link href="/app/admin">نظرة عامة</Link>
        <span aria-hidden="true">·</span>
        <Link href="/app/admin/merchants">التجار</Link>
        <span aria-hidden="true">·</span>
        <Link href="/app/admin/subscriptions">الاشتراكات</Link>
        <span aria-hidden="true">·</span>
        <Link href="/app/admin/plans">الخطط</Link>
        <span aria-hidden="true">·</span>
        <Link href="/app/admin/users">المستخدمون</Link>
        <span aria-hidden="true">·</span>
        <Link href="/app/admin/audit">سجل التدقيق</Link>
      </nav>
      {children}
    </RequireAdmin>
  );
}
