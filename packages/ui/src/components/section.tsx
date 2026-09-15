import React from "react";
import { twMerge } from "tailwind-merge";

export const Section = ({
  title,
  description,
  children,
  className,
  cta,
  compact,
}: {
  title?: string | undefined;
  description?: string | undefined;
  children: React.ReactNode;
  className?: string;
  cta?: React.ReactNode | undefined;
  compact?: boolean;
}) => {
  return (
    <div
      className={twMerge(
        "relative flex flex-col",
        compact ? "gap-6 p-6 md:p-8" : "gap-8 p-6 md:p-12",
        className,
      )}
    >
      <SectionDescription title={title} description={description} cta={cta} />
      {children}
    </div>
  );
};

const SectionDescription = ({
  title,
  description,
  cta,
}: {
  title?: string | undefined;
  description?: string | undefined;
  cta?: React.ReactNode | undefined;
}) => {
  if (!title && !description && !cta) {
    return null;
  }

  return (
    <div className="flex w-full flex-col gap-y-6">
      <div className="flex flex-col gap-y-2">
        <h2 className="text-lg font-medium text-ink">{title}</h2>
        {description && <p className="leading-snug text-ink-muted">{description}</p>}
        {cta && <div className="flex flex-row gap-x-2">{cta}</div>}
      </div>
    </div>
  );
};
