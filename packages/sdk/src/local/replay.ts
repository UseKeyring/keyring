import type { KeyringSnapshot } from "./store.js";

/**
 * The slice of any Keyring client `replayState` writes through — satisfied by
 * `PostgresKeyring` (`@usekeyring/sdk/postgres`), the hosted `Keyring` client
 * and `LocalKeyring` itself.
 */
export type ReplayTarget = {
  grantRole(input: {
    role: string;
    subject: string;
    space?: string;
    displayName?: string;
    expiresAt?: string;
    condition?: Record<string, unknown>;
  }): Promise<unknown>;
  setSubjectAttrs(input: { subject: string; attrs: Record<string, unknown>; displayName?: string }): Promise<unknown>;
  createSpace?(input: { slug: string; name: string; description?: string }): Promise<unknown>;
  createPermission?(input: { slug: string; name: string; category?: string; description?: string; space?: string }): Promise<unknown>;
  createRole?(input: { slug: string; name: string; description?: string; permissions?: string[]; space?: string }): Promise<unknown>;
};

export type ReplayReport = {
  subjects: number;
  grants: number;
  /** Runtime spaces/actions/roles replayed (policy items come from `keyring push`). */
  model: number;
  skipped: { subject?: string; role?: string; space?: string | null; reason: string }[];
};

/**
 * Copy a local snapshot into another mode — your Postgres (`PostgresKeyring`)
 * or the hosted API (`Keyring`). Push the same policy there first
 * (`keyring push`), then:
 *
 *   await replayState(await local.exportState(), postgresKeyring);
 *
 * Replays runtime model changes, subject attrs, then every live grant with
 * its expiry and condition. Expired grants are skipped; per-item failures
 * (e.g. a role missing on the target) are collected in `skipped`, not thrown.
 */
export async function replayState(
  snapshot: KeyringSnapshot,
  target: ReplayTarget,
  opts?: { now?: () => Date | number },
): Promise<ReplayReport> {
  const now = opts?.now ? +opts.now() : Date.now();
  const report: ReplayReport = { subjects: 0, grants: 0, model: 0, skipped: [] };
  const sp = (s: string | null) => s ?? undefined;
  const attempt = async (what: Omit<ReplayReport["skipped"][number], "reason">, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      report.skipped.push({ ...what, reason: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  const m = snapshot.model;
  for (const s of m?.spaces ?? []) {
    const create = target.createSpace?.bind(target);
    if (create && (await attempt({ space: s.slug }, () => create({ slug: s.slug, name: s.name, description: s.description ?? undefined })))) report.model++;
  }
  for (const a of m?.actions ?? []) {
    const create = target.createPermission?.bind(target);
    if (create && (await attempt({ space: a.space }, () => create({ slug: a.slug, name: a.name, category: a.category, description: a.description ?? undefined, space: sp(a.space) })))) {
      report.model++;
    }
  }
  for (const r of m?.roles ?? []) {
    const create = target.createRole?.bind(target);
    if (create && (await attempt({ role: r.slug, space: r.space }, () => create({ slug: r.slug, name: r.name, description: r.description ?? undefined, permissions: r.actions, space: sp(r.space) })))) {
      report.model++;
    }
  }
  for (const [subject, rec] of Object.entries(snapshot.subjects)) {
    report.subjects++;
    if (Object.keys(rec.attrs ?? {}).length || rec.displayName) {
      await attempt({ subject }, () => target.setSubjectAttrs({ subject, attrs: rec.attrs ?? {}, displayName: rec.displayName ?? undefined }));
    }
    for (const g of rec.grants) {
      if (g.expiresAt !== null && Date.parse(g.expiresAt) <= now) {
        report.skipped.push({ subject, role: g.role, space: g.space, reason: "expired" });
        continue;
      }
      const ok = await attempt({ subject, role: g.role, space: g.space }, () =>
        target.grantRole({
          role: g.role,
          subject,
          space: sp(g.space),
          displayName: rec.displayName ?? undefined,
          expiresAt: g.expiresAt ?? undefined,
          condition: Object.keys(g.condition ?? {}).length ? g.condition : undefined,
        }),
      );
      if (ok) report.grants++;
    }
  }
  return report;
}
