import { source } from "@/lib/source";
import {
  PageArticle,
  PageBreadcrumb,
  PageFooter,
  PageRoot,
  PageTOC,
} from "fumadocs-ui/layouts/docs/page";
import { DocsBody, DocsDescription, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { getMDXComponents } from "@/components/mdx";
import type { Metadata } from "next";
import { createRelativeLink } from "fumadocs-ui/mdx";

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
      <PageArticle>
        <PageBreadcrumb />
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>
          <MDX
            components={getMDXComponents({
              a: createRelativeLink(source, page),
            })}
          />
        </DocsBody>
        <PageFooter />
      </PageArticle>
      <PageTOC />
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
