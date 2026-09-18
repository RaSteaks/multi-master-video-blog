export type LiquidVariant = "accent" | "teal" | "blue" | "gray";

export type LiquidRgb = readonly [number, number, number];

export type LiquidPalette = readonly [
  LiquidRgb,
  LiquidRgb,
  LiquidRgb,
];

export type LiquidFluidController = {
  update(input: { speed: number; palette: LiquidPalette }): void;
  dispose(): void;
};

export const FLUID_TARGET_FPS = 30;
export const FLUID_DESKTOP_SIZE = 64;
export const FLUID_MOBILE_SIZE = 48;

const MAX_RENDER_PIXELS = 1_400_000;

/**
 * Keep the simulation texture square and fixed-size so GPU memory and shader
 * work are predictable on every viewport shape.
 */
export function fluidGridSize(
  _viewportWidth: number,
  _viewportHeight: number,
  shortSide: number,
) {
  const size =
    Number.isFinite(shortSide) && shortSide > 0
      ? Math.max(1, Math.round(shortSide))
      : 1;
  return { width: size, height: size };
}

const VARIANT_SEEDS: Record<LiquidVariant, number> = {
  accent: 0.37,
  teal: 2.13,
  blue: 4.71,
  gray: 7.29,
};

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const VELOCITY_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
uniform float u_dt;
uniform float u_time;
uniform float u_seed;
uniform float u_aspect;
uniform float u_noiseScale;
uniform float u_noiseStrength;
uniform float u_damping;

in vec2 v_uv;
out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec2 gradientAt(vec2 cell) {
  float angle = hash21(cell) * 6.28318530718;
  return vec2(cos(angle), sin(angle));
}

float gradientNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 smoothLocal = local * local * (3.0 - 2.0 * local);

  float bottomLeft = dot(gradientAt(cell), local);
  float bottomRight = dot(gradientAt(cell + vec2(1.0, 0.0)), local - vec2(1.0, 0.0));
  float topLeft = dot(gradientAt(cell + vec2(0.0, 1.0)), local - vec2(0.0, 1.0));
  float topRight = dot(gradientAt(cell + vec2(1.0, 1.0)), local - vec2(1.0, 1.0));

  float bottom = mix(bottomLeft, bottomRight, smoothLocal.x);
  float top = mix(topLeft, topRight, smoothLocal.x);
  return mix(bottom, top, smoothLocal.y);
}

float fieldNoise(vec2 p) {
  vec2 timeDrift = vec2(u_time * 0.035, -u_time * 0.025);
  return gradientNoise(p + timeDrift + vec2(u_seed, u_seed * 1.37));
}

vec2 curlNoise(vec2 p) {
  float epsilon = 0.035;
  float left = fieldNoise(p - vec2(epsilon, 0.0));
  float right = fieldNoise(p + vec2(epsilon, 0.0));
  float bottom = fieldNoise(p - vec2(0.0, epsilon));
  float top = fieldNoise(p + vec2(0.0, epsilon));
  float dx = (right - left) / (2.0 * epsilon);
  float dy = (top - bottom) / (2.0 * epsilon);
  return vec2(dy, -dx);
}

void main() {
  vec2 velocity = texture(u_velocity, v_uv).xy;
  vec2 backtrace = clamp(v_uv - velocity * u_dt, u_texelSize * 0.5, 1.0 - u_texelSize * 0.5);
  velocity = texture(u_velocity, backtrace).xy;

  vec2 noisePosition = v_uv * vec2(u_aspect, 1.0) * u_noiseScale;
  // Convert the aspect-correct curl back to UV velocity units.
  velocity += curlNoise(noisePosition) / vec2(u_aspect, 1.0) * u_noiseStrength * u_dt;
  velocity *= exp(-u_damping * u_dt);

  outColor = vec4(velocity, 0.0, 1.0);
}
`;

const DIVERGENCE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform vec2 u_texelSize;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 offsetX = vec2(u_texelSize.x, 0.0);
  vec2 offsetY = vec2(0.0, u_texelSize.y);
  float left = texture(u_velocity, v_uv - offsetX).x;
  float right = texture(u_velocity, v_uv + offsetX).x;
  float bottom = texture(u_velocity, v_uv - offsetY).y;
  float top = texture(u_velocity, v_uv + offsetY).y;
  float divergence =
    0.5 * ((right - left) / u_texelSize.x + (top - bottom) / u_texelSize.y);
  outColor = vec4(divergence, 0.0, 0.0, 1.0);
}
`;

