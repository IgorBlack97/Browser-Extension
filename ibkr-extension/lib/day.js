export function dayPnlFromPct(value, pct) {
  if (typeof value !== "number" || typeof pct !== "number") return null;
  const rate = pct / 100;
  if (!Number.isFinite(rate) || rate <= -0.999) return null;
  return (value * rate) / (1 + rate);
}

export function dayReturn(positions) {
  const tiles = (positions || [])
    .filter((position) => position.assetClass !== "CASH" && position.value > 0)
    .map((position) => {
      const pnl = position.dayPnl != null ? position.dayPnl : dayPnlFromPct(position.value, position.dayChangePct);
      const pct = position.dayChangePct != null
        ? position.dayChangePct
        : (pnl != null && position.value !== pnl ? (pnl / (position.value - pnl)) * 100 : null);
      return {
        ticker: position.ticker,
        name: position.name,
        value: position.value,
        pnl,
        pct,
      };
    })
    .sort((a, b) => b.value - a.value);
  const known = tiles.filter((tile) => tile.pnl != null);
  const dayPnl = known.reduce((sum, tile) => sum + tile.pnl, 0);
  const covered = known.reduce((sum, tile) => sum + tile.value, 0);
  const dayPct = covered && covered !== dayPnl ? (dayPnl / (covered - dayPnl)) * 100 : null;
  return {
    dayPnl: known.length ? dayPnl : null,
    dayPct,
    tiles,
    missing: tiles.filter((tile) => tile.pct == null).map((tile) => tile.ticker),
  };
}

function worst(row, length, total, area) {
  const sum = row.reduce((itemSum, item) => itemSum + item.value, 0);
  const rowArea = (sum / total) * area;
  const thickness = rowArea / length;
  if (!thickness) return Infinity;
  let score = 0;
  for (const item of row) {
    const edge = ((item.value / sum) * rowArea) / thickness;
    score = Math.max(score, Math.max(thickness, edge) / Math.min(thickness, edge));
  }
  return score;
}

function squarify(items, x, y, w, h, rects) {
  if (!items.length || w <= 0 || h <= 0) return;
  if (items.length === 1) {
    rects.push({ ...items[0], x, y, w, h });
    return;
  }
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const vertical = w < h;
  const length = vertical ? w : h;
  let row = [items[0]];
  for (let index = 1; index < items.length; index += 1) {
    const next = [...row, items[index]];
    if (worst(next, length, total, w * h) > worst(row, length, total, w * h)) break;
    row = next;
  }
  const rowSum = row.reduce((sum, item) => sum + item.value, 0);
  const thickness = (rowSum / total) * (vertical ? h : w);
  let offset = 0;
  for (const item of row) {
    const extent = (item.value / rowSum) * (vertical ? w : h);
    if (vertical) rects.push({ ...item, x: x + offset, y, w: extent, h: thickness });
    else rects.push({ ...item, x, y: y + offset, w: thickness, h: extent });
    offset += extent;
  }
  const rest = items.slice(row.length);
  if (vertical) squarify(rest, x, y + thickness, w, h - thickness, rects);
  else squarify(rest, x + thickness, y, w - thickness, h, rects);
}

export function layoutTreemap(items, width, height) {
  const data = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const rects = [];
  squarify(data, 0, 0, width, height, rects);
  return rects;
}
