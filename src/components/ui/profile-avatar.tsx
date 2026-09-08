"use client";

import { ComponentProps, useCallback, useState } from "react";
import { twMerge } from "tailwind-merge";

export interface ProfileAvatarProps {
  name: string;
  avatar_url?: string | null;
  className?: string;
}

const ProfileAvatar = ({ name, avatar_url, className }: ProfileAvatarProps) => {
  const initials = getInitials(name);

  // We render the image with opacity: 0 until it's successfully loaded.
  // Not doing so can result in a flash of the `alt` text when a 404
  // is returned from browser cache.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [showInitials, setShowInitials] = useState(!avatar_url);

  const onLoad = useCallback(() => {
    setHasLoaded(true);
    setShowInitials(false);
  }, [setHasLoaded, setShowInitials]);

  const onError = useCallback(() => {
    setShowInitials(true);
    setHasLoaded(true);
  }, [setHasLoaded, setShowInitials]);

  // Callback ref to detect images already in the browser cache.
  const imgRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && node.complete) {
        setHasLoaded(true);
        setShowInitials(false);
      }
    },
    [setHasLoaded, setShowInitials],
  );

  return (
    <div
      className={twMerge(
        "relative z-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-pillar font-sans text-[10px] text-ink-muted dark:bg-polar-800",
        className,
      )}
    >
      <span className="absolute inset-0 z-2 rounded-full ring ring-white/10 ring-inset"></span>
      {!avatar_url || showInitials ? (
        <div className="absolute inset-0 flex items-center justify-center bg-transparent">
          <span>{initials}</span>
        </div>
      ) : (
        <img
          ref={imgRef}
          alt={name}
          src={avatar_url}
          loading="eager"
          onLoad={onLoad}
          onError={onError}
          className={twMerge(
            "z-1 aspect-square rounded-full object-cover",
            hasLoaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </div>
  );
};

export const Avatar = (props: ComponentProps<typeof ProfileAvatar>) => {
  return <ProfileAvatar {...props} key={props.avatar_url ?? props.name} />;
};

const getInitials = (fullName: string) => {
  const allNames = (fullName.split("@")[0] ?? "") // In case it's passed an email
    .replace(/[^a-zA-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  const initials = allNames.reduce((acc, curr, index) => {
    if (index === 0 || index === allNames.length - 1) {
      acc = `${acc}${curr.charAt(0).toUpperCase()}`;
    }
    return acc;
  }, "");
  return initials;
};
