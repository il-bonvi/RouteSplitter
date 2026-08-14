import { useCallback, useRef, useState } from 'react';

interface UploadZoneProps {
  onFile: (file: File) => void;
  busy?: boolean;
}

export function UploadZone({ onFile, busy }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  return (
    <div
      className={`upload-zone${dragOver ? ' drag-over' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={e => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="icon" style={{ fontSize: '2.6rem', marginBottom: '14px' }}>
        🗺️
      </div>
      <div className="upload-zone-title">{busy ? 'Elaborazione…' : 'Carica un file GPX'}</div>
      <div className="upload-zone-hint">Trascina qui il file oppure clicca per selezionarlo</div>
      <input
        ref={inputRef}
        type="file"
        accept=".gpx"
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />
    </div>
  );
}
