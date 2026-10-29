import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";

/*
 * Styling hooks for the ASCII docs (src/app/docs/docs.css): every code
 * block gets a `.win`-style title bar: the fence title, else its language
 * when the rehype pipeline exposes `data-language`, else a bare `~` prompt.
 * Callouts are imported directly by the MDX files, so docs.css styles them
 * by their --callout-color hook instead.
 */
function CodeWindow({ title, ...props }: ComponentProps<"pre">) {
  const lang = (props as Record<string, unknown>)["data-language"];
  const label =
    title ??
    (typeof lang === "string" && lang !== "plaintext" ? (
      <>
        <span className="kr-code-lang">~</span>/{lang}
      </>
    ) : (
      <>
        <span className="kr-code-lang">~</span> snippet
      </>
    ));
  return (
    // `title` is typed string but rendered as a ReactNode inside <figcaption>.
    <CodeBlock {...props} title={label as unknown as string}>
      <Pre>{props.children}</Pre>
    </CodeBlock>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: CodeWindow,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
