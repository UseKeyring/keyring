import { source } from "@/lib/source";
import {
  PageArticle,
  PageFooter,
  PageRoot,
  PageTOC,
  PageTOCItems,
  PageTOCPopover,
  PageTOCPopoverContent,
  PageTOCPopoverItems,
  PageTOCPopoverTrigger,
  PageTOCTitle,
} from "fumadocs-ui/layouts/docs/page";
import { DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";
import Link from "next/link";
import { GITHUB_URL } from "@/lib/site";

/* `[03]` — the page's position in the sidebar, like the landing's section labels. */
function pageNumber(url: string) {
  const pages: { url: string }[] = [];
  const walk = (nodes: typeof source.pageTree.children) => {
    for (const node of nodes) {
      if (node.type === "page") pages.push(node);
      else if (node.type === "folder") {
        if (node.index) pages.push(node.index);
        walk(node.children);
      }
    }
  };
  walk(source.pageTree.children);
  const i = pages.findIndex((p) => p.url === url);
  return String(i === -1 ? 0 : i).padStart(2, "0");
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  // `docs` in source.config.ts is loosely typed (bun isolated store breaks
  // portable inference), so page data arrives as never — cast to the shape
  // the MDX codegen actually produces.
  const data = page.data as unknown as {
    body: React.ComponentType<{ components?: Record<string, unknown> }>;
    toc: import("fumadocs-core/toc").TOCItemType[];
    title: string;
    description?: string;
  };
  const MDX = data.body;

  return (
    <PageRoot toc={{ toc: data.toc }}>
      <PageTOCPopover>
        <PageTOCPopoverTrigger />
        <PageTOCPopoverContent>
          <PageTOCPopoverItems />
        </PageTOCPopoverContent>
      </PageTOCPopover>
      <PageArticle>
        <div className="label rule kr-docs-crumb">
          <span className="accent">[{pageNumber(page.url)}]</span>
          <span>
            <Link href="/docs">docs</Link>
            {params.slug?.map((part) => ` / ${part}`)}
          </span>
        </div>
        <DocsTitle className="kr-docs-h1">{data.title}</DocsTitle>
        <DocsDescription className="kr-docs-lede">{data.description}</DocsDescription>
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
        <PageFooter className="kr-docs-footer" />
        <div className="kr-docs-colophon">
          <span>© {new Date().getFullYear()} keyring · mit licensed</span>
          <a href={`${GITHUB_URL}/tree/main/apps/web/content/docs/${page.path}`} target="_blank" rel="noreferrer">
            edit this page ↗
          </a>
        </div>
      </PageArticle>
      <PageTOC>
        <PageTOCTitle />
        <PageTOCItems />
      </PageTOC>
    </PageRoot>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const data = page.data as unknown as { title: string; description?: string };
  return {
    title: `${data.title} — Keyring Docs`,
    description: data.description,
  };
}
