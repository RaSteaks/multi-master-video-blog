"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { COLOR_MODELS, COLOR_MODEL_LABELS } from "@/lib/color-volume";
import {
  CHROMATICITY_CHOICES,
  CURVE_CHOICES,
  DEFAULT_HOME_DIAGRAM,
  GAMUT_CHOICES,
  HOME_DIAGRAMS,
  OVERLAY_CHOICES,
  PHOSPHOR_CHOICES,
  PIXEL_CHOICES,
  SIGNAL_CHOICES,
  SPECTRUM_CHOICES,
  TRANSFORM_CHOICES,
  VECTOR_STYLE_CHOICES,
  WAVE_STYLE_CHOICES,
  saveHomeDiagram,
  useHomeDiagram,
  type HomeDiagramKind,
  type HomeDiagramPreferences,
} from "@/lib/home-diagram";
import { animatePanelChange, cancelPanelMotion } from "@/lib/panel-motion";

const DIAGRAM_LABELS: Record<HomeDiagramKind, string> = {
  off: "关闭", random: "随机", vectorscope: "矢量图", waveform: "波形", volume: "体积",
  transform: "变换", chromaticity: "色度图", spectrum: "光谱", curve: "曲线", pixel: "像素",
};
const GAMUT_CHOICE_LABELS = {
  random: "随机", rec709: "709", p3: "P3", rec2020: "2020", ap0: "AP0", ap1: "AP1", dwg: "DWG", awg4: "AWG4", sgamut3: "SG3",
};
const SIGNAL_LABELS = { random: "随机", bars75: "75%", bars100: "100%", hue: "色相环", checker: "色卡" };
const VECTOR_STYLE_LABELS = { random: "随机", trace: "标准", points: "点阵", zoom: "×2" };
const WAVE_STYLE_LABELS = { random: "随机", luma: "亮度", rgb: "RGB", ycbcr: "YCbCr", overlay: "叠加" };
const PHOSPHOR_LABELS = { random: "随机", white: "白", green: "绿", amber: "琥珀", signal: "信号色" };
const SHORT_MODEL_LABELS = { ...COLOR_MODEL_LABELS, xyz: "XYZ", xyy: "xyY", lms: "LMS", ycbcr: "YCbCr", cam16: "CAM16" };
const OVERLAY_LABELS = { random: "随机", none: "无", optimal: "最优色", pointer: "Pointer", gradient: "渐变" };
const TRANSFORM_CHOICE_LABELS = { random: "随机", aces: "ACES", agx: "AgX", protan: "红色盲", deutan: "绿色盲", tritan: "蓝色盲", rgc: "压缩" };
const CHROMATICITY_CHOICE_LABELS = { random: "随机", gamuts: "色域", macadam: "椭圆", hue: "色相" };
const SPECTRUM_CHOICE_LABELS = { random: "随机", cmf: "配色", rgbcmf: "RGB", blackbody: "黑体", metamer: "异谱", tm30: "TM-30", camera: "相机" };
const CURVE_CHOICE_LABELS = { random: "随机", transfer: "传递", tonemap: "色调", film: "胶片" };
const PIXEL_CHOICE_LABELS = { random: "随机", subsampling: "抽样", bitdepth: "位深", bayer: "拜耳", mixing: "混色" };

// At most five to a row, spread evenly over as few rows as that allows.
function columns(count: number) {
  return count <= 5 ? count : Math.ceil(count / Math.ceil(count / 5));
}

function Options<T extends string>({ label, options, labels, value, onSelect }: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="home-diagram-group">
      <span>{label}</span>
      <div className="home-diagram-options" role="group" aria-label={label}
        style={{ "--options": columns(options.length) } as CSSProperties}>
        {options.map(option => (
          <button key={option} type="button" aria-pressed={option === value} onClick={() => onSelect(option)}>
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The single "content" row each newer diagram has. */
const CONTENT_ROWS = {
  transform: { field: "transform", options: TRANSFORM_CHOICES, labels: TRANSFORM_CHOICE_LABELS },
  chromaticity: { field: "chromaticity", options: CHROMATICITY_CHOICES, labels: CHROMATICITY_CHOICE_LABELS },
  spectrum: { field: "spectrum", options: SPECTRUM_CHOICES, labels: SPECTRUM_CHOICE_LABELS },
  curve: { field: "curve", options: CURVE_CHOICES, labels: CURVE_CHOICE_LABELS },
  pixel: { field: "pixel", options: PIXEL_CHOICES, labels: PIXEL_CHOICE_LABELS },
} as const;

export function HomeDiagramSettings() {
  const settings = useHomeDiagram() ?? DEFAULT_HOME_DIAGRAM;
  const rowsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rows = rowsRef.current;
    return () => cancelPanelMotion(rows);
  }, []);
  // Each diagram has its own rows, so the panel changes height with it.
  function selectDiagram(diagram: HomeDiagramKind) {
    animatePanelChange(rowsRef.current, () => flushSync(() => saveHomeDiagram({ ...settings, diagram })));
  }
  const content = settings.diagram in CONTENT_ROWS ? CONTENT_ROWS[settings.diagram as keyof typeof CONTENT_ROWS] : null;
  return (
    <div className="home-diagram-settings">
      <Options label="首页图示" options={HOME_DIAGRAMS} labels={DIAGRAM_LABELS} value={settings.diagram}
        onSelect={selectDiagram} />
      <div ref={rowsRef} className="home-diagram-rows"><div>
      {settings.diagram === "volume" ? (
        <>
          <Options label="色彩空间" options={GAMUT_CHOICES} labels={GAMUT_CHOICE_LABELS} value={settings.gamut}
            onSelect={gamut => saveHomeDiagram({ ...settings, gamut })} />
          <Options label="坐标" options={COLOR_MODELS} labels={SHORT_MODEL_LABELS} value={settings.model}
            onSelect={model => saveHomeDiagram({ ...settings, model })} />
          <Options label="叠加" options={OVERLAY_CHOICES} labels={OVERLAY_LABELS} value={settings.overlay}
            onSelect={overlay => saveHomeDiagram({ ...settings, overlay })} />
        </>
      ) : null}
      {settings.diagram === "vectorscope" || settings.diagram === "waveform" ? (
        <>
          <Options label="信号" options={SIGNAL_CHOICES} labels={SIGNAL_LABELS} value={settings.signal}
            onSelect={signal => saveHomeDiagram({ ...settings, signal })} />
          {settings.diagram === "vectorscope" ? (
            <Options label="样式" options={VECTOR_STYLE_CHOICES} labels={VECTOR_STYLE_LABELS} value={settings.vectorStyle}
              onSelect={vectorStyle => saveHomeDiagram({ ...settings, vectorStyle })} />
          ) : (
            <Options label="样式" options={WAVE_STYLE_CHOICES} labels={WAVE_STYLE_LABELS} value={settings.waveStyle}
              onSelect={waveStyle => saveHomeDiagram({ ...settings, waveStyle })} />
          )}
          <Options label="荧光色" options={PHOSPHOR_CHOICES} labels={PHOSPHOR_LABELS} value={settings.phosphor}
            onSelect={phosphor => saveHomeDiagram({ ...settings, phosphor })} />
        </>
      ) : null}
      {content ? (
        <Options<string> label="内容" options={content.options} labels={content.labels as Record<string, string>}
          value={settings[content.field]}
          onSelect={value => saveHomeDiagram({ ...settings, [content.field]: value } as HomeDiagramPreferences)} />
      ) : null}
      </div></div>
    </div>
  );
}
