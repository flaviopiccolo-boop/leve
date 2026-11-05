import { useEffect, useState } from 'react';
import { readImage } from './workspace';

type Preview = { url: string; size: number } | { error: string };

export default function ImagePreview({ path, name, root }: { path: string; name: string; root: string | null }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dimensions, setDimensions] = useState('');
  const [actualSize, setActualSize] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    void readImage(path, root).then(blob => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setPreview({ url, size: blob.size });
    }).catch(error => {
      if (!cancelled) setPreview({ error: String(error) });
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, root]);

  if (!preview) return <p className="panel-description">Loading image…</p>;
  if ('error' in preview) return <p className="panel-description" role="alert">Could not preview {name}: {preview.error}</p>;

  const fileSize = preview.size >= 1024 * 1024
    ? `${(preview.size / (1024 * 1024)).toFixed(1)} MB`
    : preview.size >= 1024 ? `${(preview.size / 1024).toFixed(1)} KB` : `${preview.size} B`;

  return <div className="image-preview">
    <div className="image-preview-toolbar">
      <div role="group" aria-label="Image scale">
        <button type="button" className="button secondary" aria-pressed={!actualSize} onClick={() => setActualSize(false)}>Fit</button>
        <button type="button" className="button secondary" aria-pressed={actualSize} onClick={() => setActualSize(true)}>100%</button>
      </div>
      <span>{dimensions ? `${dimensions} · ` : ''}{fileSize}</span>
    </div>
    <div className={`image-preview-stage${actualSize ? ' image-preview-actual' : ''}`} role="region" aria-label="Image preview" tabIndex={0}>
      <img src={preview.url} alt={name} draggable={false}
        onLoad={({ currentTarget }) => setDimensions(`${currentTarget.naturalWidth} × ${currentTarget.naturalHeight} px`)}
        onError={() => setPreview({ error: 'The image is empty, damaged, or uses an unsupported format.' })} />
    </div>
  </div>;
}
