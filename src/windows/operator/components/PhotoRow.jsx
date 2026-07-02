import PhotoStatusBadge from "./PhotoStatusBadge";
import FallbackImage from "../../../shared/FallbackImage";

export default function PhotoRow({ photo, displayIndex }) {
  return (
    <article className="photo-row" role="listitem">
      <p className="photo-index">#{displayIndex}</p>
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
      <p className="photo-name" title={photo.name}>
        {photo.name}
      </p>
      <p className="photo-path" title={photo.path}>
        {photo.path}
      </p>
      <PhotoStatusBadge status={photo.indexedStatus} lastError={photo.lastError || ""} />
    </article>
  );
}
