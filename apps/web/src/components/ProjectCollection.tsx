"use client";

import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { ProjectLayout } from "../../../../shared/project-layouts.cjs";
import { groupWebsiteProjects, WEBSITE_PREVIEW_MOBILE_QUERY, type WebsiteProject } from "@/lib/external-projects";
import { useWebsitePreviews } from "@/lib/use-website-previews";
import { MediaCard } from "./MediaCard";
import { ProjectPreview } from "./ProjectPreview";
import { SortableGrid } from "./SortableGrid";
import projectStyles from "./Projects.module.css";
import styles from "./ProjectLayouts.module.css";

export function ProjectCollection({ projects, layout, blocked, linkedProject, pending, collectionRef, refreshes, onView, renderManagement }: {
  projects: WebsiteProject[]; layout: ProjectLayout; blocked: boolean; linkedProject?: number; pending: boolean;
  collectionRef: RefObject<HTMLDivElement | null>; refreshes: boolean;
  onView: (project: WebsiteProject) => void; renderManagement: (project: WebsiteProject) => ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(linkedProject);
  const selected = projects.find(project => project.id === selectedId) ?? projects[0];
  const [live, observeBudget] = useWebsitePreviews<number>();

  useEffect(() => {
    const visible = new Set<number>();
    // Stable author order prevents unrelated frames restarting on observer delivery.
    const budget = observeBudget(limit => projects.filter(project => visible.has(project.id))
      .slice(0, limit).map(project => project.id), blocked);
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.previewId);
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      budget.update();
    });
    collectionRef.current?.querySelectorAll<HTMLElement>("[data-preview-id]").forEach(card => {
      observer.observe(card);
      const box = card.getBoundingClientRect();
      if (box.bottom > 0 && box.top < innerHeight) visible.add(Number(card.dataset.previewId));
    });
    // A route wipe pauses observers: prime visible frames from their current geometry.
    budget.apply();
    return () => {
      observer.disconnect();
      budget.disconnect();
    };
  }, [blocked, projects, layout, selected?.id, collectionRef, observeBudget]);

  useLayoutEffect(() => {
    if (layout !== "masonry") return;
    const list = collectionRef.current?.querySelector<HTMLOListElement>("ol");
    if (!list) return;
    const cards = Array.from(list.children) as HTMLElement[];
    function measure() {
      if (!list) return;
      const gap = parseFloat(getComputedStyle(list).rowGap);
      for (const card of cards) {
        // Each item keeps its natural height. Row spans pack it without changing DOM
        // order, so the shared pointer/keyboard sorter keeps its existing semantics.
        card.style.setProperty("--project-row-span", String(Math.ceil((card.getBoundingClientRect().height + gap) / (8 + gap))));
      }
      list.dataset.masonry = "";
    }
    measure();
    const observer = new ResizeObserver(measure);
    cards.forEach(card => observer.observe(card));
    return () => {
      observer.disconnect(); delete list.dataset.masonry;
      cards.forEach(card => card.style.removeProperty("--project-row-span"));
    };
  }, [layout, projects, collectionRef]);

  function entry(project: WebsiteProject) {
    const media = <ProjectPreview key={project.id} project={project} active={live.includes(project.id) && !blocked} auto />;
    return project.open_mode === "external"
      ? <a className={`content-card ${projectStyles.cardEntry}`} href={project.url} target="_blank" rel="noopener noreferrer" aria-label={`独立打开${project.title}（新标签页）`}>
        <MediaCard meta="独立打开 ↗" title={project.title} description={project.description} media={media} />
      </a>
      : <button type="button" className={`content-card ${projectStyles.cardEntry}`} aria-label={`查看${project.title}`}
        onClick={event => { event.currentTarget.focus(); onView(project); }}>
        <MediaCard title={project.title} description={project.description} media={media} />
      </button>;
  }

  function items(rows: WebsiteProject[]) {
    return rows.map(project => ({ id: project.id, title: project.title,
      props: { id: `project-${project.id}`, "data-preview-id": layout !== "catalogue" && project.preview_enabled ? project.id : undefined },
      content: <>
        {layout === "catalogue" ? <button type="button" className={styles.directoryEntry} aria-label={`预览${project.title}`}
          aria-pressed={selected?.id === project.id} aria-controls="project-exhibit" onClick={() => {
            if (!matchMedia(WEBSITE_PREVIEW_MOBILE_QUERY).matches) { setSelectedId(project.id); return; }
            // On narrow screens the exhibit follows the whole directory. Commit
            // the new card before focusing it, including when its link/button changes.
            flushSync(() => setSelectedId(project.id));
            const exhibit = collectionRef.current?.querySelector<HTMLElement>("#project-exhibit");
            exhibit?.querySelector<HTMLElement>(".content-card")?.focus({ preventScroll: true });
            exhibit?.scrollIntoView({ block: "start", behavior: "instant" });
          }}>
          <strong>{project.title}</strong>{project.group_name ? <span>{project.group_name}</span> : null}
        </button> : entry(project)}
        {renderManagement(project)}
      </>,
    }));
  }

  function grid(rows: WebsiteProject[], label = "网站作品") {
    return <SortableGrid section="projects" label={label} className={`content-grid content-grid--wide ${styles.grid} ${layout === "grid" ? "" : styles[layout]}`}
      refreshes={refreshes} items={items(rows)} />;
  }

  return <div ref={collectionRef} className={styles.collection} data-project-layout={layout} data-media-pending={pending ? "" : undefined}>
    {layout === "groups" ? groupWebsiteProjects(projects).map(group => <section className={styles.group} key={group.name} aria-label={group.name}>
      <h2>{group.name}</h2>{grid(group.projects, `${group.name}网站作品`)}
    </section>) : layout === "catalogue" ? <div className={styles.catalogueColumns}>
      {grid(projects)}
      {selected ? <div id="project-exhibit" className={styles.exhibit} data-preview-id={selected.preview_enabled ? selected.id : undefined}>
        <p className="visually-hidden" role="status">当前预览：{selected.title}</p>{entry(selected)}
      </div> : null}
    </div> : grid(projects)}
  </div>;
}
