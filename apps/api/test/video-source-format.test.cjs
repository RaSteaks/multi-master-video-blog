const test = require("node:test");
const assert = require("node:assert/strict");
const { sourceFormatPatches } = require("../../../scripts/backfill-video-source-formats.cjs");
const { sourceFormatFromProbe } = require("../../../shared/video-source-format.cjs");

test("backfill preserves source identity across an IMF HDR10/SDR pair without changing playback", () => {
  const rows=[{id:1,type:"hdr10",source_sha256:"same-source",source_probe_json:{codec_name:"jpeg2000",pix_fmt:"rgb48le",bits_per_raw_sample:"12",color_primaries:"smpte432",color_transfer:"smpte2084",imf:{hasDolbyMetadata:true}}},
    {id:2,type:"sdr",source_sha256:"same-source",derived_from_master_id:1,source_probe_json:{codec_name:"hevc",pix_fmt:"yuv420p10le",color_transfer:"smpte2084"}}];
  const original=JSON.stringify(rows);
  const patches=sourceFormatPatches(rows);
  assert.equal(patches.length,2);
  for(const patch of patches){assert.equal(patch.source_format.container,"imf");assert.equal(patch.source_format.dolbyVision.status,"declared");assert.equal(patch.source_format.dolbyVision.playbackUse,"not_applied");assert.deepEqual(Object.keys(patch),["id","source_format"]);}
  assert.equal(JSON.stringify(rows),original);
  assert.equal(sourceFormatPatches(rows.map((row,i)=>({...row,source_format:patches[i].source_format}))).length,0);
  assert.equal(sourceFormatPatches([{...rows[0],source_sha256:"replacement"},rows[1]]).length,1);
});

test("missing or malformed old probes remain unknown, and cycles do not recurse forever", () => {
  assert.deepEqual(sourceFormatPatches([{id:1,source_probe_json:"invalid"},{id:2,derived_from_master_id:3},{id:3,derived_from_master_id:2}]),[]);
  assert.equal(sourceFormatFromProbe({codec_name:"h264",pix_fmt:"yuv420p",color_transfer:"bt709"}).bitDepth,8);
});

test("backfill CLI previews by default and applies only missing source_format fields", async t => {
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
  const exec=require('node:util').promisify(require('node:child_process').execFile);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-format-cli-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const rows=[{id:1,type:'hdr10',hls_url:'/original.m3u8',source_sha256:'original',source_format:null,
    source_probe_json:{codec_name:'jpeg2000',pix_fmt:'rgb48le',bits_per_raw_sample:'12',color_transfer:'smpte2084',imf:{hasDolbyMetadata:true}}}];
  const writes=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const url=new URL(req.url,'http://fixture');
    let data;
    if(url.pathname==='/auth/login')data={access_token:'fixture'};
    else if(req.method==='PATCH'){
      const patch=JSON.parse(body);writes.push(patch);Object.assign(rows[0],patch);data=rows[0];
    } else data=url.pathname.endsWith('/1')?rows[0]:rows;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const envPath=path.join(root,'.env');await fs.writeFile(envPath,'ADMIN_EMAIL=fixture\nADMIN_PASSWORD=fixture\n');
  const env={...process.env,DIRECTUS_ENV_PATH:envPath,DIRECTUS_URL:`http://127.0.0.1:${server.address().port}`,ADMIN_EMAIL:'fixture',ADMIN_PASSWORD:'fixture'};
  const script=path.resolve(__dirname,'../../../scripts/backfill-video-source-formats.cjs');
  assert.match((await exec(process.execPath,[script],{env})).stdout,/would_update/);
  assert.equal(writes.length,0);
  assert.match((await exec(process.execPath,[script,'--apply'],{env})).stdout,/1 records updated/);
  assert.deepEqual(Object.keys(writes[0]),['source_format']);assert.equal(rows[0].type,'hdr10');assert.equal(rows[0].hls_url,'/original.m3u8');
  await exec(process.execPath,[script,'--apply'],{env});assert.equal(writes.length,1);
});
