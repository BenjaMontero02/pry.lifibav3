import { useCallback, useEffect, useState } from "react";

function joinClassNames(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export default function FallbackImage({
  src,
  fallbackSrc = "",
  alt = "",
  className = "",
  placeholderClassName = "",
  fallbackLabel = "Sin imagen",
  ...imageProps
}) {
  const [currentSrc, setCurrentSrc] = useState(src || fallbackSrc || "");

  useEffect(() => {
    setCurrentSrc(src || fallbackSrc || "");
  }, [fallbackSrc, src]);

  const handleError = useCallback(() => {
    if (fallbackSrc && currentSrc !== fallbackSrc) {
      setCurrentSrc(fallbackSrc);
      return;
    }
    setCurrentSrc("");
  }, [currentSrc, fallbackSrc]);

  if (!currentSrc) {
    return (
      <span
        className={joinClassNames(className, "image-placeholder", placeholderClassName)}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        {fallbackLabel}
      </span>
    );
  }

  return <img {...imageProps} className={className} src={currentSrc} alt={alt} onError={handleError} />;
}
