"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { COLOR_MODELS, COLOR_MODEL_LABELS } from "@/lib/color-volume";
import {
  DEFAULT_HOME_DIAGRAM,
  GAMUT_CHOICES,
  HOME_DIAGRAMS,
  PHOSPHOR_CHOICES,
  SIGNAL_CHOICES,
  VECTOR_STYLE_CHOICES,
  WAVE_STYLE_CHOICES,
  saveHomeDiagram,
  useHomeDiagram,
  type HomeDiagramKind,
} from "@/lib/home-diagram";
import { animatePanelChange, cancelPanelMotion } from "@/lib/panel-motion";

const DIAGRAM_LABELS: Record<HomeDiagramKind, string> = {
  off: "关闭", random: "随机", vectorscope: "矢量图", waveform: "波形", volume: "色彩体积",
};
const GAMUT_CHOICE_LABELS = { random: "随机", rec709: "709", p3: "P3", rec2020: "2020", ap0: "AP0" };
const SIGNAL_LABELS = { random: "随机", bars75: "75%", bars100: "100%", hue: "色相环", checker: "色卡" };
const VECTOR_STYLE_LABELS = { random: "随机", trace: "标准", points: "点阵", zoom: "×2" };
const WAVE_STYLE_LABELS = { random: "随机", luma: "亮度", rgb: "RGB", ycbcr: "YCbCr", overlay: "叠加" };
const PHOSPHOR_LABELS = { random: "随机", white: "白", green: "绿", amber: "琥珀", signal: "信号色" };
const SHORT_MODEL_LABELS = { ...COLOR_MODEL_LABELS, xyz: "XYZ", xyy: "xyY", cam16: "CAM16" };

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
        style={{ "--options": options.length > 5 ? Math.ceil(options.length / 2) : options.length } as CSSProperties}>
        {options.map(option => (
          <button key={option} type="button" aria-pressed={option === value} onClick={() => onSelect(option)}>
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  );
}

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
      </div></div>
    </div>
  );
}
