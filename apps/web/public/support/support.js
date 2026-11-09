// Leaving the guide. Reading it never adds history entries, so the browser's
// Back, the header's back link and any link to the page the reader came from
// all return in one step, to the place they left.
(() => {
  // The site's sections, as the main navigation names them.
  const SECTIONS = [["/videos", "视频"], ["/upload", "视频"], ["/posts", "文章"], ["/write", "文章"],
    ["/albums", "相簿"], ["/project", "实验室"], ["/about", "关于"]];
  let from = null;
  try { from = document.referrer ? new URL(document.referrer) : null; } catch { /* Unreadable referrer: no way back. */ }
  // A page opened in a new tab has no entry to return to, only a referrer.
  if (!from || from.origin !== location.origin || from.pathname === location.pathname || history.length < 2) from = null;

  const back = document.querySelector(".site-header .back");
  // Home is already the breadcrumb's first step, which then returns instead.
  if (from && back && from.pathname !== "/") {
    const section = SECTIONS.find(([path]) => from.pathname === path || from.pathname.startsWith(`${path}/`));
    back.lastElementChild.textContent = section ? `返回${section[1]}` : "返回上一页";
    back.href = from.href;
    back.hidden = false;
  }

  const modified = event => event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  document.addEventListener("click", event => {
    if (modified(event)) return;
    const link = event.target.closest("a[href]");
    if (!link) return;
    // The route map's stations are SVG links, whose href is not a string.
    const target = new URL(link.getAttribute("href"), location.href);
    if (target.origin !== location.origin) return;

    if (target.pathname === location.pathname && target.hash) {
      // Stops ride the route map (below); every other anchor on the page
      // scrolls in place and replaces the entry instead of pushing one.
      const section = document.getElementById(decodeURIComponent(target.hash.slice(1)));
      if (!section || section.classList.contains("stage")) return;
      event.preventDefault();
      history.replaceState(history.state, "", target.hash);
      if (!section.hasAttribute("tabindex")) section.setAttribute("tabindex", "-1");
      section.focus({ preventScroll: true });
      section.scrollIntoView({ block: "start" });
      return;
    }
    if (from && target.pathname + target.search === from.pathname + from.search) {
      event.preventDefault();
      history.back();
    }
  });
})();

