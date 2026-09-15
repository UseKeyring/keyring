import Link from "next/link";
import { Button } from "@keyring/ui/components/button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-8">
      <div className="max-w-md text-center">
        <div className="type-eyebrow text-ink-muted">404</div>
        <h1 className="type-h2 mt-2 text-ink-navy" style={{ fontSize: "48px", lineHeight: "60px" }}>
          Page not found
        </h1>
        <p className="type-body mt-3 text-ink-muted">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <div className="mt-6">
          <Button asChild>
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