const PRESSURE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_pressure;
uniform sampler2D u_divergence;
uniform vec2 u_texelSize;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 offsetX = vec2(u_texelSize.x, 0.0);
  vec2 offsetY = vec2(0.0, u_texelSize.y);
  float left = texture(u_pressure, v_uv - offsetX).x;
  float right = texture(u_pressure, v_uv + offsetX).x;
  float bottom = texture(u_pressure, v_uv - offsetY).x;
  float top = texture(u_pressure, v_uv + offsetY).x;
  float divergence = texture(u_divergence, v_uv).x;
  // Divergence and projection use UV derivatives; include grid spacing here.
  vec2 inverseSpacingSquared = 1.0 / (u_texelSize * u_texelSize);
  float pressure = (
    (left + right) * inverseSpacingSquared.x +
    (bottom + top) * inverseSpacingSquared.y - divergence
  ) / (2.0 * (inverseSpacingSquared.x + inverseSpacingSquared.y));
  outColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

const PROJECT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform sampler2D u_pressure;
uniform vec2 u_texelSize;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 offsetX = vec2(u_texelSize.x, 0.0);
  vec2 offsetY = vec2(0.0, u_texelSize.y);
  float left = texture(u_pressure, v_uv - offsetX).x;
  float right = texture(u_pressure, v_uv + offsetX).x;
  float bottom = texture(u_pressure, v_uv - offsetY).x;
  float top = texture(u_pressure, v_uv + offsetY).x;
  vec2 pressureGradient =
    vec2(right - left, top - bottom) / (2.0 * u_texelSize);

  vec2 velocity = texture(u_velocity, v_uv).xy - pressureGradient;
  outColor = vec4(velocity, 0.0, 1.0);
}
`;

const DYE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_dye;
uniform sampler2D u_velocity;
uniform vec2 u_texelSize;
uniform float u_dt;
uniform float u_initialize;
uniform float u_time;
uniform float u_seed;
uniform float u_aspect;
uniform vec3 u_color1;
uniform vec3 u_color2;
uniform vec3 u_color3;

in vec2 v_uv;
out vec4 outColor;

float source(vec2 position, vec2 center, float radius) {
  vec2 delta = (position - center) * vec2(u_aspect, 1.0);
  return exp(-dot(delta, delta) / (radius * radius));
}

void main() {
  vec2 velocity = texture(u_velocity, v_uv).xy;
  vec2 backtrace = clamp(v_uv - velocity * u_dt, u_texelSize * 0.5, 1.0 - u_texelSize * 0.5);
  vec4 dye = texture(u_dye, backtrace);
  if (u_initialize > 0.5) dye = vec4(0.0);
  dye *= exp(-0.24 * u_dt);

  vec2 center1 = vec2(
    0.16 + sin(u_time * 0.12 + u_seed) * 0.035,
    0.76 + cos(u_time * 0.10 + u_seed) * 0.050
  );
  vec2 center2 = vec2(
    0.86 + cos(u_time * 0.09 + u_seed * 1.4) * 0.040,
    0.44 + sin(u_time * 0.11 + u_seed * 0.8) * 0.070
  );
  vec2 center3 = vec2(
    0.42 + sin(u_time * 0.08 + u_seed * 0.6) * 0.060,
    0.13 + cos(u_time * 0.10 + u_seed * 1.8) * 0.035
  );
  vec2 center4 = vec2(
    0.72 + sin(u_time * 0.11 + u_seed * 1.9) * 0.045,
    0.87 + cos(u_time * 0.07 + u_seed * 0.7) * 0.040
  );
  vec2 center5 = vec2(
    0.13 + cos(u_time * 0.08 + u_seed * 2.3) * 0.035,
    0.34 + sin(u_time * 0.13 + u_seed * 1.2) * 0.055
  );
  vec2 center6 = vec2(
    0.87 + sin(u_time * 0.07 + u_seed * 0.9) * 0.040,
    0.12 + cos(u_time * 0.12 + u_seed * 2.1) * 0.035
  );

  // Six smaller sources share roughly the former dye budget. Portrait screens
  // use smaller radii so the extra sources do not fill the black gaps.
  float radiusScale = sqrt(min(u_aspect, 1.0));
  float injection = (u_initialize > 0.5 ? 0.24 : u_dt * 0.078) * 0.85;
  float amount1 = source(v_uv, center1, 0.25 * radiusScale) * injection;
  float amount2 = source(v_uv, center2, 0.24 * radiusScale) * injection * 0.85;
  float amount3 = source(v_uv, center3, 0.23 * radiusScale) * injection * 0.77;
  float amount4 = source(v_uv, center4, 0.23 * radiusScale) * injection * 0.85;
  float amount5 = source(v_uv, center5, 0.22 * radiusScale) * injection * 0.77;
  float amount6 = source(v_uv, center6, 0.20 * radiusScale) * injection * 0.90;
  dye.rgb += u_color1 * (amount1 + amount6) +
    u_color2 * (amount2 + amount4) + u_color3 * (amount3 + amount5);
  dye.a += amount1 + amount2 + amount3 + amount4 + amount5 + amount6;

  dye.rgb = min(dye.rgb, vec3(1.0));
  dye.a = min(dye.a, 1.0);
  outColor = dye;
}
`;

