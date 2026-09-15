"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@keyring/ui/components/profile-avatar";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

/*
 * Avatar upload button — hover overlay on the current avatar, uploads via the
 * injected `uploadFile` (storage lives in the app, not the UI package) and
 * returns the public URL. Shared by the organization logo field and personal
 * account settings; only the storage path prefix and noun differ.
 */
export function AvatarUpload({
  name,
  value,
  onChange,
  disabled,
  storagePrefix,
  noun = "Image",
  uploadFile,
}: {
  name: string;
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean | undefined;
  storagePrefix: string;
  noun?: string | undefined;
  uploadFile: (path: string, file: File) => Promise<string>;
}) {
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!/^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.type)) {
      toast.error(`${noun} must be an image (JPEG, PNG, GIF, WebP or SVG)`);
      return;
    }
    if (file.size > 1024 * 1024) {
      toast.error(`${noun} must be under 1MB`);
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${storagePrefix}/${crypto.randomUUID()}.${ext}`;
      const publicUrl = await uploadFile(path, file);
      onChange(publicUrl);
      toast.success(`${noun} uploaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        disabled={disabled || uploading}
        onClick={() => inputRef.current?.click()}
        aria-label={`Upload ${noun.toLowerCase()}`}
        className="group relative block cursor-pointer disabled:cursor-not-allowed"
      >
        <Avatar name={name || "?"} avatar_url={value || null} className="h-10 w-10" />
        {!disabled && (
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin text-white" />
            ) : (
              <SolarIcon name="plus" className="h-4 w-4 text-white" />
            )}
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
    </div>
  );
}
