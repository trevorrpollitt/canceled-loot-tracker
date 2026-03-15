import { useState, useRef } from 'react';

export default function LootImport() {
  const [file, setFile]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);
  const inputRef = useRef();

  function handleFile(e) {
    const f = e.target.files[0];
    setFile(f ?? null);
    setResult(null);
    setError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const csvText = await file.text();
      const res = await fetch('/api/loot/import', {
        method:      'POST',
        credentials: 'include',
        headers:     { 'Content-Type': 'application/json' },
        body:        JSON.stringify({ csvText }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Import failed.');
      } else {
        setResult(data);
        // Reset the file input
        setFile(null);
        if (inputRef.current) inputRef.current.value = '';
      }
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-content">
      <h1 className="page-title">Import Loot</h1>
      <p className="page-subtitle">
        Export your session from RCLootCouncil and upload the CSV here.
        Duplicate entries (same character + item + date) are skipped automatically.
      </p>

      <form className="loot-import-form" onSubmit={handleSubmit}>
        <div className="loot-import-dropzone" onClick={() => inputRef.current?.click()}>
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          {file
            ? <span className="loot-import-filename">📄 {file.name}</span>
            : <span className="loot-import-placeholder">Click to select a CSV file</span>
          }
        </div>

        <button
          type="submit"
          className="btn-primary"
          disabled={!file || loading}
        >
          {loading ? 'Importing…' : 'Import'}
        </button>
      </form>

      {error && (
        <div className="error">{error}</div>
      )}

      {result && (
        <div className="loot-import-result">
          <div className="loot-import-stats">
            <div className="loot-import-stat">
              <span className="loot-import-stat-value">{result.imported}</span>
              <span className="loot-import-stat-label">Imported</span>
            </div>
            <div className="loot-import-stat">
              <span className="loot-import-stat-value">{result.skipped}</span>
              <span className="loot-import-stat-label">Skipped</span>
            </div>
            <div className="loot-import-stat">
              <span className="loot-import-stat-value">{result.total}</span>
              <span className="loot-import-stat-label">Total rows</span>
            </div>
          </div>

          {result.warnings?.length > 0 && (
            <div className="loot-import-warnings">
              <p className="loot-import-warnings-title">
                ⚠️ {result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}
              </p>
              <ul className="loot-import-warnings-list">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
