import type { Metadata } from "next";
import { LandingCta } from "./landing-cta";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";
import {
  ConsoleMain,
  ConsoleNavLink,
  ConsoleUserRow,
  ConsoleMark,
  OverviewHeader,
  OverviewMatrix,
  OverviewStats,
  type NavEntry,
} from "./dashboard/console-ui";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { KeyringMark } from "@/components/ui/keyring-logo";
import {
  GlyphDenseStarburst,
  GlyphOrbitCircles,
  GlyphRules,
  GlyphSerpentine,
  GlyphSpiral,
  GlyphStarburst,
} from "./glyphs";

export const metadata: Metadata = {
  title: "Keyring — Access control infrastructure for your product",
  description:
    "Define actions, compose them into roles, and grant them to your product's users.",
};

const HERO_CARDS = [
  {
    t: "Actions",
    d: "The atomic things a user can do — invoices.refund, members.invite.",
    href: "#model",
    Glyph: GlyphStarburst,
  },
  {
    t: "Roles",
    d: "Named bundles of actions. Editor, Support, Finance — your words.",
    href: "#model",
    Glyph: GlyphDenseStarburst,
  },
  {
    t: "Grants",
    d: "Users hold roles. Access is the union of everything they hold.",
    href: "#model",
    Glyph: GlyphOrbitCircles,
  },
  {
    t: "Checks",
    d: "One call, decided in the database. No client can argue with it.",
    href: "#checks",
    Glyph: GlyphSpiral,
  },
];

const PILLARS = [
  {
    t: "Actions",
    d: "The atomic things a user can do — invoices.refund, members.invite. You define them.",
    Glyph: GlyphStarburst,
  },
  {
    t: "Roles",
    d: "Named bundles of actions. Editor, Support, Finance — whatever your org calls them.",
    Glyph: GlyphDenseStarburst,
  },
  {
    t: "Grants",
    d: "Users hold roles. A user can hold several; access is the union of all of them.",
    Glyph: GlyphOrbitCircles,
  },
];

const FEATURES = [
  {
    t: "One-call checks",
    d: "Every read and write is evaluated against the grant graph in the database itself.",
    Glyph: GlyphSpiral,
  },
  {
    t: "External subjects",
    d: "Your product's users connect by their own IDs. Console accounts never enter the graph.",
    Glyph: GlyphSerpentine,
  },
  {
    t: "Fresh by default",
    d: "No seeded roles, no demo actions. Your graph starts empty and stays yours.",
    Glyph: GlyphRules,
  },
  {
    t: "Union semantics",
    d: "Hold several roles and your access is simply the union of all of them.",
    Glyph: GlyphOrbitCircles,
  },
  {
    t: "Full audit trail",
    d: "Every grant, revocation and policy edit lands in the activity log.",
    Glyph: GlyphDenseStarburst,
  },
  {
    t: "Join requests",
    d: "Nobody self-joins a workspace. Membership starts with an approved request.",
    Glyph: GlyphStarburst,
  },
];

const MOSAIC_COLS = 28;
const MOSAIC_ROWS = 12;

function mosaicOpacity(i: number): number {
  const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
  if (h > 0.93) return 0.3;
  if (h > 0.82) return 0.18;
  return 0.03 + h * 0.08;
}

/* Hero visual — the real console overview, copied class-for-class from
   dashboard-chrome + dashboard/page and pinned to dark with the .dark
   wrapper, floating on the mosaic floor. Decorative, not interactive. */
