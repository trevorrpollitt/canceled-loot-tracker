/**
 * ItemSelect — custom dropdown with Wowhead tooltip support on hovered options.
 *
 * Native <select> can't host Wowhead tooltips because browser-rendered option
 * lists don't support custom hover events. This component renders a styled
 * button + positioned list where each option wraps its item name in an <a> tag
 * pointing at the Wowhead item URL. Wowhead's power.js attaches to those links
 * via mouseenter, so tooltips fire while browsing the list.
 *
 * Props:
 *   value          — currently selected item name (string)
 *   options        — [{ itemId, name, difficulty, source }] sorted by difficulty
 *   sentinels      — [{ value, label }] e.g. [{ value: '<Tier>', label: '<Tier>' }]
 *   onChange       — (name, itemId) => void
 *   placeholder    — string shown when value is empty
 *   empty          — bool; applies .raid-bis-empty highlight when true
 *   defaultValue   — item name matching the spec default      → ★ (teal)
 *   approvedValue  — item name matching the approved submission → ✓ (green)
 *   pendingValue   — item name matching the pending submission  → ● (amber)
 *
 * Multiple badges can appear on the same option (e.g. spec default that also
 * happens to be your approved selection).
 */

import { useState, useEffect, useRef } from 'react';

const DIFF_ORDER = ['Mythic', 'Heroic', 'Normal', 'Mythic+'];

// ── Per-option badge cluster ──────────────────────────────────────────────────

function OptionBadges({ name, defaultValue, approvedValue, pendingValue }) {
  const isDefault  = defaultValue  && name === defaultValue;
  const isApproved = approvedValue && name === approvedValue;
  const isPending  = pendingValue  && name === pendingValue;
  if (!isDefault && !isApproved && !isPending) return null;
  return (
    <span className="item-select-badges">
      {isDefault  && <span className="item-select-badge-default"  title="Spec default">★</span>}
      {isApproved && <span className="item-select-badge-approved" title="Your approved selection">✓</span>}
      {isPending  && <span className="item-select-badge-pending"  title="Your pending selection">●</span>}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ItemSelect({
  value         = '',
  options       = [],
  sentinels     = [],
  onChange,
  placeholder   = '— None —',
  empty         = false,
  defaultValue  = '',
  approvedValue = '',
  pendingValue  = '',
}) {
  const [open, setOpen] = useState(false);
  const containerRef    = useRef(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onMouse = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Refresh Wowhead tooltips after the list renders into the DOM
  useEffect(() => {
    if (open) window.$WowheadPower?.refreshLinks();
  }, [open]);

  const select = (name, itemId = '') => {
    onChange(name, itemId);
    setOpen(false);
  };

  const grouped = DIFF_ORDER
    .map(diff => ({ diff, items: options.filter(o => o.difficulty === diff) }))
    .filter(g => g.items.length > 0);

  const hasItems = sentinels.length > 0 || grouped.length > 0;

  return (
    <div
      className={`item-select${open ? ' item-select-open' : ''}${empty ? ' raid-bis-empty' : ''}`}
      ref={containerRef}
    >
      {/* Trigger button */}
      <button
        type="button"
        className="item-select-trigger"
        onClick={() => setOpen(o => !o)}
      >
        <span className={`item-select-value${!value ? ' item-select-placeholder' : ''}`}>
          {value || placeholder}
        </span>
        <span className="item-select-arrow" aria-hidden>▾</span>
      </button>

      {/* Dropdown list */}
      {open && (
        <div className="item-select-dropdown">
          {/* Clear option */}
          <div
            className={`item-select-option item-select-clear${!value ? ' is-selected' : ''}`}
            onMouseDown={() => select('', '')}
          >
            {placeholder}
          </div>

          {/* Sentinel options (<Tier>, <Catalyst>, <Crafted>) */}
          {sentinels.length > 0 && (
            <div className="item-select-group">
              <div className="item-select-group-label">Special</div>
              {sentinels.map(s => (
                <div
                  key={s.value}
                  className={`item-select-option item-select-sentinel${value === s.value ? ' is-selected' : ''}`}
                  onMouseDown={() => select(s.value, s.value)}
                >
                  {s.label}
                  <OptionBadges
                    name={s.value}
                    defaultValue={defaultValue}
                    approvedValue={approvedValue}
                    pendingValue={pendingValue}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Items grouped by difficulty */}
          {grouped.map(({ diff, items }) => (
            <div key={diff} className="item-select-group">
              <div className="item-select-group-label">{diff}</div>
              {items.map(item => {
                const id         = String(item.itemId ?? '').replace(/^=/, '').trim();
                const isSelected = value === item.name;
                return (
                  <div
                    key={item.itemId}
                    className={`item-select-option${isSelected ? ' is-selected' : ''}`}
                    onMouseDown={() => select(item.name, item.itemId)}
                  >
                    {id ? (
                      /* Wowhead tooltip attaches to this <a> via mouseenter.
                         preventDefault stops navigation; click bubbles to the
                         outer div's onMouseDown which handles selection. */
                      <a
                        href={`https://www.wowhead.com/item=${id}`}
                        className="item-select-item-link"
                        onClick={e => e.preventDefault()}
                      >
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                    <OptionBadges
                      name={item.name}
                      defaultValue={defaultValue}
                      approvedValue={approvedValue}
                      pendingValue={pendingValue}
                    />
                  </div>
                );
              })}
            </div>
          ))}

          {!hasItems && (
            <div className="item-select-empty">No items in Item DB for this slot</div>
          )}
        </div>
      )}
    </div>
  );
}
