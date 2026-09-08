import Link from "next/link";
import { cn } from "@/lib/utils";

/*
 * Keyring brand — official logomark tile plus wordmark lockup.
 */
export function KeyringMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Keyring"
      // The asset is a white mark on transparency, used as a mask filled
      // with currentColor — the mark always matches the surrounding text
      // color exactly (wordmark ink-navy, tile canvas, …) in every theme.
      className={cn("inline-block h-8 w-8", className)}
      style={{
        backgroundColor: "currentColor",
        WebkitMaskImage: "url(/keyring-logo.png)",
        maskImage: "url(/keyring-logo.png)",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
      }}
    />
  );
}

export function KeyringWordmark({
  size = "text-base",
  className,
}: {
  size?: string;
  className?: string;
}) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5", className)}>
      <KeyringMark className="h-6 w-6" />
      <span className={`type-label ${size} text-ink-navy`}>Keyring</span>
    </Link>
  );
}
