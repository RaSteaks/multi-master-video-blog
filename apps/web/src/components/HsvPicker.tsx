"use client";

import {
  useId,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { hsvToHex, type HsvColor } from "@/lib/theme-color";

export function HsvPicker({
  value,
  onChange,
  displayHex,
}: {
  value: HsvColor;
  /** Preserve an exact preset swatch when its HSV readout is rounded. */
  displayHex?: string;
  onChange: (value: HsvColor) => void;
}) {
  const pickerId = useId();
  const customHex = displayHex ?? hsvToHex(value);
  function updateSaturationValue(event: ReactPointerEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const saturation =
      ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 100;
    const brightness =
      (1 - (event.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
    onChange({
      h: value.h,
      s: saturation,
      v: brightness,
    });
  }

  function onSaturationValueKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const step = event.shiftKey ? 10 : 1;
    let next = value;

    if (event.key === "ArrowLeft") {
      next = { ...value, s: value.s - step };
    } else if (event.key === "ArrowRight") {
      next = { ...value, s: value.s + step };
    } else if (event.key === "ArrowUp") {
      next = { ...value, v: value.v + step };
    } else if (event.key === "ArrowDown") {
      next = { ...value, v: value.v - step };
    } else {
      return;
    }

    event.preventDefault();
    onChange(next);
  }

  return (
    <div className="hsv-picker">
      <button
        type="button"
        className="sv-plane"
        aria-label={`饱和度 ${value.s}%，明度 ${value.v}%。使用方向键调整，按住 Shift 每次调整 10%。`}
        style={{ "--picker-hue": value.h } as CSSProperties}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          updateSaturationValue(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            updateSaturationValue(event);
          }
        }}
        onKeyDown={onSaturationValueKeyDown}
      >
        <span
          className="sv-plane-handle"
          style={{
            left: `${value.s}%`,
            top: `${100 - value.v}%`,
            background: customHex,
          }}
          aria-hidden="true"
        />
      </button>

      <div className="hsv-hue-control">
        <div className="bg-control-header">
          <label htmlFor={`${pickerId}-hue`}>Hue</label>
          <output>{value.h}°</output>
        </div>
        <input
          id={`${pickerId}-hue`}
          className="hue-slider"
          type="range"
          min={0}
          max={359}
          step={1}
          value={value.h}
          style={{ "--picker-hue": value.h } as CSSProperties}
          onChange={(event) =>
            onChange({
              ...value,
              h: Number(event.target.value),
            })
          }
        />
      </div>

      <div className="hsv-number-grid">
        {(
          [
            ["h", "H", 0, 359],
            ["s", "S", 0, 100],
            ["v", "V", 0, 100],
          ] as const
        ).map(([channel, label, min, max]) => (
          <label key={channel}>
            <span>{label}</span>
            <input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={1}
              value={value[channel]}
              onChange={(event) =>
                onChange({
                  ...value,
                  [channel]: Number(event.target.value),
                })
              }
            />
          </label>
        ))}
        <div className="hsv-hex-output">
          <span>HEX</span>
          <output>{customHex}</output>
        </div>
      </div>
    </div>
  );
}
