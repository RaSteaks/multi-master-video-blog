"use client";

import { useEffect, useMemo } from "react";
import { Application, Entity } from "@playcanvas/react";
import { Camera, GSplat, Script } from "@playcanvas/react/components";
import { useSplat } from "@playcanvas/react/hooks";
import {
  DEVICETYPE_WEBGL2,
  DEVICETYPE_WEBGPU,
  Vec3,
} from "playcanvas";
import { CameraControls } from "playcanvas/scripts/esm/camera-controls.mjs";
import type { GaussianSplatConfig } from "@/lib/gaussian-splat";

export type GaussianSplatRenderState =
  | { phase: "loading"; progress: number }
  | { phase: "ready"; progress: 1 }
  | { phase: "error"; progress: 0; message: string };

type GaussianSplatCanvasProps = {
  config: GaussianSplatConfig;
  onRenderState: (state: GaussianSplatRenderState) => void;
};

export function GaussianSplatCanvas({
  config,
  onRenderState,
}: GaussianSplatCanvasProps) {
  return (
    <Application
      className="gaussian-splat-canvas"
      deviceTypes={[DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2]}
      graphicsDeviceOptions={{ antialias: false }}
    >
      <GaussianSplatScene config={config} onRenderState={onRenderState} />
    </Application>
  );
}

function GaussianSplatScene({
  config,
  onRenderState,
}: GaussianSplatCanvasProps) {
  const { asset, loading, error, subscribe } = useSplat(config.src);
  const focusPoint = useMemo(
    () => new Vec3(...config.target),
    [config.target],
  );

  useEffect(() => {
    return subscribe((metadata) => {
      onRenderState({
        phase: "loading",
        progress: Number(metadata.progress) || 0,
      });
    });
  }, [onRenderState, subscribe]);

  useEffect(() => {
    if (error) {
      onRenderState({
        phase: "error",
        progress: 0,
        message: error,
      });
      return;
    }

    if (!loading && asset) {
      onRenderState({ phase: "ready", progress: 1 });
    }
  }, [asset, error, loading, onRenderState]);

  return (
    <>
      <Entity name="3DGS Camera" position={config.cameraPosition}>
        <Camera clearColor={config.background} farClip={10000} />
        <Script
          script={CameraControls}
          enableFly={false}
          enableOrbit
          enablePan
          focusPoint={focusPoint}
        />
      </Entity>

      {asset ? (
        <Entity
          name={config.title}
          position={config.position}
          rotation={config.rotation}
          scale={config.scale}
        >
          <GSplat asset={asset} />
        </Entity>
      ) : null}
    </>
  );
}
