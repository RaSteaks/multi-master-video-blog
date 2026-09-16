"use client";

import { useEffect, useId, useRef, useState } from "react";
import { hexToHsv, normalizeHsv, type HsvColor } from "@/lib/theme-color";
import {
  LIQUID_STORAGE_KEY,
  applyLiquidPreferences,
  defaultLiquidPreferences,
  resetLiquidPreferences,
  resolveLiquidPreferences,
  saveLiquidSlot,
  type LiquidColor,
  type LiquidPreferences,
} from "@/lib/liquid-preferences";
import { HsvPicker } from "./HsvPicker";

export function useLiquidPreferences() {
  const [settings, setSettings] = useState(defaultLiquidPreferences);
  const current = useRef(settings);
  const [storageError, setStorageError] = useState("");

  useEffect(() => {
    function receive(raw: string | null) {
      const next = resolveLiquidPreferences(raw).settings;
      current.current = next;
      setSettings(next);
      applyLiquidPreferences(next);
    }
    try {
      receive(window.localStorage.getItem(LIQUID_STORAGE_KEY));
    } catch {
      setStorageError("浏览器存储不可用，设置仅在当前页面生效。");
    }
    function onStorage(event: StorageEvent) {
      if (event.key !== LIQUID_STORAGE_KEY && event.key !== null) return;
      if (event.storageArea !== window.localStorage) return;
      receive(event.newValue);
      setStorageError("");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function update(change: (previous: LiquidPreferences) => LiquidPreferences) {
    const next = resolveLiquidPreferences(
      JSON.stringify(change(current.current)),
    ).settings;
    current.current = next;
    setSettings(next);
    applyLiquidPreferences(next);
    try {
      window.localStorage.setItem(LIQUID_STORAGE_KEY, JSON.stringify(next));
      setStorageError("");
    } catch {
      setStorageError("未能保存设置，当前效果仍有效；刷新后可能丢失。");
    }
  }

  return {
    settings,
    storageError,
    update,
    reset: () => update(resetLiquidPreferences),
  };
}

function swatch(color: LiquidColor) {
  return resolveLiquidPreferences(JSON.stringify({ version: 1, color }))
    .swatchHex;
}

export function LiquidSettings({
  controller,
}: {
  controller: ReturnType<typeof useLiquidPreferences>;
}) {
  const { settings, update, storageError } = controller;
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const [undoSlots, setUndoSlots] = useState<LiquidPreferences["slots"] | null>(
    null,
  );
  const id = useId();
  const selectedHex = swatch(settings.color);
  const hsv =
    settings.color.kind === "custom"
      ? settings.color.hsv
      : normalizeHsv(hexToHsv(selectedHex));

  function selectColor(color: LiquidColor) {
    update((previous) => ({ ...previous, color }));
    setMessage("");
  }
  function editColor(value: HsvColor) {
    selectColor({ kind: "custom", hsv: normalizeHsv(value) });
  }
  function save(index: number, clear = false) {
    setUndoSlots(settings.slots);
    update((previous) =>
      saveLiquidSlot(previous, index, clear ? null : previous.color),
    );
    setMessage(
      clear
        ? `已清空栏位 ${index + 1}。`
        : `已将当前颜色存入栏位 ${index + 1}。`,
    );
  }

  return (
    <div className="liquid-settings">
      <div className="bg-control-slider">
        <div className="bg-control-header">
          <label htmlFor={`${id}-speed`}>流动速度</label>
          <output htmlFor={`${id}-speed`}>
            {settings.speed === 0 ? "暂停" : `${settings.speed.toFixed(1)} 倍`}
          </output>
        </div>
        <input
          id={`${id}-speed`}
          type="range"
          min={0}
          max={3}
          step={0.1}
          value={settings.speed}
          aria-valuetext={
            settings.speed === 0 ? "暂停" : `${settings.speed} 倍`
          }
          onChange={(event) =>
            update((previous) => ({
              ...previous,
              speed: Number(event.target.value),
            }))
          }
        />
      </div>

      <div className="liquid-color-heading">
        <span>液体颜色</span>
        <code>{selectedHex}</code>
      </div>
      <div
        className="liquid-swatches"
        role="group"
        aria-label="液体背景颜色收藏"
      >
        <div className="liquid-slot">
          <button
            type="button"
            className="liquid-swatch"
            aria-label="默认灰色"
            aria-pressed={settings.color.kind === "gray"}
            onClick={() => selectColor({ kind: "gray" })}
          >
            <span style={{ background: "#121518" }} aria-hidden="true" />
            <span>默认灰色</span>
          </button>
        </div>
        {settings.slots.map((slot, index) => (
          <div className="liquid-slot" key={index}>
            <button
              type="button"
              className="liquid-swatch"
              aria-label={
                slot
                  ? `应用栏位 ${index + 1}：${swatch(slot)}`
                  : `保存当前颜色到栏位 ${index + 1}`
              }
              aria-pressed={
                slot
                  ? JSON.stringify(slot) === JSON.stringify(settings.color)
                  : false
              }
              onClick={() => (slot ? selectColor(slot) : save(index))}
            >
              <span
                style={slot ? { background: swatch(slot) } : undefined}
                aria-hidden="true"
              >
                {slot ? "" : "+"}
              </span>
              <span>{slot ? `颜色 ${index + 1}` : `保存 ${index + 1}`}</span>
            </button>
            {slot && (
              <div className="liquid-slot-actions">
                <button
                  type="button"
                  aria-label={`用当前颜色覆盖栏位 ${index + 1}`}
                  onClick={() => save(index)}
                >
                  覆盖
                </button>
                <button
                  type="button"
                  aria-label={`清空栏位 ${index + 1}`}
                  onClick={() => save(index, true)}
                >
                  清空
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="liquid-save-feedback">
        <span role="status">
          {storageError || message || "点击空栏位保存当前颜色。"}
        </span>
        {undoSlots && (
          <button
            type="button"
            onClick={() => {
              update((previous) => ({ ...previous, slots: undoSlots }));
              setUndoSlots(null);
              setMessage("已撤销上次栏位修改。");
            }}
          >
            撤销
          </button>
        )}
      </div>
      <button
        type="button"
        className="liquid-editor-toggle"
        aria-expanded={expanded}
        aria-controls={`${id}-editor`}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>HSV 自定义</span>
        <span>{expanded ? "收起 −" : "展开 +"}</span>
      </button>
      <div id={`${id}-editor`} hidden={!expanded}>
        <HsvPicker value={hsv} onChange={editColor} displayHex={selectedHex} />
      </div>
      <p className="bg-control-note">
        仅调整流动液体的颜色，底色保持深灰。全站共用此设置，并保存在当前浏览器。
      </p>
    </div>
  );
}
