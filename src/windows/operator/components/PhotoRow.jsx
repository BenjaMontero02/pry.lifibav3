import PhotoStatusBadge from "./PhotoStatusBadge";
import FallbackImage from "../../../shared/FallbackImage";

export default function PhotoRow({ photo, displayIndex, onOpen }) {
  const canOpen = typeof onOpen === "function";
  const handleOpen = () => {
    if (canOpen) {
      onOpen(photo);
    }
  };

  return (
    <article className="photo-row" role="listitem">
      <p className="photo-index">#{displayIndex}</p>
      <button
        type="button"
        className="photo-open-btn"
        onClick={handleOpen}
        disabled={!canOpen}
        title="Abrir foto"
        aria-label={`Abrir foto ${photo.name}`}
      >
        <FallbackImage
          src={photo.thumbUrl || photo.url}
          fallbackSrc={photo.url}
          alt=""
          className="photo-thumb"
          fallbackLabel="Foto"
          loading="lazy"
          width="56"
          height="56"
        />
      </button>
      <p className="photo-name" title={photo.name}>
        <button type="button" className="photo-open-link" onClick={handleOpen} disabled={!canOpen}>
          {photo.name}
        </button>
      </p>
      <p className="photo-path" title={photo.path}>
        {photo.path}
      </p>
      <PhotoStatusBadge status={photo.indexedStatus} lastError={photo.lastError || ""} />
    </article>
  );
}
