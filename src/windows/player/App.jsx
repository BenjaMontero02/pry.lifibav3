import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import FallbackImage from "../../shared/FallbackImage";
import { getDesktopApi } from "../../shared/desktopApi";
import isEditableTarget from "../../shared/isEditableTarget";
import { buildSourceThumbUrl } from "../../shared/sourceUrls";

const EMPTY_PAYLOAD = Object.freeze({ photos: [], updatedAt: null });
const INITIAL_VISIBLE_COUNT = 24;
const LOAD_MORE_STEP = 24;
const preloadedImageUrls = new Set();

function resolveDisplayNumber(photo, fallbackIndex) {
  if (Number.isFinite(photo?.displayNumber) && photo.displayNumber > 0) {
    return photo.displayNumber;
  }
  return fallbackIndex + 1;
}

function normalizePhotoIndex(index, photosLength) {
  if (photosLength <= 0) {
    return 0;
  }
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.min(Math.max(index, 0), photosLength - 1);
}

function getAdjacentPhotoIndex(currentIndex, photosLength, direction) {
  if (photosLength <= 1) {
    return normalizePhotoIndex(currentIndex, photosLength);
  }
  const normalizedIndex = normalizePhotoIndex(currentIndex, photosLength);
  return (normalizedIndex + direction + photosLength) % photosLength;
}

function preloadPhotoUrl(url) {
  if (!url || preloadedImageUrls.has(url) || typeof window === "undefined") {
    return;
  }
  preloadedImageUrls.add(url);
  const image = new window.Image();
  image.decoding = "async";
  image.src = url;
}

function exitDocumentFullscreen() {
  if (!document.fullscreenElement || !document.exitFullscreen) {
    return;
  }
  document.exitFullscreen().catch(() => undefined);
}

function toggleDocumentFullscreen() {
  if (document.fullscreenElement) {
    exitDocumentFullscreen();
    return;
  }
  document.documentElement.requestFullscreen?.().catch(() => undefined);
}

// Foto completa: solo para la foto destacada. La grilla usa miniaturas.
const HeroPhoto = memo(function HeroPhoto({ photo, total }) {
  if (!photo) {
    return null;
  }
  return (
    <article className="player-hero-card" aria-label="Foto destacada">
      <FallbackImage
        key={photo.url}
        className="player-hero-media"
        src={photo.url}
        alt={`Foto ${photo.displayNumber} de ${total}`}
        fallbackLabel="Sin imagen"
        loading="eager"
        fetchPriority="high"
        decoding="sync"
        width="1200"
        height="900"
      />
      <span className="player-reference player-reference-hero">
        Foto {photo.displayNumber} de {total}
      </span>
    </article>
  );
});

const GalleryPhoto = memo(function GalleryPhoto({ photo, originalIndex, onSelect }) {
  const handleSelect = useCallback(() => {
    onSelect(originalIndex);
  }, [onSelect, originalIndex]);

  return (
    <button
      type="button"
      className="player-photo-card"
      onClick={handleSelect}
      aria-label={`Ver foto ${photo.displayNumber} de ${photo.total}`}
    >
      <FallbackImage
        className="player-photo-image"
        src={photo.thumbUrl || photo.url}
        fallbackSrc={photo.url}
        alt={`Foto ${photo.displayNumber} de ${photo.total}`}
        fallbackLabel="Sin imagen"
        loading="lazy"
        decoding="async"
        width="480"
        height="600"
      />
    </button>
  );
});

