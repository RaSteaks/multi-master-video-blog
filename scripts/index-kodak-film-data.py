"""Rebuild Kodak indexes and verify original PDF bytes; run after collector."""
import importlib.util, json, hashlib, re
from pathlib import Path
from os.path import relpath
spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect-kodak-film-data.py'))
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
overrides=json.loads((c.INDEX/'overrides.json').read_text('utf8')) if (c.INDEX/'overrides.json').exists() else {}
p=c.INDEX/'manifest.json'; m=json.loads(p.read_text('utf8')); unique={}
for d in m['documents']:
 if d['status']!='downloaded': continue
 file=c.ROOT/d['local_pdf']; data=file.read_bytes()
 assert hashlib.sha256(data).hexdigest()==d['sha256'],file
 c.fitz.TOOLS.mupdf_warnings(reset=True)
 with c.fitz.open(file) as pdf:
  assert len(pdf)==d['pages'] and len(pdf)>0,file
  first=pdf[0].get_text(); heading=' '.join(first.splitlines()[:12])
  d['first_page_excerpt']=c.clean(first[:700])
  context=' '.join(x['name'] for x in d.get('model_records',[]))+' '+c.slug(d['url'])
  cat=c.category(context)
  if cat=='reference-and-unclassified': cat=c.category(heading)
  if re.search(r'paper|chemicals|developer|safelight|file.format',heading,re.I) and not re.search(r'film\b',heading,re.I): cat='reference-and-unclassified'
  if '/motionpicture/' in d['url'] or any('/motion/product/' in u for u in d['discovered_on']):
   cat='specialty-and-post' if '/post/' in ' '.join(d['discovered_on']) else 'motion-picture'
  d['category']=cat
  d['curve_heading_pages']=[i+1 for i,page in enumerate(pdf) if re.search(r'characteristic\s+curves?|sensitometric\s+curves?|spectral\s+dye\s+density',page.get_text(),re.I)]
  d['parser_warnings']=c.fitz.TOOLS.mupdf_warnings(reset=True)
 review=overrides.get(d['sha256'][:12])
 if review:
  d['visual_review']=review; d['first_page_excerpt']=review['title']; cat=review['category']; d['category']=cat
 target=c.ASSETS/cat/file.name
 assert file.resolve().is_relative_to(c.ASSETS.resolve()) and target.resolve().is_relative_to(c.ASSETS.resolve())
 if file!=target:
  target.parent.mkdir(parents=True,exist_ok=True)
  if not target.exists(): target.write_bytes(data)
 d['local_pdf']=target.relative_to(c.ROOT).as_posix()
 if d['sha256'] not in unique or d['source_kind']=='official-host': unique[d['sha256']]=d
for d in m['documents']:
 if d['status']=='downloaded': d['local_pdf']=unique[d['sha256']]['local_pdf']; d['category']=unique[d['sha256']]['category']
referenced={str((c.ROOT/d['local_pdf']).resolve()) for d in unique.values()}
for file in c.ASSETS.glob('*/*.pdf'):
 assert file.resolve().is_relative_to(c.ASSETS.resolve())
 if str(file.resolve()) not in referenced and hashlib.sha256(file.read_bytes()).hexdigest() in unique: file.unlink()
c.write_indexes(m)
def esc(v): return c.clean(str(v)).replace('|','/').replace('[','(').replace(']',')')
def link(d): return '[PDF](<'+Path(relpath(c.ROOT/d['local_pdf'],c.INDEX)).as_posix()+'>)'
rows={}
for d in m['documents']:
 for r in d.get('model_records',[]): rows.setdefault((r['name'],r.get('film_code','')),[]).append((r,d))
