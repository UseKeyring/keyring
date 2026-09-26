import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { KeyringMark } from "@keyring/ui/components/keyring-logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ink text-canvas">
            <KeyringMark className="h-3 w-3" />
          </span>
          Keyring Docs
        </span>
      ),
    },
  };
}
