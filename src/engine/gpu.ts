import type { LutTable } from "../core/cube";
import { CURVE_CHANNELS, HSL_COLORS, curveTable, hasCurves, hasHsl, type Curves } from "../core/curves";
import type { Adjust, Segment } from "../core/model";

/**
 * Applies a clip's look on the GPU and hands back a canvas for the 2D compositor
 * to place. The scene itself stays in 2D, so text, masks, blending and
 * transitions work the same for every clip.
 */
type Source = HTMLVideoElement | ImageBitmap | HTMLCanvasElement | OffscreenCanvas;

const VERTEX = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
uniform float u_flip;
void main() {
  v_uv = vec2(a_position.x * 0.5 + 0.5, u_flip > 0.5 ? 0.5 - a_position.y * 0.5 : 0.5 + a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const LOOK = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 color;

uniform sampler2D u_source;
uniform sampler3D u_lut;
uniform sampler2D u_curves;  // 256 wide: red, green, blue and master in rgba
uniform float u_curvesOn;
uniform vec3 u_hsl[8];       // hue, saturation, lightness shift per colour
uniform float u_hslOn;
uniform float u_lutSize;
uniform float u_lutMix;
uniform vec4 u_crop;      // offset xy, scale zw
uniform vec2 u_pixel;     // one output pixel in uv
uniform float u_time;
uniform vec3 u_basic;     // brightness, contrast, saturation multipliers
uniform vec4 u_light;     // exposure, temperature, tint, hue
uniform vec2 u_tone;      // highlights, shadows
uniform vec4 u_detail;    // sharpen, vignette, grain, fade
uniform vec3 u_key;
uniform vec4 u_chroma;    // on, threshold, softness, spill
uniform vec4 u_fx;        // pixelate, shake, glitch, retro

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

vec2 placed(vec2 uv) {
  float amount = u_fx.x;
  if (amount > 0.0) {
    float cells = mix(320.0, 24.0, amount);
    vec2 grid = vec2(cells, cells * u_pixel.x / u_pixel.y);
    uv = (floor(uv * grid) + 0.5) / grid;
  }
  float shake = u_fx.y;
  if (shake > 0.0) {
    vec2 move = vec2(sin(u_time * 37.0) + sin(u_time * 61.0), cos(u_time * 29.0) + sin(u_time * 53.0));
    uv = (uv - 0.5) * (1.0 - 0.06 * shake) + 0.5 + move * 0.0125 * shake;
  }
  float glitch = u_fx.z;
  if (glitch > 0.0) {
    float tick = floor(u_time * 12.0);
    float band = floor(uv.y * 18.0);
    if (hash(vec2(band, tick)) > 1.0 - 0.45 * glitch) {
      uv.x += (hash(vec2(tick, band)) - 0.5) * 0.18 * glitch;
    }
  }
  return uv;
}

vec3 fetchColor(vec2 uv) {
  return texture(u_source, clamp(uv, 0.0, 1.0) * u_crop.zw + u_crop.xy).rgb;
}

vec3 rawColor(vec2 uv) {
  float split = u_fx.z * 0.012;
  if (split > 0.0) {
    return vec3(fetchColor(uv + vec2(split, 0.0)).r, fetchColor(uv).g, fetchColor(uv - vec2(split, 0.0)).b);
  }
  return fetchColor(uv);
}

vec3 rotateHue(vec3 c, float angle) {
  float cosine = cos(angle);
  vec3 axis = vec3(0.57735);
  return c * cosine + cross(axis, c) * sin(angle) + axis * dot(axis, c) * (1.0 - cosine);
}

vec2 chromaOf(vec3 c) {
  return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b);
}

vec3 toHsl(vec3 c) {
  float high = max(c.r, max(c.g, c.b));
  float low = min(c.r, min(c.g, c.b));
  float lightness = (high + low) * 0.5;
  float range = high - low;
  if (range < 0.00001) return vec3(0.0, 0.0, lightness);
  float saturation = range / (1.0 - abs(2.0 * lightness - 1.0));
  float hue = high == c.r ? mod((c.g - c.b) / range, 6.0) : high == c.g ? (c.b - c.r) / range + 2.0 : (c.r - c.g) / range + 4.0;
  return vec3(hue / 6.0, saturation, lightness);
}

vec3 fromHsl(vec3 hsl) {
  vec3 wave = clamp(abs(mod(hsl.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return hsl.z + hsl.y * (wave - 0.5) * (1.0 - abs(2.0 * hsl.z - 1.0));
}

/** Each colour owns a stretch of the hue circle, blending into its neighbours. */
vec3 shiftColors(vec3 c) {
  const float centers[8] = float[8](0.0, 0.083, 0.167, 0.333, 0.5, 0.667, 0.75, 0.875);
  vec3 hsl = toHsl(c);
  vec3 shift = vec3(0.0);
  for (int index = 0; index < 8; index += 1) {
    float gap = abs(hsl.x - centers[index]);
    gap = min(gap, 1.0 - gap);
    shift += u_hsl[index] * (1.0 - smoothstep(0.03, 0.12, gap));
  }
  float strength = smoothstep(0.02, 0.15, hsl.y);
  hsl.x = fract(hsl.x + shift.x * 0.25 * strength + 1.0);
  hsl.y = clamp(hsl.y * (1.0 + shift.y * strength), 0.0, 1.0);
  hsl.z = clamp(hsl.z + shift.z * 0.3 * strength, 0.0, 1.0);
  return fromHsl(hsl);
}

vec3 applyCurves(vec3 c) {
  vec3 channels = vec3(
    texture(u_curves, vec2(c.r, 0.5)).r,
    texture(u_curves, vec2(c.g, 0.5)).g,
    texture(u_curves, vec2(c.b, 0.5)).b
  );
  return vec3(
    texture(u_curves, vec2(channels.r, 0.5)).a,
    texture(u_curves, vec2(channels.g, 0.5)).a,
    texture(u_curves, vec2(channels.b, 0.5)).a
  );
}

void main() {
  vec2 uv = placed(v_uv);
  vec3 c = rawColor(uv);

  float alpha = 1.0;
  if (u_chroma.x > 0.5) {
    float distanceToKey = distance(chromaOf(c), chromaOf(u_key));
    alpha = smoothstep(u_chroma.y, u_chroma.y + u_chroma.z, distanceToKey);
    float near = 1.0 - smoothstep(u_chroma.y, u_chroma.y + 0.3, distanceToKey);
    c = mix(c, vec3(dot(c, LUMA)), near * u_chroma.w);
  }

  if (u_detail.x > 0.0) {
    vec3 around = rawColor(uv + vec2(u_pixel.x, 0.0)) + rawColor(uv - vec2(u_pixel.x, 0.0))
      + rawColor(uv + vec2(0.0, u_pixel.y)) + rawColor(uv - vec2(0.0, u_pixel.y));
    c += (c - around * 0.25) * u_detail.x * 2.5;
  }

  c *= exp2(u_light.x);
  c *= vec3(1.0 + 0.3 * u_light.y, 1.0 - 0.3 * u_light.z, 1.0 - 0.3 * u_light.y);
  float level = dot(clamp(c, 0.0, 1.0), LUMA);
  c += u_tone.x * 0.35 * smoothstep(0.45, 1.0, level);
  c += u_tone.y * 0.35 * (1.0 - smoothstep(0.0, 0.55, level));
  if (u_light.w != 0.0) c = rotateHue(c, u_light.w);

  c *= u_basic.x;
  c = (c - 0.5) * u_basic.y + 0.5;
  c = mix(vec3(dot(c, LUMA)), c, u_basic.z);
  c = clamp(c, 0.0, 1.0);

  if (u_hslOn > 0.5) c = shiftColors(c);
  if (u_curvesOn > 0.5) c = applyCurves(c);

  if (u_lutMix > 0.0) {
    vec3 cell = (c * (u_lutSize - 1.0) + 0.5) / u_lutSize;
    c = mix(c, texture(u_lut, cell).rgb, u_lutMix);
  }

  c = c * (1.0 - u_detail.w * 0.3) + u_detail.w * 0.12;
  if (u_detail.y != 0.0) {
    float edge = smoothstep(0.3, 0.85, length(v_uv - 0.5));
    c *= 1.0 - u_detail.y * edge;
  }
  if (u_detail.z > 0.0) {
    vec2 cell = floor(v_uv * 720.0);
    c += (hash(cell + fract(u_time) * 91.0) - 0.5) * u_detail.z * 0.3;
  }
  if (u_fx.w > 0.0) {
    c = mix(c, vec3(dot(c, LUMA)) * vec3(1.05, 1.0, 0.85), u_fx.w * 0.5);
    c *= 1.0 - u_fx.w * 0.3 * (0.5 + 0.5 * sin(v_uv.y * 1500.0));
  }

  c = clamp(c, 0.0, 1.0);
  color = vec4(c * alpha, alpha);
}`;

const BLUR = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 color;
uniform sampler2D u_image;
uniform vec2 u_step;
uniform float u_threshold;
void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int index = -6; index <= 6; index += 1) {
    float weight = exp(-float(index * index) / 18.0);
    vec4 value = texture(u_image, v_uv + u_step * float(index));
    if (u_threshold > 0.0) value.rgb = max(value.rgb - u_threshold, 0.0);
    sum += value * weight;
    total += weight;
  }
  color = sum / total;
}`;

const FINISH = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 color;
uniform sampler2D u_image;
uniform sampler2D u_glow;
uniform float u_glowMix;
void main() {
  vec4 base = texture(u_image, v_uv);
  vec3 lit = base.rgb + texture(u_glow, v_uv).rgb * u_glowMix;
  color = vec4(min(lit, vec3(base.a)), base.a);
}`;

const GLOW_THRESHOLD = 0.55;
const GLOW_GAIN = 2.2;
const MAX_BLUR_RADIUS = 0.04;
const GLOW_RADIUS = 0.03;

interface Program {
  program: WebGLProgram;
  uniform(name: string): WebGLUniformLocation | null;
}

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
}

function rgbOf(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

const percent = (adjust: Adjust, name: keyof Adjust) => (adjust[name] ?? 0) / 100;

class GpuRenderer {
  readonly canvas = new OffscreenCanvas(1, 1);
  private gl: WebGL2RenderingContext;
  private look: Program;
  private blur: Program;
  private finish: Program;
  private sourceTexture: WebGLTexture;
  private emptyLut: WebGLTexture;
  private curvesTexture: WebGLTexture;
  private lastCurves: Curves | undefined;
  private luts = new WeakMap<LutTable, WebGLTexture>();
  private targets: Target[] = [];
  private targetSize = "";

  constructor() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error("WebGL2 indisponível");
    this.gl = gl;
    this.look = this.compile(LOOK);
    this.blur = this.compile(BLUR);
    this.finish = this.compile(FINISH);
    this.sourceTexture = this.makeTexture();
    this.emptyLut = this.uploadLut({ size: 2, data: new Float32Array(24) });
    this.curvesTexture = this.makeTexture();

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  get lost(): boolean {
    return this.gl.isContextLost();
  }

  private compile(fragment: string): Program {
    const { gl } = this;
    const shaderOf = (type: number, code: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader) ?? "shader inválido");
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shaderOf(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shaderOf(gl.FRAGMENT_SHADER, fragment));
    gl.bindAttribLocation(program, 0, "a_position");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "programa inválido");
    }
    const locations = new Map<string, WebGLUniformLocation | null>();
    return {
      program,
      uniform: (name) => {
        if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
        return locations.get(name)!;
      },
    };
  }

  private makeTexture(): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  private uploadLut({ size, data }: LutTable): WebGLTexture {
    const { gl } = this;
    const rgba = new Float32Array(size ** 3 * 4);
    for (let index = 0; index < size ** 3; index += 1) {
      rgba.set(data.subarray(index * 3, index * 3 + 3), index * 4);
      rgba[index * 4 + 3] = 1;
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, axis, gl.CLAMP_TO_EDGE);
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.FLOAT, rgba);
    return texture;
  }

  /** One row holding all four curves, redone only when they change. */
  private uploadCurves(curves: Curves): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.curvesTexture);
    if (curves === this.lastCurves) return;
    this.lastCurves = curves;
    const pixels = new Uint8Array(256 * 4);
    const identity = curveTable([[0, 0], [1, 1]]);
    const slots: Record<(typeof CURVE_CHANNELS)[number], number> = { red: 0, green: 1, blue: 2, master: 3 };
    for (const channel of CURVE_CHANNELS) {
      const points = curves[channel];
      const table = points ? curveTable(points) : identity;
      for (let step = 0; step < 256; step += 1) pixels[step * 4 + slots[channel]] = Math.round(table[step]! * 255);
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  private resize(width: number, height: number): void {
    const { gl } = this;
    const size = `${width}x${height}`;
    if (size === this.targetSize) return;
    this.targetSize = size;
    this.canvas.width = width;
    this.canvas.height = height;
    for (const target of this.targets) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    this.targets = [0, 1, 2].map(() => {
      const texture = this.makeTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      return { texture, framebuffer };
    });
  }

  private pass(target: Target | null, width: number, height: number): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private blurInto(from: Target, via: Target, to: Target, radius: number, threshold: number, width: number, height: number): void {
    const { gl } = this;
    const { program, uniform } = this.blur;
    gl.useProgram(program);
    gl.uniform1f(uniform("u_flip"), 0);
    gl.uniform1i(uniform("u_image"), 0);
    gl.activeTexture(gl.TEXTURE0);
    const step = (radius * height) / 6;
    gl.uniform1f(uniform("u_threshold"), threshold);
    gl.uniform2f(uniform("u_step"), step / width, 0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    this.pass(via, width, height);
    gl.uniform1f(uniform("u_threshold"), 0);
    gl.uniform2f(uniform("u_step"), 0, step / height);
    gl.bindTexture(gl.TEXTURE_2D, via.texture);
    this.pass(to, width, height);
  }

  render(
    source: Source,
    segment: Segment,
    time: number,
    lut: LutTable | undefined,
    width: number,
    height: number,
  ): OffscreenCanvas {
    const { gl } = this;
    this.resize(width, height);
    const { adjust, crop, chroma, effects = {} } = segment;
    const blur = effects.blur ?? 0;
    const glow = effects.glow ?? 0;

    const { program, uniform } = this.look;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE1);
    let lutTexture = this.emptyLut;
    if (lut) {
      lutTexture = this.luts.get(lut) ?? this.uploadLut(lut);
      this.luts.set(lut, lutTexture);
    }
    gl.bindTexture(gl.TEXTURE_3D, lutTexture);
    gl.activeTexture(gl.TEXTURE2);
    const curvesOn = hasCurves(segment.curves);
    if (curvesOn) this.uploadCurves(segment.curves!);
    else gl.bindTexture(gl.TEXTURE_2D, this.curvesTexture);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform1f(uniform("u_flip"), 1);
    gl.uniform1i(uniform("u_source"), 0);
    gl.uniform1i(uniform("u_lut"), 1);
    gl.uniform1i(uniform("u_curves"), 2);
    gl.uniform1f(uniform("u_curvesOn"), curvesOn ? 1 : 0);
    gl.uniform1f(uniform("u_hslOn"), hasHsl(segment.hsl) ? 1 : 0);
    gl.uniform3fv(
      uniform("u_hsl"),
      HSL_COLORS.flatMap((name) => {
        const shift = segment.hsl?.[name];
        return [(shift?.hue ?? 0) / 100, (shift?.saturation ?? 0) / 100, (shift?.lightness ?? 0) / 100];
      }),
    );
    gl.uniform1f(uniform("u_lutSize"), lut?.size ?? 2);
    gl.uniform1f(uniform("u_lutMix"), lut ? (segment.lut?.strength ?? 1) : 0);
    const left = crop?.left ?? 0;
    const top = crop?.top ?? 0;
    gl.uniform4f(uniform("u_crop"), left, top, 1 - left - (crop?.right ?? 0), 1 - top - (crop?.bottom ?? 0));
    gl.uniform2f(uniform("u_pixel"), 1 / width, 1 / height);
    gl.uniform1f(uniform("u_time"), time);
    gl.uniform3f(
      uniform("u_basic"),
      1 + percent(adjust, "brightness"),
      1 + percent(adjust, "contrast"),
      1 + percent(adjust, "saturation"),
    );
    gl.uniform4f(
      uniform("u_light"),
      percent(adjust, "exposure") * 2,
      percent(adjust, "temperature"),
      percent(adjust, "tint"),
      percent(adjust, "hue") * Math.PI,
    );
    gl.uniform2f(uniform("u_tone"), percent(adjust, "highlights"), percent(adjust, "shadows"));
    gl.uniform4f(
      uniform("u_detail"),
      percent(adjust, "sharpen"),
      percent(adjust, "vignette"),
      percent(adjust, "grain"),
      percent(adjust, "fade"),
    );
    const [keyRed, keyGreen, keyBlue] = rgbOf(chroma?.color ?? "#00ff00");
    gl.uniform3f(uniform("u_key"), keyRed, keyGreen, keyBlue);
    gl.uniform4f(
      uniform("u_chroma"),
      chroma ? 1 : 0,
      (chroma?.strength ?? 0) * 0.5,
      (chroma?.softness ?? 0) * 0.25 + 0.002,
      chroma?.spill ?? 0,
    );
    gl.uniform4f(uniform("u_fx"), effects.pixelate ?? 0, effects.shake ?? 0, effects.glitch ?? 0, effects.retro ?? 0);

    const [first, second, third] = this.targets as [Target, Target, Target];
    if (!blur && !glow) {
      this.pass(null, width, height);
      return this.canvas;
    }

    this.pass(first, width, height);
    if (blur) this.blurInto(first, second, first, blur * MAX_BLUR_RADIUS, 0, width, height);
    if (glow) this.blurInto(first, second, third, GLOW_RADIUS, GLOW_THRESHOLD, width, height);

    const finish = this.finish;
    gl.useProgram(finish.program);
    gl.uniform1f(finish.uniform("u_flip"), 0);
    gl.uniform1i(finish.uniform("u_image"), 0);
    gl.uniform1i(finish.uniform("u_glow"), 1);
    gl.uniform1f(finish.uniform("u_glowMix"), glow * GLOW_GAIN);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, third.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, first.texture);
    this.pass(null, width, height);
    return this.canvas;
  }
}

let renderer: GpuRenderer | null | undefined;

function getRenderer(): GpuRenderer | null {
  if (renderer === undefined || renderer?.lost) {
    try {
      renderer = new GpuRenderer();
    } catch (error) {
      console.warn("Efeitos de GPU indisponíveis neste navegador", error);
      renderer = null;
    }
  }
  return renderer;
}

export function gpuAvailable(): boolean {
  return getRenderer() !== null;
}

/** Draws a clip with its look at an output size, or null when the GPU cannot be used. */
export function renderLook(
  source: Source,
  segment: Segment,
  time: number,
  lut: LutTable | undefined,
  width: number,
  height: number,
): OffscreenCanvas | null {
  return getRenderer()?.render(source, segment, time, lut, width, height) ?? null;
}
