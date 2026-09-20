"use client";

import { useState } from "react";
import { ImageIcon } from "lucide-react";
import { mediaFileUrl } from "./media/media-picker";

/**
 * The one restaurant product-image renderer — the POS tile, the waiter card
 * and the menu-manager row all show a menu item's catalogue photo through
 * this component, so they can never disagree about canonical-media-first /
 * legacy-URL-fallback resolution, lazy loading, or what happens when the
 * bytes are unavailable (a broken <img> is never shown; a neutral
 * placeholder is, and selling is never blocked by media storage).
 *
 * The image is *decorative by default: the item's name is always rendered as
 * text beside it, so the alt text stays empty and screen readers are not
 * read the same word twice.
 */
export function MenuItemImage({
  mediaId,
  url,
  className = "",
  /** Accessible label; empty when the surrounding UI already names the item. */
  alt = "",
  iconClassName = "size-5",
}: {
  /** Canonical media_assets id (migration 0149) — preferred when set. */
  mediaId: string | null;
  /** Legacy image_url — the compatibility path for pre-library installations. */
  url?: string | null;
  className?: string;
  alt?: string;
  iconClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = mediaId ? mediaFileUrl(mediaId) : url || null;

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className={
          "flex items-center justify-center bg-muted text-muted-foreground " + className
        }
      >
        <ImageIcon className={iconClassName} aria-hidden="true" />
      </span>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element -- the app's media
       proxy serves tenant-scoped bytes; next/image adds nothing for a
       fixed-size tile and complicates the offline desktop runtime. */
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={"bg-muted object-cover " + className}
    />
  );
}
