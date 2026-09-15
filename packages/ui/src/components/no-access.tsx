"use client";

/*
 * Read-permission deny panel — same shape as the audit page's audit.read
 * gate. Rendered when the viewer lacks the read action for a page; the
 * underlying tables are additionally RLS-gated, so this is UI polish on
 * top of a real database denial.
 */
export function NoAccess({
  title,
  action,
  noun = "page",
}: {
  title: string;
  action: string;
  noun?: string;
}) {
  return (
    <div className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800">
      <h1 className="text-2xl font-medium whitespace-nowrap text-ink">{title}</h1>
      <p className="type-body-sm mt-1 text-ink-muted">
        You don&apos;t hold the {action} action, so this {noun} is hidden.
      </p>
    </div>
  );
}