lines=['# 柯达型号与版本索引','','## 历史索引中的型号','','保留来源名称和感光度标签；同名不同年代的乳剂不合并为同一技术参数。本表只列明确的型号记录，电影及特殊胶片另见下方文件索引。','','| 型号 | 胶片代码 | 感光度标签 | 版本与文件 |','|---|---|---|---|']
for (name,code),entries in sorted(rows.items(),key=lambda x:x[0][0].lower()):
 versions=sorted(set(esc(r.get('publication',''))+' '+esc(r.get('edition_label',''))+' '+(link(d) if d['status']=='downloaded' else '[下载失败]('+d['url']+')') for r,d in entries))
 lines.append('| '+esc(name)+' | '+esc(code)+' | '+esc('/'.join(sorted(set(r.get('nominal_speed_label','') for r,d in entries))))+' | '+'; '.join(versions)+' |')
lines += ['','## 全部文件：首页信息与曲线定位','','首页节选仅为自动检索线索，可能包含版权或导言。曲线页检索英文曲线标题；未识别不代表没有曲线。','','| 分类 | 来源标签 / 文件名 | 首页节选 | 曲线标题页 | 文件 |','|---|---|---|---|---|']
for d in sorted(unique.values(),key=lambda d:(d['category'],d['first_page_excerpt'].lower())):
 lines.append('| '+d['category']+' | '+esc(' / '.join(d['labels'][:2]) or c.slug(d['url']))+' | '+esc(d['first_page_excerpt'][:250])+' | '+', '.join(map(str,d['curve_heading_pages']))+' | '+link(d)+' |')
(c.INDEX/'MODELS.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
lines=['# 来源网页与覆盖缺口','','网页存在不等于取得该型号的完整密度数据；关联 PDF 可能为系列共用手册。','','| 来源网页 | 状态 | 快照 | 关联成功 PDF 数 |','|---|---|---|---:|']
for page in m['pages']:
 count=len({d['sha256'] for d in m['documents'] if d['status']=='downloaded' and page['url'] in d['discovered_on']})
 lines.append('| ['+esc(page['url'].split('/en/')[-1])+']('+page['url']+') | '+page['status']+' | '+('[HTML 源码快照]('+page['snapshot']+')' if page.get('snapshot') else esc(page.get('error','')))+' | '+str(count)+' |')
lines += ['','## 尚未完整覆盖','','- 早期卷片、地区命名、OEM 分装、科研/工业/医疗及军用特殊乳剂可能缺资料；未声称收齐历史全部型号。','- 历史 EKTAPAN 与新 EKTAPAN 系列须分别核对年代；EKTACOLOR PRO 与 PORTRA 等系列间的关系不凭名称或感光度推断。','- 官网产品页未链接 PDF 的型号保留网页快照，不从类似胶片补造密度曲线。','- 404、访问限制、非 PDF 响应保留于完整清单；旧官网链接失效时，镜像可能仍提供原文。','- 部分文件为产品指南、处理手册或综合数据书；文件数量不等于型号数量。','- COLORPLUS 200：本次未找到可成功保存且明确对应该型号的完整密度数据表，不用 GOLD 200 或 KODACOLOR 200 曲线代替。','- 本次保存原始曲线图，未人工数字化为 D-logH 数组，也未生成扫描器校准参数。']
(c.INDEX/'SOURCES.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
f=c.INDEX/'README.md'; s=f.read_text('utf8').replace('## 使用方式','## 快速导航\n\n- [型号、版本与曲线页索引](MODELS.md)\n- [来源网页与覆盖缺口](SOURCES.md)\n- [检索与复现说明](METHOD.md)\n\n## 使用方式'); f.write_text(s,encoding='utf8')
report={'unique_pdfs_validated':len(unique),'historical_name_code_groups':len(rows),'pdfs_with_curve_heading':sum(bool(d['curve_heading_pages']) for d in unique.values()),'official_host_unique_pdfs':sum(d['source_kind']=='official-host' for d in unique.values()),'parser_warning_files':[d['local_pdf'] for d in unique.values() if d.get('parser_warnings')],'no_kodak_text':[d['local_pdf'] for d in unique.values() if not d.get('kodak_text_detected')]}
(c.INDEX/'validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8'); print(json.dumps(report,ensure_ascii=False))
