// See docs/film-scan-color-science.md for sources, assumptions and calibration limits.
const DEFAULT_FILM_BASE = Object.freeze([0.82, 0.61, 0.39]);
// Generic straight-line approximation, NOT a measured Kodak/Fujifilm profile.
const NEGATIVE_GAMMA = 0.6;
const EXPOSURE_SCALE = 0.02;
const TRANSMISSION_FLOOR = 1e-8;
function srgbToLinear(value) {
  const v = Math.max(0, Math.min(1, Number(value)));
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v) {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}
function normalizeFilmBase(mask) {
  return DEFAULT_FILM_BASE.map((fallback, i) =>
    Math.max(1 / 65535, Math.min(1, Number.isFinite(Number(mask?.[i])) ? Number(mask[i]) : fallback))
  );
}
function negativeChannel(value, base) {
  const ratio = Math.max(1, srgbToLinear(base) / Math.max(TRANSMISSION_FLOOR, srgbToLinear(value)));
  // Dnet = log10(Tbase/T). Invert the straight-line D/logH slope,
  // subtract the base exposure floor, then encode display RGB explicitly.
  const exposure = EXPOSURE_SCALE * Math.expm1(Math.log(ratio) / NEGATIVE_GAMMA);
  return linearToSrgb(exposure / (1 + exposure));
}
function buildNegativeDensityFilter(maskRgb) {
  const mask = normalizeFilmBase(maskRgb).map(srgbToLinear);
  const expression = (base, channel) => [
    'st(0,' + channel + '(X,Y)/65535)',
    'st(1,if(lte(ld(0),0.04045),ld(0)/12.92,pow((ld(0)+0.055)/1.055,2.4)))',
    'st(2,' + EXPOSURE_SCALE + '*(pow(max(1,' + base.toPrecision(15) + '/max(ld(1),' + TRANSMISSION_FLOOR + ')),' + (1 / NEGATIVE_GAMMA).toPrecision(15) + ')-1))',
    'st(3,ld(2)/(1+ld(2)))',
    '65535*if(lte(ld(3),0.0031308),12.92*ld(3),1.055*pow(ld(3),1/2.4)-0.055)'
  ].join(';');
  // geq negotiates integer planar RGB; explicitly encode/decode its 16-bit
  // samples instead of relying on an implicit float -> integer conversion.
  return [
    'format=gbrp16le',
    ['r', 'g', 'b'].map((channel, i) => channel + "='" + expression(mask[i], channel) + "'").join(':').replace(/^/, 'geq=') + ':interpolation=nearest',
    'setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr:range=full'
  ].join(',');
}
module.exports = { DEFAULT_FILM_BASE, NEGATIVE_GAMMA, srgbToLinear, linearToSrgb, normalizeFilmBase, negativeChannel, buildNegativeDensityFilter };