const RENDER_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_dye;
uniform vec2 u_dyeTexelSize;

in vec2 v_uv;
out vec4 outColor;

void main() {
  vec2 x = vec2(u_dyeTexelSize.x, 0.0);
  vec2 y = vec2(0.0, u_dyeTexelSize.y);
  vec4 dye =
    texture(u_dye, v_uv) * 0.42 +
    texture(u_dye, v_uv + x) * 0.14 +
    texture(u_dye, v_uv - x) * 0.14 +
    texture(u_dye, v_uv + y) * 0.15 +
    texture(u_dye, v_uv - y) * 0.15;

  float density = clamp(dye.a, 0.0, 1.0);
  if (density < 0.001) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  vec3 color = dye.rgb / max(density, 0.0001);
  // Keep diffuse trails visible without hardening their edges.
  float alpha = (1.0 - exp(-3.0 * density)) * 0.48;
  // Composite over pure black here, avoiding a second browser alpha/blur pass.
  outColor = vec4(color * alpha, 1.0);
}
`;

type ShaderProgram = {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
};

type FluidTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
};

type ProgramName =
  | "velocity"
  | "divergence"
  | "pressure"
  | "project"
  | "dye"
  | "render";

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader error.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  fragmentSource: string,
  uniformNames: string[],
): ShaderProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    fragmentSource,
  );
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Unable to allocate WebGL program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown program error.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return {
    program,
    uniforms: new Map(
      uniformNames.map((name) => [name, gl.getUniformLocation(program, name)]),
    ),
  };
}

function destroyTarget(gl: WebGL2RenderingContext, target: FluidTarget) {
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

function bindTexture(
  gl: WebGL2RenderingContext,
  uniforms: Map<string, WebGLUniformLocation | null>,
  name: string,
  texture: WebGLTexture,
  unit: number,
) {
  const location = uniforms.get(name);
  if (!location) return;
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(location, unit);
}

function setFloat(
  gl: WebGL2RenderingContext,
  uniforms: Map<string, WebGLUniformLocation | null>,
  name: string,
  value: number,
) {
  const location = uniforms.get(name);
  if (location) gl.uniform1f(location, value);
}

function setVec2(
  gl: WebGL2RenderingContext,
  uniforms: Map<string, WebGLUniformLocation | null>,
  name: string,
  x: number,
  y: number,
) {
  const location = uniforms.get(name);
  if (location) gl.uniform2f(location, x, y);
}

function setVec3(
  gl: WebGL2RenderingContext,
  uniforms: Map<string, WebGLUniformLocation | null>,
  name: string,
  value: LiquidRgb,
) {
  const location = uniforms.get(name);
  if (location) gl.uniform3f(location, value[0], value[1], value[2]);
}

class LowResolutionLiquidRenderer implements LiquidFluidController {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly seed: number;
  private readonly baseSize: number;
  private readonly onContextLost?: () => void;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadBuffer: WebGLBuffer;
  private readonly programs: Partial<Record<ProgramName, ShaderProgram>> = {};
  private targets: FluidTarget[] = [];
  private velocityRead!: FluidTarget;
  private velocityWrite!: FluidTarget;
  private pressureRead!: FluidTarget;
  private pressureWrite!: FluidTarget;
  private dyeRead!: FluidTarget;
  private dyeWrite!: FluidTarget;
  private divergence!: FluidTarget;
  private palette: LiquidPalette;
  private speed: number;
  private simWidth = 0;
  private simHeight = 0;
  private renderWidth = 0;
  private renderHeight = 0;
  private simTime = 0;
  private lastNow = 0;
  private lastFrameAt = 0;
  private animationFrame = 0;
  private disposed = false;
  private visible = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    input: {
      variant: LiquidVariant;
      palette: LiquidPalette;
      speed: number;
      onContextLost?: () => void;
    },
  ) {
    this.canvas = canvas;
    this.seed = VARIANT_SEEDS[input.variant];
    this.palette = input.palette;
    this.speed = Number.isFinite(input.speed)
      ? Math.min(3, Math.max(0, input.speed))
      : 1;
    this.onContextLost = input.onContextLost;
    this.baseSize =
      window.matchMedia("(pointer: coarse)").matches ||
      Math.min(window.innerWidth, window.innerHeight) < 600
        ? FLUID_MOBILE_SIZE
        : FLUID_DESKTOP_SIZE;

    const context = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!context) throw new Error("WebGL2 is unavailable.");
    if (!context.getExtension("EXT_color_buffer_float")) {
      throw new Error("Floating point framebuffers are unavailable.");
    }
    // RGBA16F linear filtering is core WebGL2. The optional extension is
    // needed for 32-bit float textures, which this renderer does not use.
    this.gl = context;

    const vao = context.createVertexArray();
    const quadBuffer = context.createBuffer();
    if (!vao || !quadBuffer) {
      if (vao) context.deleteVertexArray(vao);
      if (quadBuffer) context.deleteBuffer(quadBuffer);
      throw new Error("Unable to allocate WebGL geometry.");
    }
    this.vao = vao;
    this.quadBuffer = quadBuffer;
    try {
      context.bindVertexArray(vao);
    context.bindBuffer(context.ARRAY_BUFFER, quadBuffer);
    context.bufferData(
      context.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      context.STATIC_DRAW,
    );
    context.enableVertexAttribArray(0);
    context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);
    context.bindVertexArray(null);
    context.disable(context.DEPTH_TEST);
    context.disable(context.CULL_FACE);
    context.disable(context.BLEND);

    this.programs.velocity = createProgram(context, VELOCITY_FRAGMENT_SHADER, [
      "u_velocity",
      "u_texelSize",
      "u_dt",
      "u_time",
      "u_seed",
      "u_aspect",
      "u_noiseScale",
      "u_noiseStrength",
      "u_damping",
    ]);
    this.programs.divergence = createProgram(
      context,
      DIVERGENCE_FRAGMENT_SHADER,
      ["u_velocity", "u_texelSize"],
    );
    this.programs.pressure = createProgram(
      context,
      PRESSURE_FRAGMENT_SHADER,
      ["u_pressure", "u_divergence", "u_texelSize"],
    );
    this.programs.project = createProgram(context, PROJECT_FRAGMENT_SHADER, [
      "u_velocity",
      "u_pressure",
      "u_texelSize",
    ]);
    this.programs.dye = createProgram(context, DYE_FRAGMENT_SHADER, [
      "u_dye",
      "u_velocity",
      "u_texelSize",
      "u_dt",
      "u_initialize",
      "u_time",
      "u_seed",
      "u_aspect",
      "u_color1",
      "u_color2",
      "u_color3",
    ]);
    this.programs.render = createProgram(context, RENDER_FRAGMENT_SHADER, [
      "u_dye",
      "u_dyeTexelSize",
    ]);

    this.resize();
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
    this.resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => this.resize())
        : null;
    this.resizeObserver?.observe(this.canvas);
    this.intersectionObserver =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) =>
            this.setVisible(Boolean(entry?.isIntersecting)),
          )
        : null;
    this.intersectionObserver?.observe(this.canvas);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("resize", this.handleWindowResize, {
      passive: true,
    });
      this.start();
    } catch (error) {
      this.stop();
      this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
      window.removeEventListener("resize", this.handleWindowResize);
      this.resizeObserver?.disconnect();
      this.intersectionObserver?.disconnect();
      this.disposeResources();
      throw error;
    }
  }

  update(input: { speed: number; palette: LiquidPalette }) {
    if (this.disposed) return;
    const paletteChanged = this.palette.some((color, i) =>
      color.some((channel, j) => channel !== input.palette[i][j]),
    );
    this.palette = input.palette;
    this.speed = Math.min(3, Math.max(0, Number.isFinite(input.speed) ? input.speed : 1));
    // Replace old dye immediately, including while running or switching to black.
    if (paletteChanged) {
      this.updateDye(0, true);
      this.render();
    }
    if (this.speed === 0) {
      this.stop();
      this.render();
    }
    else this.start();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("resize", this.handleWindowResize);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.disposeResources();
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.stop();
    this.onContextLost?.();
  };

  private readonly handleVisibilityChange = () => {
    if (document.hidden) this.stop();
    else this.start();
  };

  private readonly handleWindowResize = () => this.resize();

  private setVisible(value: boolean) {
    this.visible = value;
    if (value) this.start();
    else this.stop();
  }

  private start() {
    if (
      this.disposed ||
      this.speed === 0 ||
      document.hidden ||
      !this.visible ||
      this.animationFrame
    ) {
      return;
    }
    this.lastNow = performance.now();
    this.lastFrameAt = this.lastNow;
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  private stop() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    this.lastNow = 0;
    this.lastFrameAt = 0;
  }

  private readonly tick = (now: number) => {
    this.animationFrame = 0;
    if (
      this.disposed ||
      this.speed === 0 ||
      document.hidden ||
      !this.visible
    ) {
      return;
    }

    const frameInterval = 1000 / FLUID_TARGET_FPS;
    if (this.lastFrameAt && now - this.lastFrameAt < frameInterval) {
      this.animationFrame = requestAnimationFrame(this.tick);
      return;
    }

    const elapsed = this.lastNow
      ? Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000))
      : 1 / FLUID_TARGET_FPS;
    this.lastNow = now;
    // Preserve fractional time so rounding at 60 Hz does not reduce us to 20 FPS.
    this.lastFrameAt = now - ((now - this.lastFrameAt) % frameInterval);
    // elapsed already caps a delayed frame; scale the full step so 3x remains 3x.
    const dt = elapsed * this.speed;
    this.simTime += dt;
    this.step(dt);
    this.render();
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private resize() {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || window.innerWidth || 1);
    const cssHeight = Math.max(1, rect.height || window.innerHeight || 1);
    const renderScale = Math.min(
      1,
      Math.sqrt(MAX_RENDER_PIXELS / (cssWidth * cssHeight)),
    );
    const renderWidth = Math.max(1, Math.round(cssWidth * renderScale));
    const renderHeight = Math.max(1, Math.round(cssHeight * renderScale));
    const simulation = fluidGridSize(cssWidth, cssHeight, this.baseSize);

    if (
      renderWidth === this.renderWidth &&
      renderHeight === this.renderHeight &&
      simulation.width === this.simWidth &&
      simulation.height === this.simHeight
    ) {
      return;
    }

    this.renderWidth = renderWidth;
    this.renderHeight = renderHeight;
    this.simWidth = simulation.width;
    this.simHeight = simulation.height;
    this.canvas.width = renderWidth;
    this.canvas.height = renderHeight;
    this.allocateTargets();
    // Saved zero speed still needs a visible initial frame after mount/resize.
    this.updateDye(0, true);
    this.render();
  }

  private allocateTargets() {
    for (const target of this.targets) destroyTarget(this.gl, target);
    this.targets = [];
    const create = () => {
      const target = this.createTarget(this.simWidth, this.simHeight);
      this.targets.push(target);
      return target;
    };
    this.velocityRead = create();
    this.velocityWrite = create();
    this.pressureRead = create();
    this.pressureWrite = create();
    this.dyeRead = create();
    this.dyeWrite = create();
    this.divergence = create();
    for (const target of this.targets) this.clearTarget(target);
  }

  private createTarget(width: number, height: number): FluidTarget {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      throw new Error("Unable to allocate a fluid target.");
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error("Fluid framebuffer is incomplete.");
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { texture, framebuffer, width, height };
  }

  private clearTarget(target: FluidTarget) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private step(dt: number) {
    const gl = this.gl;
    const texelX = 1 / this.simWidth;
    const texelY = 1 / this.simHeight;
    const aspect = this.renderWidth / this.renderHeight;

    gl.disable(gl.BLEND);
    const velocityProgram = this.programs.velocity!;
    this.drawTo(this.velocityWrite, velocityProgram, (uniforms) => {
      bindTexture(gl, uniforms, "u_velocity", this.velocityRead.texture, 0);
      setVec2(gl, uniforms, "u_texelSize", texelX, texelY);
      setFloat(gl, uniforms, "u_dt", dt);
      setFloat(gl, uniforms, "u_time", this.simTime);
      setFloat(gl, uniforms, "u_seed", this.seed);
      setFloat(gl, uniforms, "u_aspect", aspect);
      setFloat(gl, uniforms, "u_noiseScale", 1.35);
      setFloat(gl, uniforms, "u_noiseStrength", 0.055);
      setFloat(gl, uniforms, "u_damping", 0.65);
    });
    [this.velocityRead, this.velocityWrite] = [
      this.velocityWrite,
      this.velocityRead,
    ];

    const divergenceProgram = this.programs.divergence!;
    this.drawTo(this.divergence, divergenceProgram, (uniforms) => {
      bindTexture(gl, uniforms, "u_velocity", this.velocityRead.texture, 0);
      setVec2(gl, uniforms, "u_texelSize", texelX, texelY);
    });

    const pressureProgram = this.programs.pressure!;
    const pressureIterations = this.baseSize === FLUID_MOBILE_SIZE ? 4 : 6;
    for (let i = 0; i < pressureIterations; i += 1) {
      this.drawTo(this.pressureWrite, pressureProgram, (uniforms) => {
        bindTexture(gl, uniforms, "u_pressure", this.pressureRead.texture, 0);
        bindTexture(gl, uniforms, "u_divergence", this.divergence.texture, 1);
        setVec2(gl, uniforms, "u_texelSize", texelX, texelY);
      });
      [this.pressureRead, this.pressureWrite] = [
        this.pressureWrite,
        this.pressureRead,
      ];
    }

    const projectProgram = this.programs.project!;
    this.drawTo(this.velocityWrite, projectProgram, (uniforms) => {
      bindTexture(gl, uniforms, "u_velocity", this.velocityRead.texture, 0);
      bindTexture(gl, uniforms, "u_pressure", this.pressureRead.texture, 1);
      setVec2(gl, uniforms, "u_texelSize", texelX, texelY);
    });
    [this.velocityRead, this.velocityWrite] = [
      this.velocityWrite,
      this.velocityRead,
    ];

    this.updateDye(dt);
  }

  private updateDye(dt: number, initialize = false) {
    const gl = this.gl;
    const dyeProgram = this.programs.dye!;
    this.drawTo(this.dyeWrite, dyeProgram, (uniforms) => {
      bindTexture(gl, uniforms, "u_dye", this.dyeRead.texture, 0);
      bindTexture(gl, uniforms, "u_velocity", this.velocityRead.texture, 1);
      setVec2(gl, uniforms, "u_texelSize", 1 / this.simWidth, 1 / this.simHeight);
      setFloat(gl, uniforms, "u_dt", dt);
      setFloat(gl, uniforms, "u_initialize", initialize ? 1 : 0);
      setFloat(gl, uniforms, "u_time", this.simTime);
      setFloat(gl, uniforms, "u_seed", this.seed);
      setFloat(gl, uniforms, "u_aspect", this.renderWidth / this.renderHeight);
      setVec3(gl, uniforms, "u_color1", this.palette[0]);
      setVec3(gl, uniforms, "u_color2", this.palette[1]);
      setVec3(gl, uniforms, "u_color3", this.palette[2]);
    });
    [this.dyeRead, this.dyeWrite] = [this.dyeWrite, this.dyeRead];
  }

  private render() {
    const gl = this.gl;
    const program = this.programs.render!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.renderWidth, this.renderHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    // The shader already composites dye over black. Do not blend a second time.
    gl.disable(gl.BLEND);
    gl.useProgram(program.program);
    gl.bindVertexArray(this.vao);
    bindTexture(gl, program.uniforms, "u_dye", this.dyeRead.texture, 0);
    setVec2(
      gl,
      program.uniforms,
      "u_dyeTexelSize",
      1 / this.simWidth,
      1 / this.simHeight,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  private drawTo(
    target: FluidTarget,
    shader: ShaderProgram,
    bindUniformsForDraw: (
      uniforms: Map<string, WebGLUniformLocation | null>,
    ) => void,
  ) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(shader.program);
    gl.bindVertexArray(this.vao);
    bindUniformsForDraw(shader.uniforms);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private disposeResources() {
    const gl = this.gl;
    for (const target of this.targets) destroyTarget(gl, target);
    this.targets = [];
    for (const shader of Object.values(this.programs)) {
      if (shader) gl.deleteProgram(shader.program);
    }
    gl.deleteBuffer(this.quadBuffer);
    gl.deleteVertexArray(this.vao);
  }
}

export function createLiquidFluidRenderer(
  canvas: HTMLCanvasElement,
  input: {
    variant: LiquidVariant;
    palette: LiquidPalette;
    speed: number;
    onContextLost?: () => void;
  },
): LiquidFluidController | null {
  try {
    return new LowResolutionLiquidRenderer(canvas, input);
  } catch {
    return null;
  }
}
