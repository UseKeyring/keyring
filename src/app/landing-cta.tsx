"use client";

import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

export function LandingCta({ large = false }: { large?: boolean }) {
  const { user } = useAuth();
  return (
    <Button asChild size={large ? "lg" : "default"}>
      <Link href={user ? "/dashboard" : "/auth"}>{user ? "Open console" : large ? "Create your workspace" : "Start free"}</Link>
    </Button>
  );
}
