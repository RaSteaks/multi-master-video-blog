import { sanitizeSourceFormat } from "../../../../shared/video-source-format.cjs";
import { applicationLabel, dolbyPlaybackLabel, dolbySourceLabel, sourceFormatLabel } from "@/lib/video-format";
import styles from "./VideoFormatInfo.module.css";

type Props = { source: unknown; playback?: string | null; lang?: "zh" | "en" };

/** Source/delivery identification belongs to upload results, outside the playback page. */
export function VideoFormatInfo({ source, playback, lang = "zh" }: Props) {
  const summary = sanitizeSourceFormat(source);
  const zh = lang === "zh";
  const primaries = ({ bt709: "BT.709", bt2020: "BT.2020", smpte432: "P3-D65", smpte431: "DCI-P3", smpte428: "XYZ (ST 428)" } as Record<string, string>)[summary?.primaries || ""] || summary?.primaries || "—";
  const transfer = ({ smpte2084: "PQ (ST 2084)", "arib-std-b67": "HLG", bt709: "BT.709" } as Record<string, string>)[summary?.transfer || ""] || summary?.transfer || "—";
  return <section className={`info-section ${styles.details}`} aria-label={zh ? "源格式与播放版本" : "Source and playback formats"}>
    <h3>{zh ? "源母版与播放版本" : "Source and playback versions"}</h3>
    <dl className="tech-grid">
      <div><dt>{zh ? "源母版" : "Source master"}</dt><dd>{sourceFormatLabel(summary, lang)}</dd></div>
      <div><dt>{zh ? "播放版本" : "Playback version"}</dt><dd>{playback || (zh ? "未生成" : "Not generated")}</dd></div>
      {summary ? <>
        <div><dt>{zh ? "源编码" : "Source codec"}</dt><dd>{summary.codec === "jpeg2000" ? "JPEG 2000" : summary.codec || (zh ? "未记录" : "Not recorded")}</dd></div>
        <div><dt>{zh ? "源色域 / 传递函数" : "Source primaries / transfer"}</dt><dd>{primaries} / {transfer}</dd></div>
        <div><dt>{zh ? "源信号范围" : "Source signal range"}</dt><dd>{({full: zh ? "全范围" : "Full", limited: zh ? "有限范围" : "Limited", custom: zh ? "自定义" : "Custom", unknown: zh ? "未知" : "Unknown"})[summary.range]}</dd></div>
      </> : null}
      {summary?.container === "imf" ? <>
        <div><dt>{zh ? "IMF 规范声明" : "IMF application declaration"}</dt><dd>{summary.applicationIds.length ? summary.applicationIds.map(applicationLabel).join(" / ") : (zh ? "未记录" : "Not recorded")}</dd></div>
        <div><dt>{zh ? "包资源" : "Package resources"}</dt><dd>{summary.packageKind === "self_contained" ? (zh ? "引用资源均在包内" : "Referenced resources present") : summary.packageKind === "external_references" ? (zh ? `缺少 ${summary.missingResources} 项引用；可能是补充包或不完整上传` : `${summary.missingResources} references missing; supplemental or incomplete package`) : (zh ? "未确认" : "Unconfirmed")}</dd></div>
      </> : null}
      <div><dt>{zh ? "Dolby 元数据识别" : "Dolby metadata identification"}</dt><dd>{dolbySourceLabel(summary, lang)}</dd></div>
    </dl>
    {playback ? <p className="field-note">{dolbyPlaybackLabel(summary, lang)}</p> : null}
    {!summary ? <p className="field-note">{zh ? "这条历史记录没有源格式信息；不能从播放版本反推原始母版。" : "This older record has no source-format information; playback format does not establish the original source."}</p> : null}
  </section>;
}
