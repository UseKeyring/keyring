"use client";

import Link from "next/link";
import { Button } from "@keyring/ui/components/button";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

/*
 * Cloned from Polar's CreateProductPage:
 * clients/apps/web/src/components/Products/CreateProductPage.tsx
 * header={<Link href=".../new/ai"><Button variant="secondary"><Wand2Icon/> Create with AI</Button></Link>}
 */
export function CreateWithAiButton({ href }: { href: string }) {
  return (
    <Link href={href}>
      <Button variant="secondary">
        <SolarIcon name="wand" className="h-4 w-4" />
        Create with AI
      </Button>
    </Link>
  );
}

/*
 * Cloned from Polar's AIProductPage:
 * clients/apps/web/src/app/(main)/dashboard/[organization]/(header)/products/new/ai/AIProductPage.tsx
 * header={<Link href=".../new"><Button variant="secondary"><ArrowLeftIcon/> Configure manually</Button></Link>}
 */
export function ConfigureManuallyButton({ href }: { href: string }) {
  return (
    <Link href={href}>
      <Button variant="secondary">
        <SolarIcon name="reply" className="h-4 w-4" />
        Configure manually
      </Button>
    </Link>
  );
}
