/**
 * ItemLink — renders a Wowhead tooltip link for a given item name + ID.
 * Sentinels (<Tier>, <Catalyst>, <Crafted>) and items without a numeric ID
 * render as plain text. Wowhead's power.js picks up the links automatically;
 * call window.$WowheadPower?.refreshLinks() after dynamic renders.
 */

const SENTINELS = new Set(['<Tier>', '<Catalyst>', '<Crafted>']);

export default function ItemLink({ name, itemId, className }) {
  if (!name || SENTINELS.has(name)) {
    return <span className={className}>{name || '—'}</span>;
  }

  // Item IDs may come back as numbers, numeric strings, or formula strings (=12345)
  const id = String(itemId ?? '').replace(/^=/, '').trim();
  if (!id || !/^\d+$/.test(id)) {
    return <span className={className}>{name}</span>;
  }

  return (
    <a
      href={`https://www.wowhead.com/item=${id}`}
      data-wowhead={`item=${id}`}
      className={`wh-link${className ? ` ${className}` : ''}`}
    >
      {name}
    </a>
  );
}