function HeroVisual() {
  const stats = [
    { label: "Roles", value: 3, to: "/dashboard/roles", readable: true },
    { label: "Actions", value: 12, to: "/dashboard/actions", readable: true },
    { label: "Grants", value: 8, to: "/dashboard/users", readable: true },
    { label: "Users", value: 5, to: "/dashboard/users", readable: true },
  ] as const;
  const sections: { label: string; items: NavEntry[] }[] = [
    {
      label: "Manage",
      items: [
        { to: "/dashboard/actions", label: "Actions", icon: "actions" },
        { to: "/dashboard/roles", label: "Roles", icon: "roles" },
        { to: "/dashboard/members", label: "Members", icon: "members" },
        { to: "/dashboard/users", label: "Users", icon: "users" },
      ],
    },
    {
      label: "System",
      items: [
        { to: "/dashboard/audit", label: "Activity", icon: "activity" },
        { to: "/dashboard/settings", label: "Settings", icon: "settings" },
      ],
    },
  ];
  const matrixRoles = [
    { id: "support", name: "support" },
    { id: "finance", name: "finance" },
  ];
  const matrixPerms = [
    { id: "invoices.refund", slug: "invoices.refund" },
    { id: "members.invite", slug: "members.invite" },
  ];
  const matrixRolePerms = [
    { role_id: "support", permission_id: "invoices.refund" },
    { role_id: "support", permission_id: "members.invite" },
    { role_id: "finance", permission_id: "members.invite" },
  ];
  return (
    <div className="relative overflow-hidden rounded-3xl border border-hairline bg-pillar">
      <div
        aria-hidden
        className="absolute inset-0 grid"
        style={{
          gridTemplateColumns: `repeat(${MOSAIC_COLS}, 1fr)`,
          gridTemplateRows: `repeat(${MOSAIC_ROWS}, 1fr)`,
        }}
      >
        {Array.from({ length: MOSAIC_COLS * MOSAIC_ROWS }, (_, i) => (
          <div
            key={i}
            className="bg-ink-navy dark:bg-white"
            style={{ opacity: mosaicOpacity(i) }}
          />
        ))}
      </div>
      <div className="relative px-4 py-12 md:px-12 md:py-20">
        <div inert aria-hidden className="dark mx-auto max-w-5xl select-none">
          {/* Arc-style bezel: wide, uniform, translucent — flat color at
              reduced opacity, no gradient, no glow. */}
          <div className="rounded-[24px] bg-white/20 p-2">
            <div className="overflow-hidden rounded-[18px]">
              <div className="relative flex w-full flex-col bg-canvas md:aspect-[2560/1664] md:flex-row md:overflow-hidden md:p-2">
            <div className="bg-sidebar text-sidebar-foreground hidden w-56 shrink-0 flex-col md:flex">
              <SidebarHeader className="flex flex-row items-center justify-between md:pt-3.5">
                <ConsoleMark />
              </SidebarHeader>
              <SidebarContent className="gap-4 px-0 py-2">
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <ConsoleNavLink
                          href="/dashboard"
                          icon="overview"
                          label="Overview"
                          active
                          tabIndex={-1}
                        />
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                {sections.map((section) => (
                  <SidebarGroup key={section.label}>
                    <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {section.items.map((item) => (
                          <SidebarMenuItem key={item.to}>
                            <ConsoleNavLink
                              href={item.to}
                              icon={item.icon}
                              label={item.label}
                              active={false}
                              tabIndex={-1}
                            />
                          </SidebarMenuItem>
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </SidebarGroup>
                ))}
              </SidebarContent>
              <SidebarFooter>
                <div className="flex items-center gap-2 px-2 text-sm">
                  <ConsoleUserRow
                    email="jane@acme.com"
                    displayName="Jane Doe"
                    avatarUrl={null}
                  />
                </div>
              </SidebarFooter>
            </div>
            <ConsoleMain>
              <div className="space-y-6">
                <OverviewHeader orgName="Acme" />
                <OverviewStats stats={[...stats]} />
                <OverviewMatrix
                  roles={matrixRoles}
                  perms={matrixPerms}
                  rolePerms={matrixRolePerms}
                />
              </div>
            </ConsoleMain>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chapter({
  id,
  marker,
  title,
  subtitle,
  description,
  children,
}: {
  id?: string;
  marker: string;
  title: string;
  subtitle: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="scroll-mt-8 border-t border-hairline py-16 md:py-24"
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="type-display-md text-ink">{marker}</div>
        <div>
          <h2 className="text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-normal tracking-[-0.02em] text-balance text-ink">
            {title}
            <br />
            <span className="text-ink-muted">{subtitle}</span>
          </h2>
          {description && (
            <p className="type-body mt-6 max-w-xl text-ink-muted">{description}</p>
          )}
        </div>
      </div>
      <div className="mt-12 md:mt-16">{children}</div>
    </section>
  );
}

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-canvas">
      <SiteNav />

      <div className="px-5 md:px-12">
        <div className="mx-auto w-full max-w-[1920px]">
          {/* hero — left-aligned two-tone headline, single CTA, card grid */}
          <section className="flex flex-col gap-12 py-16 md:gap-16 md:py-24">
            <div className="max-w-3xl">
              <div className="flex items-center gap-2.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ink text-canvas">
                  <KeyringMark className="h-3 w-3" />
                </span>
                <span className="type-mono text-ink-muted">
                  Access-control infrastructure for your product
                </span>
              </div>
              <h1 className="mt-6 text-[clamp(2.75rem,6vw,4.5rem)] leading-[1.02] font-normal tracking-[-0.025em] text-balance text-ink-navy">
                Permissions that read
                <br />
                <span className="text-ink-muted">like sentences.</span>
              </h1>
            </div>
            <div className="mt-5 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <p className="type-body max-w-xl text-ink-muted">
                Define actions, compose them into roles, and grant them to your
                product&apos;s users — then answer any access question in one call.
              </p>
              <div className="shrink-0">
                <LandingCta large />
              </div>
            </div>

            <HeroVisual />

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {HERO_CARDS.map((c) => (
                <a
                  key={c.t}
                  href={c.href}
                  className="group flex flex-col justify-between gap-12 rounded-2xl bg-pillar p-8 transition-colors hover:bg-surface-1/60"
                >
                  <c.Glyph />
                  <div>
                    <h3 className="type-body-lg text-ink-navy">{c.t}</h3>
                    <p className="type-body-sm mt-1 text-ink-muted">{c.d}</p>
                  </div>
                </a>
              ))}
            </div>
          </section>

          {/* model chapter — pillars with visual boxes */}
          <Chapter
            id="model"
            marker="Model"
            title="Actions compose into roles"
            subtitle="granted to your users."
            description="Three primitives cover the whole access story. Your team operates the console while your product's users live in the graph — keyed by your own IDs, checked in one call."
          >
            <div className="grid gap-4 md:grid-cols-3">
              {PILLARS.map((p) => (
                <div key={p.t}>
                  <div className="flex min-h-56 items-center justify-center rounded-2xl bg-pillar p-8 md:min-h-72">
                    <p.Glyph />
                  </div>
                  <h3 className="type-body-lg mt-6 text-ink-navy">{p.t}</h3>
                  <p className="type-body-sm mt-1 max-w-md text-ink-muted">{p.d}</p>
                </div>
              ))}
            </div>
          </Chapter>

          {/* checks chapter — matrix vignette beside the SQL */}
          <Chapter
            id="checks"
            marker="Checks"
            title="Any access question."
            subtitle="Ships in an afternoon."
            description="Every read and write is evaluated against the grant graph in the database itself, so a client can never talk itself into an action it doesn't hold."
          >
            <div className="dark rounded-2xl border border-hairline bg-white p-6 md:p-8 dark:border-polar-800 dark:bg-polar-900">
              <div className="flex items-center justify-between gap-4">
                <span className="type-mono text-ink-muted">GET /api/v1/check</span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-green" />
                  <span className="type-mono text-ink">allow</span>
                </span>
              </div>
              <div className="type-mono mt-6 overflow-x-auto text-ink-navy">
                <pre className="whitespace-pre text-xs leading-[22px]">
                  <span className="text-ink-muted">?subject=</span>
                  <span className="text-green">user_123</span>
                  <span className="text-ink-muted">&permission=</span>
                  <span className="text-green">invoices.refund</span>
                  {"\n\n"}
                  <span className="text-ink-muted">{"{"}</span>
                  {"\n  "}&quot;subject&quot;: <span className="text-green">&quot;user_123&quot;</span>,
                  {"\n  "}&quot;permission&quot;: <span className="text-green">&quot;invoices.refund&quot;</span>,
                  {"\n  "}&quot;allowed&quot;: <span className="font-medium text-ink">true</span>
                  {"\n"}
                  <span className="text-ink-muted">{"}"}</span>
                </pre>
              </div>
              <div className="type-mono mt-6 flex items-center justify-between border-t border-hairline pt-4 text-ink-muted">
                <span>-- bearer key in, boolean out</span>
                <span>200 OK</span>
              </div>
            </div>
          </Chapter>

          {/* platform chapter — feature grid */}
          <Chapter
            id="roles"
            marker="Platform"
            title="More than allow or deny"
            subtitle="the whole workflow around it."
          >
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.t} className="rounded-2xl bg-pillar p-8">
                  <f.Glyph />
                  <h3 className="type-body-lg mt-6 text-ink-navy">{f.t}</h3>
                  <p className="type-body-sm mt-2 text-ink-muted">{f.d}</p>
                </div>
              ))}
            </div>
          </Chapter>

          {/* closing CTA */}
          <section className="flex flex-col items-center gap-6 border-t border-hairline py-16 text-center md:py-24">
            <h2 className="text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-normal tracking-[-0.02em] text-balance text-ink">
              Actions in, decisions out.
              <br />
              <span className="text-ink-muted">Create your workspace today.</span>
            </h2>
            <LandingCta large />
          </section>
        </div>
      </div>

      <SiteFooter />
    </main>
  );
}