export default function App() {
  const desktopApi = useMemo(() => getDesktopApi(), []);
  const photosLengthRef = useRef(0);
  const lastAppliedUpdatedAtRef = useRef(null);
  const hasAppliedPreviewRef = useRef(false);
  const [previewPayload, setPreviewPayload] = useState(EMPTY_PAYLOAD);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  // Indicacion del escaneo en 3 angulos ("Mira a la camara"...); null = oculta.
  const [scanPrompt, setScanPrompt] = useState(null);

  useEffect(() => {
    if (!desktopApi?.on) {
      return undefined;
    }
    return desktopApi.on("player:scan-prompt", (payload) => {
      setScanPrompt(typeof payload?.text === "string" && payload.text ? payload.text : null);
    });
  }, [desktopApi]);

  useEffect(() => {
    let active = true;

    const applyPreviewPayload = (payload) => {
      const nextPayload = payload || EMPTY_PAYLOAD;
      const updatedAt = Number(nextPayload.updatedAt);
      const hasUpdatedAt = Number.isFinite(updatedAt) && updatedAt > 0;
      const lastAppliedAt = lastAppliedUpdatedAtRef.current;

      if (lastAppliedAt !== null && (!hasUpdatedAt || updatedAt <= lastAppliedAt)) {
        return;
      }

      if (hasUpdatedAt) {
        lastAppliedUpdatedAtRef.current = updatedAt;
      }
      hasAppliedPreviewRef.current = true;
      setPreviewPayload(nextPayload);
    };

    const loadCurrentPreview = async () => {
      try {
        const payload = await desktopApi.invoke("player:get-preview-photos");
        if (active && payload) {
          applyPreviewPayload(payload);
        }
      } catch {
        if (active && !hasAppliedPreviewRef.current) {
          setPreviewPayload(EMPTY_PAYLOAD);
        }
      }
    };

    loadCurrentPreview();
    const unsubscribe = desktopApi.on("player:preview-photos", (payload) => {
      if (!active) {
        return;
      }
      applyPreviewPayload(payload);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktopApi]);

  const photos = useMemo(() => {
    if (!Array.isArray(previewPayload?.photos)) {
      return [];
    }
    const validPhotos = previewPayload.photos.filter((photo) => photo && photo.url);
    return validPhotos.map((photo, index) => ({
      photoPath: photo.photoPath,
      url: photo.url,
      thumbUrl: photo.photoPath ? buildSourceThumbUrl(photo.photoPath) : "",
      displayNumber: resolveDisplayNumber(photo, index),
      total: validPhotos.length
    }));
  }, [previewPayload]);

  photosLengthRef.current = photos.length;

  useEffect(() => {
    setVisibleCount((current) => (current === INITIAL_VISIBLE_COUNT ? current : INITIAL_VISIBLE_COUNT));
    setActivePhotoIndex((current) => (current === 0 ? current : 0));
  }, [photos]);

  const normalizedActivePhotoIndex =
    activePhotoIndex >= 0 && activePhotoIndex < photos.length ? activePhotoIndex : 0;
  const heroPhoto = photos[normalizedActivePhotoIndex] || null;
  const galleryPhotos = useMemo(
    () =>
      photos
        .map((photo, index) => ({ photo, originalIndex: index }))
        .filter((item) => item.originalIndex !== normalizedActivePhotoIndex),
    [photos, normalizedActivePhotoIndex]
  );
  const visiblePhotos = useMemo(() => galleryPhotos.slice(0, visibleCount), [galleryPhotos, visibleCount]);
  const hasMorePhotos = galleryPhotos.length > visiblePhotos.length;

  useEffect(() => {
    if (photos.length <= 1) {
      return;
    }
    preloadPhotoUrl(photos[getAdjacentPhotoIndex(normalizedActivePhotoIndex, photos.length, -1)]?.url);
    preloadPhotoUrl(photos[getAdjacentPhotoIndex(normalizedActivePhotoIndex, photos.length, 1)]?.url);
  }, [normalizedActivePhotoIndex, photos]);

  const handleShowMore = useCallback(() => {
    setVisibleCount((current) => current + LOAD_MORE_STEP);
  }, []);

  const handleSelectPhoto = useCallback((index) => {
    setActivePhotoIndex((current) => {
      const nextIndex = normalizePhotoIndex(index, photosLengthRef.current);
      return current === nextIndex ? current : nextIndex;
    });
  }, []);

  const handleSelectNextPhoto = useCallback(() => {
    setActivePhotoIndex((current) => {
      const nextIndex = getAdjacentPhotoIndex(current, photosLengthRef.current, 1);
      return current === nextIndex ? current : nextIndex;
    });
  }, []);

  const handleSelectPreviousPhoto = useCallback(() => {
    setActivePhotoIndex((current) => {
      const nextIndex = getAdjacentPhotoIndex(current, photosLengthRef.current, -1);
      return current === nextIndex ? current : nextIndex;
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowRight") {
        if (photosLengthRef.current <= 1) {
          return;
        }
        event.preventDefault();
        if (!event.repeat) {
          handleSelectNextPhoto();
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        if (photosLengthRef.current <= 1) {
          return;
        }
        event.preventDefault();
        if (!event.repeat) {
          handleSelectPreviousPhoto();
        }
        return;
      }

      if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        if (!event.repeat) {
          toggleDocumentFullscreen();
        }
        return;
      }

      if (event.key === "Escape" && document.fullscreenElement) {
        event.preventDefault();
        exitDocumentFullscreen();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleSelectNextPhoto, handleSelectPreviousPhoto]);

  return (
    <main className="player-shell">
      <section className="player-stage">
        {photos.length === 0 ? (
          <section className="player-empty">
            <span className="player-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
                <circle cx="12" cy="13" r="3.2" />
              </svg>
            </span>
            <p className="player-empty-title">Tus fotos van a aparecer acá</p>
            <p className="player-empty-text">Cuando el operador elija tus fotos, se muestran en esta pantalla.</p>
          </section>
        ) : (
          <section className="player-gallery" aria-label="Tus fotos del evento">
            <HeroPhoto photo={heroPhoto} total={photos.length} />

            {galleryPhotos.length > 0 ? (
              <section className="player-grid" aria-label="Galeria de fotos">
                {visiblePhotos.map((item) => (
                  <GalleryPhoto
                    key={`${item.photo.photoPath || item.photo.url}-${item.photo.displayNumber || "x"}`}
                    photo={item.photo}
                    originalIndex={item.originalIndex}
                    onSelect={handleSelectPhoto}
                  />
                ))}
              </section>
            ) : null}

            {hasMorePhotos ? (
              <div className="player-more-wrap">
                <button type="button" className="player-more" onClick={handleShowMore}>
                  Mostrar mas
                </button>
              </div>
            ) : null}

            <p className="player-keys" aria-hidden="true">
              <kbd>←</kbd> <kbd>→</kbd> cambiar foto · <kbd>F</kbd> pantalla completa
            </p>
          </section>
        )}
      </section>
      {scanPrompt ? (
        <div className="player-scan-prompt" role="status" aria-live="assertive">
          <p>{scanPrompt}</p>
        </div>
      ) : null}
    </main>
  );
}