// Native document scrolling owns navigation. The route map only follows it: no
// wheel/touch interception, animation library, media decoding or backend calls.
(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const journey = document.querySelector(".journey");
  const stopsSection = document.querySelector(".stops");
  const stages = [...stopsSection.querySelectorAll(".stage")];
  const map = document.querySelector(".network");
  const readout = document.querySelector(".readout");
  if (!journey || !map || !readout || stages.length !== 12) return;

  const stations = [...map.querySelectorAll(".station")].sort((a, b) => a.dataset.i - b.dataset.i);
  const spans = [...map.querySelectorAll("[data-k]")].map(element => ({ element, k: Number(element.dataset.k) }));
  const zoneLabels = [...map.querySelectorAll(".zone-label")];
  const termLabel = map.querySelector(".term-lbl");
  const ring = map.querySelector(".ring");
  const marker = map.querySelector(".marker");
  const trail = map.querySelector(".trail");
  const field = name => readout.querySelector(`[data-readout="${name}"]`);
  const sign = field("sign");
  const nameField = field("name");
  const whereField = field("where");
  const countField = field("count");
  const nextField = field("next");
  const previous = document.getElementById("previous");
  const next = document.getElementById("next");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const stripLayout = matchMedia("(max-width: 860px), (max-height: 560px)");

  // Seat coordinates in ride order, the track each leg rides to the next stop,
  // and the interchange hubs: a pill lights once its first seat is reached.
  const seats = [[90, 100], [220, 100], [220, 128], [360, 100], [360, 128], [360, 170],
    [360, 308], [80, 400], [52, 400], [230, 528], [380, 528], [380, 500]];
  const legs = ["M90 100H220", "M220 100V128", "M220 128H360V100", "M360 100V128", "M360 128V170",
    // C6 is a spur trip: the train returns to P3 and rides the main loop to P4.
    "M360 170V100H500A58 58 0 0 1 558 158V250A58 58 0 0 1 500 308H360", "M360 308H110A30 30 0 0 0 80 338V400", "M80 400H52",
    "M52 400V470A58 58 0 0 0 110 528H230", "M230 528H380", "M380 528V500", "M380 500H500"];
  const hubs = { I1: 1, I2: 3, I3: 7, I4: 10 };
  const pills = [...map.querySelectorAll(".pill")].map(element => ({ element, from: hubs[element.dataset.hub] }));
  // Legs that only change line inside an interchange: the pill marks the crossing.
  const transfers = { 1: "I1", 3: "I2", 7: "I3", 10: "I4" };
  // Leg geometry lives in <defs>: measurable in every engine, never painted.
  const defs = document.createElementNS(SVG, "defs");
  map.prepend(defs);
  const legPaths = legs.map(d => {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    defs.append(path);
    return path;
  });
  const legLengths = legPaths.map(path => path.getTotalLength());
  const HOLD = .5; // The train waits at a stop for the first half of its chapter.

  const ticks = readout.querySelector(".ticks");
  const tickItems = stages.map(stage => {
    const tick = document.createElement("li");
    tick.dataset.line = stage.dataset.line;
    return ticks.appendChild(tick);
  });

  let current = -1;
  let lit = -1;
  let starts = [];
  let finish = 0;
  let readingLine = 200;
  let frame = 0;

  const clamp = value => Math.max(0, Math.min(1, value));
  const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const pad = value => String(value).padStart(2, "0");

  function select(index) {
    current = index;
    const stage = stages[index];
    stages.forEach((item, i) => item.toggleAttribute("data-active", i === index));
    stations.forEach((station, i) => {
      station.classList.toggle("is-passed", i <= index);
      station.classList.toggle("is-current", i === index);
      if (i === index) station.setAttribute("aria-current", "location");
      else station.removeAttribute("aria-current");
    });
    pills.forEach(pill => pill.element.classList.toggle("is-on", index >= pill.from));
    const zones = stage.dataset.zone.split(" ");
    zoneLabels.forEach(label => label.classList.toggle("is-here", zones.includes(label.dataset.zone)));
    tickItems.forEach((tick, i) => tick.classList.toggle("is-current", i === index));
    ring.setAttribute("cx", seats[index][0]);
    ring.setAttribute("cy", seats[index][1]);

    sign.textContent = stage.dataset.code;
    sign.className = `sign sign-${stage.dataset.line}`;
    nameField.textContent = stage.dataset.name;
    whereField.textContent = stage.dataset.where;
    countField.textContent = `${pad(index + 1)} / ${stages.length}`;
    const following = stages[index + 1];
    const sameHub = following && stage.dataset.hub && stage.dataset.hub === following.dataset.hub;
    const note = stage.dataset.nextNote || (sameHub ? "同站换乘" : "");
    nextField.textContent = following
      ? [`${following.dataset.code} ${following.dataset.name}`, note].filter(Boolean).join(" · ")
      : note;
    previous.disabled = index === 0;
    next.disabled = index === stages.length - 1;
  }

  function draw(index, travel) {
    const length = legLengths[index];
    const point = legPaths[index].getPointAtLength(travel * length);
    marker.setAttribute("cx", point.x.toFixed(2));
    marker.setAttribute("cy", point.y.toFixed(2));
    if (trail.dataset.leg !== String(index)) {
      trail.dataset.leg = String(index);
      trail.setAttribute("d", legs[index]);
      trail.style.strokeDasharray = `${length} ${length}`;
    }
    trail.style.strokeDashoffset = String(length * (1 - travel));
    trail.style.opacity = travel > 0 ? "1" : "0";
    const crossing = travel > 0 && travel < 1 ? transfers[index] : undefined;
    pills.forEach(pill => pill.element.classList.toggle("is-crossing", pill.element.dataset.hub === crossing));
    // A span lights when the train reaches the stop it leads to; k 13 is the screen.
    const reached = index + 1 + (travel >= .999 ? 1 : 0);
    if (reached !== lit) {
      lit = reached;
      spans.forEach(span => span.element.classList.toggle("is-on", span.k <= reached));
      termLabel.classList.toggle("is-on", reached >= 13);
    }
    tickItems.forEach((tick, i) => tick.style.setProperty("--fill", i < index ? "1" : i === index ? travel.toFixed(3) : "0"));
  }

  function sync() {
    frame = 0;
    const position = scrollY + readingLine + 1;
    let index = 0;
    while (index + 1 < starts.length && starts[index + 1] <= position) index++;
    const end = index + 1 < starts.length ? starts[index + 1] : finish;
    const fraction = clamp((position - starts[index]) / Math.max(1, end - starts[index]));
    const travel = reducedMotion.matches ? 0 : ease(clamp((fraction - HOLD) / (1 - HOLD)));
    if (index !== current) select(index);
    draw(index, travel);
  }

  function schedule() { if (!frame) frame = requestAnimationFrame(sync); }

  function measure() {
    // On narrow windows only the breadcrumb bar stays pinned; the header box steps aside.
    const siteHeader = document.querySelector(".site-header");
    const pinned = getComputedStyle(siteHeader).display === "contents" ? siteHeader.querySelector(".site-bar") : siteHeader;
    const header = pinned.getBoundingClientRect().height;
    readingLine = stripLayout.matches
      ? Math.round(header + readout.getBoundingClientRect().height + 20)
      : Math.round(Math.max(header + 120, innerHeight * .32));
    journey.style.setProperty("--reading-offset", `${readingLine}px`);
    // A pinned map drawn below ~80% scale enlarges its labels (up to 1.25×) so
    // station names stay near 12px on short laptop windows.
    const scale = map.getBoundingClientRect().width / 600;
    if (stripLayout.matches || !scale) map.style.removeProperty("--k");
    else map.style.setProperty("--k", Math.min(1.25, Math.max(1, .8 / scale)).toFixed(3));
    // Cache document offsets on layout changes, never read twelve boxes per
    // scroll frame. Text remains in natural flow, including at zoom.
    starts = stages.map(stage => stage.getBoundingClientRect().top + scrollY);
    finish = stages[stages.length - 1].getBoundingClientRect().bottom + scrollY;
    schedule();
  }

  function jump(index, smooth = true, focus = false) {
    measure();
    const stage = stages[index];
    history.replaceState(history.state, "", `#${stage.id}`);
    if (focus) stage.focus({ preventScroll: true });
    scrollTo({ top: Math.max(0, starts[index] - readingLine), behavior: smooth && !reducedMotion.matches ? "smooth" : "instant" });
    sync();
  }

  // The old two-pipeline anchors open the first stop of their line.
  const legacy = { "#playback": "playback-upload", "#color": "color-contract" };
  function readHash() {
    const id = legacy[location.hash] || decodeURIComponent(location.hash.slice(1));
    const index = stages.findIndex(stage => stage.id === id);
    if (index >= 0) jump(index, false);
  }

  // Station links, transfer links and the station signs in the reference
  // sections all ride to their stop the same way.
  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest("a[href^='#']");
    if (!link) return;
    const index = stages.findIndex(stage => `#${stage.id}` === link.getAttribute("href"));
    if (index < 0) return;
    event.preventDefault();
    jump(index, true, true);
  });
  previous.addEventListener("click", () => jump(Math.max(0, current - 1)));
  next.addEventListener("click", () => jump(Math.min(stages.length - 1, current + 1)));
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", measure);
  addEventListener("hashchange", readHash);
  reducedMotion.addEventListener("change", measure);
  stripLayout.addEventListener("change", measure);
  // The pinned strip sets the reading line on phones, so its size counts too.
  const resize = new ResizeObserver(measure);
  resize.observe(stopsSection);
  resize.observe(readout);

  document.documentElement.classList.add("enhanced");
  readout.hidden = false;
  select(0);
  measure();
  sync();
  readHash();
  // Restore the requested stop after fonts and native fragment scrolling settle.
  document.fonts.ready.then(measure);
  addEventListener("load", readHash, { once: true });
})();
