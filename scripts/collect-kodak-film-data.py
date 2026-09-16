"""Collect Kodak film source documents; retain provenance and original PDF bytes.
Run from repository root: python scripts/collect-kodak-film-data.py
No product-status or curve calibration is inferred from a download.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, re, time
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse, unquote
import requests
import fitz

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'docs' / 'kodak-film-data'
ASSETS = ROOT / 'output' / 'pdf' / 'kodak'
HEADERS = {'User-Agent': 'KodakFilmReferenceArchive/1.0 (personal technical-document research)'}
OFFICIAL = ('kodak.com', 'kodakprofessional.com', 'kodakalaris.com', 'kodakmoments.com')
SEEDS = [
 'https://125px.com/techdocs/kodak/',
 'https://125px.com/docs/film/kodak/',
 'https://125px.com/docs/motionpicture/kodak/',
 'https://125px.com/docs/motionpicture/kodak/lab/',
 'https://125px.com/docs/unsorted/kodak/',
 'https://www.kodak.com/en/motion/page/keykode-id-table/',
 'https://www.kodakprofessional.com/en-gb/node/133',
 'https://kodakprofessional.com/photographers/resources',
 'https://www.kodak.com/en/still-film/',
 'https://www.kodak.com/en/motion/products/camera-films/',
 'https://www.kodak.com/en/motion/products/post/intermediate-films/',
 'https://www.kodak.com/en/motion/products/post/print-films/',
 'https://www.kodak.com/en/motion/products/post/',
 'https://www.kodak.com/en/motion/page/filmmaker-resources/',
 'https://www.kodak.com/en/motion/page/chronology-of-film/',
 'https://www.kodak.com/en/advanced-materials/product/aerial-imaging/',
]

def official(url):
 host = urlparse(url).hostname or ''
 return any(host == domain or host.endswith('.'+domain) for domain in OFFICIAL)

def clean(text):
 return re.sub(r'\s+', ' ', text).strip()

class Links(HTMLParser):
 def __init__(self):
  super().__init__(); self.links=[]; self.rows=[]; self.heading=''; self.headbuf=None; self.current=None; self.cells=None; self.cell=None; self.rowlinks=[]
 def handle_starttag(self, tag, attrs):
  attrs=dict(attrs)
  if tag in ('h2','h3','h4'): self.headbuf=[]
  if tag=='tr': self.cells=[]; self.rowlinks=[]
  if tag=='td' and self.cells is not None: self.cell=[]
  if tag=='a' and attrs.get('href'): self.current={'href':attrs['href'],'text':'','section':self.heading}
 def handle_data(self,data):
  if self.headbuf is not None: self.headbuf.append(data)
  if self.cell is not None: self.cell.append(data)
  if self.current is not None: self.current['text']+=data
 def handle_endtag(self,tag):
  if tag in ('h2','h3','h4') and self.headbuf is not None: self.heading=clean(' '.join(self.headbuf)); self.headbuf=None
  if tag=='a' and self.current is not None:
   self.current['text']=clean(self.current['text']); self.links.append(self.current)
   if self.cells is not None: self.rowlinks.append(self.current)
   self.current=None
  if tag=='td' and self.cell is not None: self.cells.append(clean(' '.join(self.cell))); self.cell=None
  if tag=='tr' and self.cells is not None:
   if self.cells: self.rows.append({'cells':self.cells,'links':self.rowlinks,'section':self.heading})
   self.cells=None

def get(url):
 response=requests.get(url, headers=HEADERS, timeout=(12,35))
 response.raise_for_status(); return response

def slug(url):
 name=unquote(Path(urlparse(url).path).name)
 return re.sub(r'[^A-Za-z0-9._-]+','-',name)[:110] or 'document.pdf'

def category(text):
 text=text.lower()
 if re.search(r'aero|aerial|infrared|technical.pan|microfilm|copy.film|duplicating|separation|recording|intermediate|print.film|sound|direct.duplicat',text): return 'specialty-and-post'
 if re.search(r'vision|double.x|tri.x.reversal|plus.x.reversal|exr|52\d\d|72\d\d|7294',text): return 'motion-picture'
 if re.search(r'ektachrome|kodachrome|elite.?chrome|e100|e200',text): return 'still-reversal'
 if re.search(r't.max|tmax|tri.x|plus.x|bw400|black.and.white|panatomic|verichrome|ektapan',text): return 'still-black-and-white'
 if re.search(r'portra|gold|ultra|max.400|max.800|ektar|ektacolor|kodacolor|colorplus|color.plus|pro.image|proimage|supra|royal|vericolor|profoto|color.negative',text): return 'still-color-negative'
 return 'reference-and-unclassified'

def gather(max_pages=100):
 INDEX.mkdir(parents=True,exist_ok=True); (INDEX/'source-pages').mkdir(exist_ok=True)
 manifest_path=INDEX/'manifest.json'
 previous=json.loads(manifest_path.read_text('utf8')) if manifest_path.exists() else {'documents':[]}
 docs={d['url']:d for d in previous['documents']}; pages=[]; model_rows=[]; seen=set(); pending=list(SEEDS)
 extra_path=INDEX/'extra-sources.json'
 extra=json.loads(extra_path.read_text('utf8')) if extra_path.exists() else []
 pending += [d['url'] for d in extra if not urlparse(d['url']).path.lower().endswith('.pdf')]
 def add(url,label,page,model=None):
  url=url.split('#')[0]
  d=docs.setdefault(url,{'url':url,'labels':[],'discovered_on':[],'model_records':[],'source_kind':'official-host' if official(url) else 'third-party-archive','status':'pending'})
  if label and label not in d['labels']: d['labels'].append(label)
  if page and page not in d['discovered_on']: d['discovered_on'].append(page)
  if model and model not in d['model_records']: d['model_records'].append(model)
 for d in extra:
  if urlparse(d['url']).path.lower().endswith('.pdf'): add(d['url'],d.get('title',''),d.get('found_on','manual search'),d.get('model'))
 while pending and len(seen)<max_pages:
  queue=[u for u in dict.fromkeys(pending) if u not in seen]
  batch=queue[:6]; pending=queue[6:]
  if not batch: break
  seen.update(batch)
  def fetch_page(url):
   try:
    response=get(url); parser=Links(); parser.feed(response.text)
    name=hashlib.sha256(url.encode()).hexdigest()[:16]+'.html.txt'; (INDEX/'source-pages'/name).write_text(response.text,encoding='utf8')
    return url,parser,{'url':url,'final_url':response.url,'status':'downloaded','snapshot':'source-pages/'+name}
   except Exception as error: return url,None,{'url':url,'status':'failed','error':str(error)}
  with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
   results=list(pool.map(fetch_page,batch))
  for url,parser,page_record in results:
   pages.append(page_record)
   if parser is None: continue
   for row in parser.rows:
    cells=row['cells']
    if '125px.com/techdocs/kodak' in url and len(cells)==5:
     rowpdfs=[urljoin(url,a['href']) for a in row['links'] if '.pdf' in a['href'].lower() and '/docs/film/kodak/' in a['href']]
     for pdf in set(rowpdfs):
      model={'name':cells[0],'film_code':cells[1],'nominal_speed_label':cells[2],'publication':cells[3],'edition_label':cells[4],'index_section':row['section'],'source':url}
      model_rows.append(model); add(pdf,cells[0]+' / '+cells[3]+' / '+cells[4],url,model)
   for a in parser.links:
    target=urljoin(url,a['href']).split('#')[0]; parsed=urlparse(target); path=parsed.path.lower()
    if parsed.scheme not in ('http','https'): continue
    if path.endswith('.pdf'):
     if '125px.com' in url and not any(part in target for part in ('/docs/film/kodak/','/docs/motionpicture/kodak/','/docs/unsorted/kodak/')): continue
     if '/docs/unsorted/kodak/' in target and not re.match(r'(?:e\d|f\d|en_ti|ti\d|p255|.*film.*)',slug(target),re.I): continue
     add(target,a['text'],url)
    elif official(target) and parsed.hostname and 'kodak.com' in parsed.hostname:
     relevant=(path.startswith('/en/motion/product/') or path.startswith('/en/still-film/product/') or path.startswith('/en/still-film/products/') or path.startswith('/en/motion/products/post/'))
     if relevant and target not in seen: pending.append(target)
  print('discovered',len(seen),'pages;',len(docs),'PDF URLs',flush=True)
 # pages are fetched breadth-first with a queue persisted below by callers if needed
 return {'schema_version':1,'retrieved_at':datetime.now(timezone.utc).isoformat(),'scope':'Kodak film technical sources; current and historical; not a complete product census','pages':pages,'documents':list(docs.values())}

def fetch_download(d):
 if d.get('status')=='downloaded' and (ROOT/d.get('local_pdf','missing')).exists(): return d
 try:
  r=get(d['url'])
  return d, r.content, r.url
 except Exception as error:
  d.update(status='failed',error=str(error),attempted_at=datetime.now(timezone.utc).isoformat())
  return d

def download(result):
 # Called by the main thread: PyMuPDF does not support concurrent threads.
 if isinstance(result, dict): return result
 d, data, final_url = result
 try:
  if b'%PDF-' not in data[:1024]: raise ValueError('Response is not a PDF (HTML or another payload)')
  with fitz.open(stream=data,filetype='pdf') as pdf:
   if pdf.is_encrypted: raise ValueError('Encrypted PDF; no extraction attempted')
   texts=[page.get_text() for page in pdf]
   page_count=len(pdf); pdf_title=pdf.metadata.get('title','')
   first=' '.join(texts[:2]); full='\n\n'.join('=== PAGE '+str(i+1)+' ===\n'+txt for i,txt in enumerate(texts))
  digest=hashlib.sha256(data).hexdigest(); filename=digest[:12]+'-'+slug(d['url'])
  cat=category(' '.join(d.get('labels',[]))+' '+slug(d['url']))
  if cat=='reference-and-unclassified': cat=category(first[:600])
  if '/motionpicture/' in d['url'] and cat=='reference-and-unclassified': cat='motion-picture'
  existing=list(ASSETS.glob('*/'+digest[:12]+'-*'))
  out=existing[0] if existing else ASSETS/cat/filename
  out.parent.mkdir(parents=True,exist_ok=True)
  if not out.exists(): out.write_bytes(data)
  txt=INDEX/'text'/ (digest[:12]+'.txt'); txt.parent.mkdir(exist_ok=True); txt.write_text(full,encoding='utf8')
  density_pages=[i+1 for i,t in enumerate(texts) if re.search(r'characteristic.curve|sensitometr|spectral.dye|density|densitometr',t,re.I)]
  identifiers=sorted(set(re.findall(r'\b(?:E|F|AS|TI|H|CIS|P|Z)-\d{1,5}(?:-\d{1,5})?\b',full)))
  d.update(status='downloaded',final_url=final_url,local_pdf=out.relative_to(ROOT).as_posix(),local_text=txt.relative_to(ROOT).as_posix(),sha256=digest,bytes=len(data),pages=page_count,category=cat,pdf_title=pdf_title,kodak_text_detected=bool(re.search(r'kodak|eastman',full,re.I)),publication_mentions=identifiers,density_keyword_pages=density_pages,text_characters=len(full),downloaded_at=datetime.now(timezone.utc).isoformat())
 except Exception as error: d.update(status='failed',error=str(error),attempted_at=datetime.now(timezone.utc).isoformat())
 return d

def write_indexes(manifest):
 docs=manifest['documents']; good=[d for d in docs if d['status']=='downloaded']; unique={d['sha256']:d for d in good}
 counts={c:sum(1 for d in unique.values() if d['category']==c) for c in sorted({d['category'] for d in unique.values()})}
 manifest['summary']={'pdf_urls':len(docs),'successful_urls':len(good),'unique_pdf_files':len(unique),'failed_urls':len(docs)-len(good),'total_unique_bytes':sum(d['bytes'] for d in unique.values()),'categories':counts}
 (INDEX/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
 models=[]
 for d in docs:
  for model in d.get('model_records',[]): models.append({**model,'document_url':d['url'],'download_status':d['status'],'local_pdf':d.get('local_pdf'),'source_kind':d['source_kind']})
 (INDEX/'models.json').write_text(json.dumps(models,ensure_ascii=False,indent=2),encoding='utf8')
 def md(s): return clean(str(s)).replace('|','/').replace('[','(').replace(']',')')
 lines=['# 柯达胶片资料库','', '原始 PDF、可检索文本与来源清单。自动整理结果须与原文核对；不把文件数量视为胶卷型号数量，不推断现售/停产状态，也不将曲线图自动当作校准 LUT。','',
 '## 归档概况','', '- 更新时间（UTC）：'+manifest['retrieved_at'], '- 成功下载地址：'+str(len(good)), '- 按 SHA-256 去重的 PDF：'+str(len(unique)), '- 未成功下载地址：'+str(len(docs)-len(good)), '- 唯一 PDF 总大小：'+str(round(sum(d['bytes'] for d in unique.values())/1024/1024,2))+' MiB','',
 '## 使用方式','', '- [完整清单 manifest.json](manifest.json)：来源 URL、托管类别、下载状态、SHA-256、页数、文本路径及密度关键词页。','- [型号与版本记录 models.json](models.json)：从历史索引或明确登记项提取的型号、胶片代码、感光度标签及资料版本；不等同于已核验产品普查。','- PDF 保持原始字节，存放在 ../../output/pdf/kodak 对应的项目目录；使用下表链接打开。','- text/ 为按页提取的文本。图片内曲线、扫描版文字可能无法抽取；密度关键词页仅为定位提示。','- official-host 为柯达相关官方域名托管；third-party-archive 为第三方保存的历史文件，需核对 PDF 内的作者与版本。','- 原文件版权归各权利人；本地收集用于技术研究，未公开发布。','', '## 分类目录','']
 for cat in counts:
  lines += ['### '+cat,'','| 文件标题或来源标签 | 托管来源 | 页数 | 密度关键词页 | 本地 PDF |','|---|---|---:|---|---|']
  for d in sorted(unique.values(),key=lambda d:(d['category'],' '.join(d['labels']).lower())):
   if d['category']!=cat: continue
   label=' / '.join(d['labels'][:3]) or slug(d['url'])
   from os.path import relpath
   local=Path(relpath(ROOT/d['local_pdf'],INDEX)).as_posix()
   lines.append('| '+md(label)+' | ['+d['source_kind']+']('+d['url']+') | '+str(d['pages'])+' | '+', '.join(map(str,d['density_keyword_pages']))+' | [PDF](<'+local+'>) |')
  lines.append('')
 lines += ['## 下载失败与待补项','','| 来源 | 错误 |','|---|---|']
 for d in docs:
  if d['status']!='downloaded': lines.append('| ['+md(' / '.join(d['labels'][:2]) or slug(d['url']))+']('+d['url']+') | '+md(d.get('error','pending'))+' |')
 (INDEX/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf8')
 print(json.dumps(manifest['summary'],ensure_ascii=False),flush=True)

def main():
 parser=argparse.ArgumentParser(); parser.add_argument('--discover',action='store_true'); parser.add_argument('--max-pages',type=int,default=100); args=parser.parse_args()
 if args.discover or not (INDEX/'manifest.json').exists(): manifest=gather(args.max_pages); write_indexes(manifest)
 else: manifest=json.loads((INDEX/'manifest.json').read_text('utf8'))
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
  futures={pool.submit(fetch_download,d):i for i,d in enumerate(manifest['documents'])}
  for number,f in enumerate(concurrent.futures.as_completed(futures),1):
   manifest['documents'][futures[f]]=download(f.result())
   if number%20==0: print('downloaded/checked',number,'/',len(futures),flush=True); write_indexes(manifest)
 write_indexes(manifest)
if __name__=='__main__': main()
