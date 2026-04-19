import { apiPath } from '../lib/api.js';
import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import LootAudit from './LootAudit.jsx';

export default function LootImport() {
  const [file, setFile]         = useState(null);
  const [pasteText, setPasteText] = useState('');
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState(null);
  const [error, setError]       = useState(null);
  const inputRef = useRef();

  function handleFile(e) {
    const f = e.target.files[0];
    setFile(f ?? null);
    setPasteText('');
    setResult(null);
    setError(null);
  }

  function handlePaste(e) {
    setPasteText(e.target.value);
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
    setResult(null);
    setError(null);
  }

  const canSubmit = !!(file || pasteText.trim());

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const csvText = file ? await file.text() : pasteText;
      const res = await fetch(apiPath('/api/loot/import'), {
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
        setFile(null);
        setPasteText('');
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
        Export your session from RCLootCouncil and upload the CSV file, or paste the CSV text directly.
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

        <div className="loot-import-divider">
          <span>or paste CSV text</span>
        </div>

        <textarea
          className="loot-import-paste"
          placeholder="Paste CSV content here…"
          value={pasteText}
          onChange={handlePaste}
          rows={6}
          spellCheck={false}
        />

        <button
          type="submit"
          className="btn-primary"
          disabled={!canSubmit || loading}
        >
          {loading ? 'Importing…' : 'Import'}
        </button>
      </form>

      {error && (
        <div className="error">{error}</div>
      )}

      {result && (() => {
        const { noRosterMatch = 0, wrongDifficulty = 0 } = result.errorRows ?? {};
        const totalErrors = noRosterMatch + wrongDifficulty;
        return (
        <div className="loot-import-result">
          {totalErrors > 0 && (
            <div className="loot-import-error-notice">
              <span className="loot-import-error-icon">⚠</span>
              <span className="loot-import-error-msg">
                <strong>{totalErrors}</strong> imported {totalErrors === 1 ? 'entry has' : 'entries have'} errors
                {noRosterMatch   > 0 && <span> — <strong>{noRosterMatch}</strong> no roster match</span>}
                {wrongDifficulty > 0 && <span> — <strong>{wrongDifficulty}</strong> wrong difficulty</span>}
              </span>
              <Link className="loot-import-error-btn" to="/loot-history?review=1">
                Review &amp; Fix ↗
              </Link>
            </div>
          )}
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
        );
      })()}
      <LootAudit />
    </div>
  );
}
