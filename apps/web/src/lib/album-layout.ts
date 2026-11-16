/**
 * Justified rows for the album grid: where to break, and how wide each photo is.
 *
 * Wrapping greedily fills each row before starting the next, so row heights swing
 * between the target and the ceiling. This picks every break at once, minimising
 * the squared distance of each row's height from `target`.
 *
 * Returns two numbers per photo: its width, and the space left after it when it
 * ends a row (-1 otherwise). The trailing space keeps a short row left aligned and
 * stops the next photo from wrapping up into it.
 *
 * Self-contained ES5 on purpose: `albumLayoutScript` inlines this function's source
 * so the server-rendered page is arranged before its first paint.
 */
export function justifyRows(ratios: number[], width: number, gap: number, target: number, max: number) {
  var count = ratios.length;
  var best = [0];
  var from = [0];
  var i: number, j: number, sum: number, height: number, shown: number, cost: number, total: number;
  for (i = 1; i <= count; i++) {
    best[i] = Infinity;
    from[i] = i - 1;
    sum = 0;
    for (j = i - 1; j >= 0; j--) {
      sum += ratios[j];
      height = (width - gap * (i - 1 - j)) / sum;
      // Longer rows only get shorter. A single photo always forms a row.
      if (j < i - 1 && height < target * 0.6) break;
      // The final row keeps the target height instead of stretching to fill.
      shown = Math.min(height, i === count ? target : max);
      cost = (shown - target) / target;
      cost *= cost;
      // A row that cannot fill the width below the ceiling leaves a ragged edge.
      if (i < count && height > max) cost += 4 * (height / max - 1) + 1;
      total = best[j] + cost;
      if (total < best[i]) {
        best[i] = total;
        from[i] = j;
      }
    }
  }
  var placed: number[] = [];
  var used: number, itemWidth: number;
  for (i = count; i > 0; i = j) {
    j = from[i];
    sum = 0;
    for (var k = j; k < i; k++) sum += ratios[k];
    height = Math.min((width - gap * (i - 1 - j)) / sum, i === count ? target : max);
    used = gap * (i - 1 - j);
    for (k = j; k < i; k++) {
      // Rounded down so a row can never outgrow the list and wrap.
      itemWidth = Math.floor(ratios[k] * height * 10) / 10;
      used += itemWidth;
      placed[k * 2] = itemWidth;
      placed[k * 2 + 1] = -1;
    }
    placed[i * 2 - 1] = Math.max(0, Math.floor((width - 0.5 - used) * 10) / 10);
  }
  return placed;
}

export type AlbumGridMetrics = { width: number; gap: number; target: number; max: number };

/** The list's own CSS decides the numbers; null while it is not a wrapping row layout (phones). */
export function readAlbumGridMetrics(list: HTMLElement): AlbumGridMetrics | null {
  const style = getComputedStyle(list);
  const width = list.getBoundingClientRect().width;
  const target = parseFloat(style.getPropertyValue("--album-row-target"));
  const max = parseFloat(style.getPropertyValue("--album-row-max"));
  if (style.display !== "flex" || !width || !target || !max) return null;
  return { width, gap: parseFloat(style.columnGap) || 0, target, max };
}

/**
 * Arranges the server-rendered list that precedes the script, before React hydrates.
 * A streamed page is parsed inside a hidden container, so it waits for a width.
 */
export const albumLayoutScript = `(function(){var l=document.currentScript.previousElementSibling,n=0,f=${justifyRows.toString()};
function go(){if(!l||l.hasAttribute("data-arranged"))return;var w=l.getBoundingClientRect().width;
if(!w){if(n++<900)requestAnimationFrame(go);return}
var s=getComputedStyle(l),t=parseFloat(s.getPropertyValue("--album-row-target")),m=parseFloat(s.getPropertyValue("--album-row-max"));
if(s.display!=="flex"||!t||!m)return;
var c=l.children,r=[],i;for(i=0;i<c.length;i++)r.push(parseFloat(c[i].style.getPropertyValue("--album-photo-ratio"))||.8);
var p=f(r,w,parseFloat(s.columnGap)||0,t,m);
for(i=0;i<c.length;i++){c[i].style.setProperty("--album-photo-grow","0");c[i].style.setProperty("--album-photo-width",p[i*2]+"px");
c[i].style.setProperty("--album-photo-end",(p[i*2+1]<0?0:p[i*2+1])+"px")}}
go()})()`;
