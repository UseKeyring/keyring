"use client";

import { useState } from "react";

/* `$ npx @usekeyring/cli dev │ copy` — blocky ASCII command with one-click copy. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cmd"
      aria-label={copied ? "Copied" : `Copy command: ${command}`}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      <span className="t">
        <span className="dim">$ </span>
        {command}
      </span>
      <span className="c">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
