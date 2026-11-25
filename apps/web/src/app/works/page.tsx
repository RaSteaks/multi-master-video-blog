import { getContactSheet } from "@/lib/directus";
import { siteConfig } from "@/lib/site-config";

export const metadata = { title: `作品目录 — ${siteConfig.title}` };

export default async function WorksPage() {
  // Await this list before sending the document. Its ordinary links work without hydration.
  const works = await getContactSheet("direct");
  const emptyMessage = works === null ? "作品目录暂时无法加载，请稍后刷新页面。" : "暂无作品。";
  return (
    <main className="shell page-stack">
      <header className="page-header"><h1>作品目录</h1></header>
      {works?.length ? (
        <div className="content-glass markdown-body">
          <ul>
            {works.map(work => <li key={work.key}><a href={work.href}>{work.title}</a></li>)}
          </ul>
        </div>
      ) : <p className="empty-state">{emptyMessage}</p>}
    </main>
  );
}
