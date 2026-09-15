"use client";

import { AvatarUpload as UiAvatarUpload } from "@keyring/ui/components/avatar-upload";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";

type Props = Omit<
  React.ComponentProps<typeof UiAvatarUpload>,
  "uploadFile"
>;

/*
 * App-side AvatarUpload — injects Supabase "Avatars" bucket storage into the
 * shared UI component so packages/ui stays storage-agnostic.
 */
export function AvatarUpload(props: Props) {
  const uploadFile = async (path: string, file: File) => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase
      .storage.from("Avatars")
      .upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from("Avatars").getPublicUrl(path);
    return data.publicUrl;
  };

  return <UiAvatarUpload {...props} uploadFile={uploadFile} />;
}
