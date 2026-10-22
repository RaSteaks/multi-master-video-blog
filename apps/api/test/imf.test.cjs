const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { parseXml, identifyImfPackage, inspectImfPackage, hashImfPackage, applyImfColor, buildImfEncode, validateImfOutput } = require("../src/imf.cjs");
const { loadServer } = require("./helpers/imf-server.cjs");
const ffmpeg = process.env.FFMPEG_PATH || require("ffmpeg-static");
const ffprobe = process.env.FFPROBE_PATH || require("ffprobe-static").path;
const id = n => `urn:uuid:00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function fixture(t, real = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imf-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Deliberately misleading filenames: ASSETMAP UUID references must win over heuristics.
  const videoPath = path.join(root, "AUDIO_named_video.mxf"), audioPath = path.join(root, "VIDEO_named_audio.mxf");
  if (real) {
    await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x96:rate=24",
      "-t", "1", "-c:v", "jpeg2000", "-pix_fmt", "rgb48le", "-color_primaries", "smpte432", "-color_trc", "smpte2084", videoPath]);
    await execFile(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
      "-t", "1", "-c:a", "pcm_s24le", "-f", "mxf_opatom", audioPath]);
  } else {
    await fs.writeFile(videoPath, "video"); await fs.writeFile(audioPath, "audio");
  }
  const descriptor = `<RGBADescriptor><PixelLayout>${["Red", "Green", "Blue"].map(c => `<RGBAComponent><Code>Comp${c}</Code><ComponentSize>16</ComponentSize></RGBAComponent>`).join("")}</PixelLayout>
    <ComponentMinRef>0</ComponentMinRef><ComponentMaxRef>65535</ComponentMaxRef>
    <ColorPrimaries>urn:smpte:ul:060e2b34.0401010d.04010101.03060000</ColorPrimaries>
    <TransferCharacteristic>urn:smpte:ul:060e2b34.0401010d.04010101.010a0000</TransferCharacteristic>
    <StoredWidth>160</StoredWidth><StoredHeight>96</StoredHeight><DisplayWidth>160</DisplayWidth><DisplayHeight>80</DisplayHeight><DisplayYOffset>8</DisplayYOffset><ImageAspectRatio>2/1</ImageAspectRatio>
    <MasteringDisplayPrimaries>${[[34000,16000],[13250,34500],[7500,3000]].map(([x,y]) => `<ColorPrimary><X>${x}</X><Y>${y}</Y></ColorPrimary>`).join("")}</MasteringDisplayPrimaries>
    <MasteringDisplayWhitePointChromaticity><X>15635</X><Y>16450</Y></MasteringDisplayWhitePointChromaticity>
    <MasteringDisplayMinimumLuminance>1</MasteringDisplayMinimumLuminance><MasteringDisplayMaximumLuminance>10000000</MasteringDisplayMaximumLuminance></RGBADescriptor>`;
  const resource = (track, encoding, rate, intrinsic, entry, duration) => `<ResourceList><Resource><TrackFileId>${id(track)}</TrackFileId><SourceEncoding>${id(encoding)}</SourceEncoding><EditRate>${rate} 1</EditRate><IntrinsicDuration>${intrinsic}</IntrinsicDuration><EntryPoint>${entry}</EntryPoint><SourceDuration>${duration}</SourceDuration></Resource></ResourceList>`;
  const cpl = `<c:CompositionPlaylist xmlns:c="urn:cpl" xmlns:e="urn:extensions"><Id>${id(1)}</Id><EditRate>24 1</EditRate>
    <EssenceDescriptorList><EssenceDescriptor><Id>${id(10)}</Id>${descriptor}</EssenceDescriptor><EssenceDescriptor><Id>${id(11)}</Id><WAVEPCMDescriptor/></EssenceDescriptor></EssenceDescriptorList>
    <ExtensionProperties><e:MaxCLL>961</e:MaxCLL><e:MaxFALL>34</e:MaxFALL></ExtensionProperties>
    <SegmentList><Segment><SequenceList><MainImageSequence>${resource(2,10,24,24,2,12)}</MainImageSequence><MainAudioSequence>${resource(3,11,48000,48000,4000,24000)}</MainAudioSequence></SequenceList></Segment></SegmentList></c:CompositionPlaylist>`;
  await fs.writeFile(path.join(root, "composition.xml"), cpl);
  const assetMap = `<AssetMap><AssetList>${await Promise.all([[2,videoPath],[3,audioPath],[1,path.join(root,"composition.xml")]].map(async ([n,p]) => `<Asset><Id>${id(n)}</Id><ChunkList><Chunk><Path>${path.basename(p)}</Path><Length>${(await fs.stat(p)).size}</Length></Chunk></ChunkList></Asset>`)).then(a=>a.join(""))}</AssetList></AssetMap>`;
  await fs.writeFile(path.join(root, "ASSETMAP.xml"), assetMap);
  const files = (await fs.readdir(root)).map(filename => ({ filename: `中文文件夹/${filename}`, packagePath: path.join(root,filename) }));
  async function changeCpl(transform) {
    const next = transform(cpl);
    await fs.writeFile(path.join(root,"composition.xml"), next);
    await fs.writeFile(path.join(root,"ASSETMAP.xml"), assetMap.replace(`<Length>${Buffer.byteLength(cpl)}</Length>`, `<Length>${Buffer.byteLength(next)}</Length>`));
  }
  return { root, files, cpl, assetMap, changeCpl, api: loadServer(root, ffmpeg, ffprobe) };
}

test("CPL resolves exact essence UUIDs, RGB range, display window and content light levels", async t => {
  const { files } = await fixture(t);
  const imf = await inspectImfPackage(files);
  assert.match(imf.video.path, /AUDIO_named_video/);
  assert.match(imf.audio.path, /VIDEO_named_audio/);
  assert.deepEqual(imf.crop, { x: 0, y: 8, width: 160, height: 80 });
  assert.equal(imf.depth, 16); assert.equal(imf.primaries, "smpte432");
  assert.equal(imf.maxCLL, 961); assert.equal(imf.maxFALL, 34);
  assert.equal(imf.video.start, 2/24); assert.equal(imf.audio.start, 4000/48000);
});

test("identification reports application, SDR and YCbCr even when conversion is unsupported", async t => {
  const {files,changeCpl}=await fixture(t);
  await changeCpl(s=>s.replace('<ExtensionProperties>', '<ExtensionProperties><ApplicationIdentification>http://www.smpte-ra.org/ns/2067-21/2021</ApplicationIdentification>')
    .replace(/<RGBADescriptor>[\s\S]*?<\/RGBADescriptor>/,`<CDCIDescriptor><ComponentDepth>10</ComponentDepth><BlackRefLevel>64</BlackRefLevel><WhiteRefLevel>940</WhiteRefLevel><ColorPrimaries>urn:smpte:ul:060e2b34.04010106.04010101.03030000</ColorPrimaries><TransferCharacteristic>urn:smpte:ul:060e2b34.04010101.04010101.01020000</TransferCharacteristic></CDCIDescriptor>`));
  const source=await identifyImfPackage(files);
  assert.equal(source.colorModel,'ycbcr');assert.equal(source.dynamicRange,'sdr');assert.equal(source.range,'limited');
  assert.equal(source.primaries,'bt709');assert.equal(source.transfer,'bt709');
  assert.match(source.applicationIds[0],/2067-21/);
  await assert.rejects(inspectImfPackage(files),e=>e.sourceFormat.colorModel==='ycbcr' && /RGBADescriptor/.test(e.message));
});

test("HLG and unknown identifiers are identified without inventing PQ or a Resolve preset",async t=>{
  const {files,changeCpl}=await fixture(t);
  await changeCpl(s=>s.replace('010a0000','010b0000'));
  const hlg=await identifyImfPackage(files);assert.equal(hlg.dynamicRange,'hlg');assert.equal(hlg.preset,null);
  await assert.rejects(inspectImfPackage(files),e=>e.sourceFormat.dynamicRange==='hlg');
  await changeCpl(s=>s.replace('03060000','03ff0000').replace('010a0000','01ff0000'));
  const unknown=await identifyImfPackage(files);assert.equal(unknown.primaries,null);assert.equal(unknown.dynamicRange,'unknown');
});

test("PHDR detection uses descriptor/KLV evidence, never a filename or a payload substring",async t=>{
  const {files,root,changeCpl}=await fixture(t);
  const key=Buffer.from('060e2b34025301050e09060701010103','hex');
  const video=path.join(root,'AUDIO_named_video.mxf');
  await fs.writeFile(video,Buffer.concat([Buffer.from('060e2b34010101010101010101010101','hex'),Buffer.from([16]),key]));
  assert.deepEqual((await identifyImfPackage(files)).dolbyVision.storage,[]);
  await fs.writeFile(video,Buffer.concat([key,Buffer.from([0])]));
  const phdr=await identifyImfPackage(files);
  assert.deepEqual(phdr.dolbyVision.storage,['phdr']);assert.equal(phdr.dolbyVision.validation,'not_validated');
  await fs.writeFile(video,'video');
  await changeCpl(s=>s.replace('</RGBADescriptor>','<SubDescriptors><PHDRMetadataTrackSubDescriptor/></SubDescriptors></RGBADescriptor>'));
  assert.equal((await identifyImfPackage(files)).dolbyVision.status,'candidate');
});

test("external Dolby XML is unlinked and missing assets are reported independently of conversion",async t=>{
  const {files,root}=await fixture(t);
  const xml=path.join(root,'metadata.xml');await fs.writeFile(xml,'<DolbyVision xmlns="http://www.dolby.com/schemas/dvmd-fw/4_0_2"/>');
  const result=await identifyImfPackage([...files.filter(f=>!f.filename.includes('VIDEO_named_audio')), {filename:'中文文件夹/metadata.xml',packagePath:xml}]);
  assert.equal(result.packageKind,'external_references');assert.equal(result.missingResources,1);
  assert.equal(result.dolbyVision.status,'unlinked');assert.deepEqual(result.dolbyVision.storage,['xml']);
});

test("Resolve CM4 and namespace-free CM2.9 sidecars are recognized without claiming validation", async t => {
  const {files,root}=await fixture(t);
  const xml=path.join(root,'metadata.xml');
  const sidecar={filename:'中文文件夹/metadata.xml',packagePath:xml};
  // Match Resolve's MDF roots: CM4 carries its version as a child, CM2.9 as an attribute.
  for(const content of [
    '<DolbyLabsMDF xmlns="http://www.dolby.com/schemas/dvmd/4_0_2"><Version>4.0.2</Version><Outputs><Output><Video/></Output></Outputs></DolbyLabsMDF>',
    '<DolbyLabsMDF version="2.0.5" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><Outputs><Output><Video/></Output></Outputs></DolbyLabsMDF>',
    '<DolbyLabsMDF version="4.0.2" xmlns="http://www.dolby.com/schemas/dvmd/4_0_2"><Version>4.0.2</Version><Outputs><Output><Video>' + ' '.repeat(3*1024*1024) + '</Video></Output></Outputs></DolbyLabsMDF>'
  ]) {
    await fs.writeFile(xml,content);
    const result=await identifyImfPackage([...files,sidecar]);
    assert.equal(result.dolbyVision.status,'unlinked');
    assert.deepEqual(result.dolbyVision.storage,['xml']);
    assert.equal(result.dolbyVision.validation,'not_validated');
  }
});

test("Dolby-like names, foreign namespaces, invalid headers and DTDs do not identify MDF sidecars", async t => {
  const {files,root}=await fixture(t);
  const xml=path.join(root,'DolbyVision.xml');
  for(const content of [
    '<Other version="4.0.2"><Outputs><Output><Video/></Output></Outputs></Other>',
    '<DolbyLabsMDF xmlns="https://example.invalid/dvmd/4_0_2" version="4.0.2"><Outputs><Output><Video/></Output></Outputs></DolbyLabsMDF>',
    '<DolbyLabsMDF><Outputs><Output><Video/></Output></Outputs></DolbyLabsMDF>',
    '<DolbyLabsMDF version="2.0.5"><Other><Video/></Other></DolbyLabsMDF>',
    '<DolbyLabsMDF version="2.0.5"><!-- <Outputs><Output><Video/> --></DolbyLabsMDF>',
    '<DolbyLabsMDF version="2.0.5"><Outputs></Wrong><Output><Video/>',
    '<!DOCTYPE DolbyLabsMDF [<!ENTITY version SYSTEM "file:///etc/passwd">]><DolbyLabsMDF version="2.0.5"><Outputs><Output><Video/></Output></Outputs></DolbyLabsMDF>'
  ]) {
    await fs.writeFile(xml,content);
    const result=await identifyImfPackage([...files,{filename:'中文文件夹/DolbyVision.xml',packagePath:xml}]);
    assert.equal(result.dolbyVision.status,'unknown');
    assert.deepEqual(result.dolbyVision.storage,[]);
  }
});

test("multipart folder paths and Unicode assets remain valid in retained archives on overwrite", async t => {
  const { root, files, assetMap, api } = await fixture(t);
  await fs.rename(path.join(root,"AUDIO_named_video.mxf"),path.join(root,"影像.mxf"));
  await fs.writeFile(path.join(root,"ASSETMAP.xml"),assetMap.replace("AUDIO_named_video.mxf",encodeURIComponent("影像.mxf")));
  const parts=[];
  for(const file of files) {
    const filename=file.filename.replace("AUDIO_named_video.mxf","影像.mxf");
    const data=await fs.readFile(path.join(root,path.basename(filename)));
    parts.push(Buffer.from(`--imf-boundary\r\nContent-Disposition: form-data; name="masterPackage"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),data,Buffer.from("\r\n"));
  }
  parts.push(Buffer.from("--imf-boundary--\r\n"));
  const body=Buffer.concat(parts);
  let previous;
  for(let attempt=0;attempt<2;attempt++) {
    const req=require("node:stream").Readable.from([body]);
    req.headers={"content-type":"multipart/form-data; boundary=imf-boundary"};
    const parsed=await api.parseMultipart(req);
    assert.ok(parsed.files.masterPackage.some(f=>f.originalName==="中文文件夹/影像.mxf"));
    const archived=await api.moveMasterPackageFiles(parsed.files.masterPackage,{sourceKind:"master_package",slug:"archive",overwrite:true});
    assert.match(archived.sourcePath,/中文文件夹[/\\]影像\.mxf$/);
    assert.ok(await inspectImfPackage(archived.files));
    if(previous) { assert.notEqual(archived.packageDir,previous.packageDir); assert.ok(await fs.stat(previous.sourcePath)); }
    previous=archived;
  }
});

test("XML rejects entities, malformed input, unsafe references and duplicate assets", async t => {
  for (const xml of ["<!DOCTYPE a [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><a>&x;</a>", "<a><b></a>", "<a>&unknown;</a>"]) assert.throws(() => parseXml(xml), /IMF:/);
  const { files, root, assetMap } = await fixture(t);
  for (const unsafe of ["../outside.mxf", "%2e%2e/outside.mxf", "https://example.com/video.mxf", "/etc/passwd"]) {
    await fs.writeFile(path.join(root,"ASSETMAP.xml"), assetMap.replace("AUDIO_named_video.mxf", unsafe));
    await assert.rejects(inspectImfPackage(files), /Unsafe asset path/);
  }
  await fs.writeFile(path.join(root,"ASSETMAP.xml"), assetMap.replace(id(3),id(2)));
  await assert.rejects(inspectImfPackage(files), /Duplicate ASSETMAP/);
});

test("incomplete, ambiguous and unsupported compositions fail explicitly", async t => {
  const { files, changeCpl } = await fixture(t);
  for (const [transform, pattern] of [
    [s => s.replace("<ComponentMaxRef>65535", "<ComponentMaxRef>60160"), /full-range/],
    [s => s.replace("<SourceDuration>12", "<SourceDuration>30"), /resource/],
    [s => s.replace("<DisplayYOffset>8", "<DisplayYOffset>90"), /display window/],
    [s => s.replace("<e:MaxCLL>961</e:MaxCLL>", ""), /MaxCLL/],
    [s => s.replace("<SourceEncoding>"+id(10), "<SourceEncoding>"+id(999)), /resolve/],
    [s => s.replace("</SequenceList>", "<MainImageSequence/></SequenceList>"), /MainImageSequence/],
    [s => s.replace("</SegmentList>", "<Segment/></SegmentList>"), /Segment/],
    [s => s.replace("</Resource>", "<RepeatCount>2</RepeatCount></Resource>"), /repeated/]
  ]) { await changeCpl(transform); await assert.rejects(inspectImfPackage(files), pattern); }
  await changeCpl(s => s);
  await assert.rejects(inspectImfPackage(files.filter(f => !f.filename.includes("VIDEO_named_audio"))), /Missing uploaded asset/);
});

test("RGB metadata reconciliation rejects conflicts and retains strict YUV siting validation", async t => {
  const { files, api } = await fixture(t);
  const imf = await inspectImfPackage(files);
  const probe = { codec_name:"jpeg2000",pix_fmt:"rgb48le",width:160,height:96,bits_per_raw_sample:"16",avg_frame_rate:"24/1",duration:"1" };
  const audio = {codec_type:"audio",duration:"1"};
  const enriched = applyImfColor(imf, probe, audio);
  const metadata = {masterType:"hdr10",mode:"copy"};
  const contract = api.buildColorContract(enriched, metadata);
  assert.equal(contract.colorRange,"full"); assert.equal(contract.matrixCoefficients,"gbr"); assert.equal(contract.chromaLocation,null);
  assert.deepEqual([...api.validateColorContract(metadata,contract)],[]);
  assert.ok(api.validateColorContract(metadata,{...contract,pixelFormat:"yuv420p10le"}).some(e=>/chromaLocation/.test(e)));
  for (const conflict of [{color_primaries:"bt2020"},{color_range:"tv"},{bits_per_raw_sample:"12"},{width:1920}]) assert.throws(()=>applyImfColor(imf,{...probe,...conflict},audio),/conflicts/);
  assert.throws(()=>applyImfColor(imf,probe,null),/audio/);
});

test("package identity includes audio/CPL and large non-IMF sidecars keep their existing path", async t => {
  const { files, root } = await fixture(t);
  const initial = await hashImfPackage(files);
  assert.equal(await hashImfPackage([...files].reverse()), initial);
  await fs.writeFile(path.join(root,"VIDEO_named_audio.mxf"),"other");
  assert.notEqual(await hashImfPackage(files),initial);
  const sidecar = path.join(root,"dolby.xml");
  await fs.writeFile(sidecar,"<DolbyVision>" + " ".repeat(3 * 1024 * 1024) + "</DolbyVision>");
  assert.equal(await inspectImfPackage([{filename:"dolby.xml",packagePath:sidecar}]),null);
});

test("P3 PQ pixels are converted in linear light before BT.2020 YCbCr encoding", async t => {
  const { files } = await fixture(t);
  const imf = await inspectImfPackage(files);
  const pq = nits => {
    const p = (nits / 10000) ** (2610 / 16384);
    return ((3424 / 4096 + 2413 / 128 * p) / (1 + 2392 / 128 * p)) ** (2523 / 32);
  };
  const multiply = (a,b) => a.map(row => b[0].map((_,j) => row.reduce((sum,v,k) => sum + v*b[k][j],0)));
  function inverse(m) {
    const [a,b,c]=m[0],[d,e,f]=m[1],[g,h,i]=m[2];
    const det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
    return [[e*i-f*h,c*h-b*i,b*f-c*e],[f*g-d*i,a*i-c*g,c*d-a*f],[d*h-e*g,b*g-a*h,a*e-b*d]].map(row=>row.map(v=>v/det));
  }
  function rgbToXyz(xy) {
    const columns=xy.map(([x,y])=>[x/y,1,(1-x-y)/y]);
    const m=[0,1,2].map(i=>columns.map(c=>c[i]));
    const scale=multiply(inverse(m),[[0.3127/0.329],[1],[(1-0.3127-0.329)/0.329]]);
    return m.map(row=>row.map((v,i)=>v*scale[i][0]));
  }
  // Independent chromaticity calculation catches a relabel, wrong range or
  // nonlinear-light matrix even when every encoded metadata tag looks correct.
  const matrix=multiply(inverse(rgbToXyz([[.708,.292],[.170,.797],[.131,.046]])),rgbToXyz([[.680,.320],[.265,.690],[.150,.060]]));
  const inputNits=[1000,100,10];
  const rgb=multiply(matrix,inputNits.map(v=>[v])).map(row=>pq(row[0]));
  const y=.2627*rgb[0]+.6780*rgb[1]+.0593*rgb[2];
  const expected=[64+876*y,512+896*(rgb[2]-y)/(2*(1-.0593)),512+896*(rgb[0]-y)/(2*(1-.2627))];
  const input=Buffer.alloc(imf.width*imf.height*6);
  for(let i=0;i<input.length/2;i++) input.writeUInt16LE(Math.round(pq(inputNits[i%3])*65535),i*2);
  const {spawnSync}=require("node:child_process");
  const run=spawnSync(ffmpeg,["-v","error","-f","rawvideo","-pixel_format","rgb48le","-video_size",`${imf.width}x${imf.height}`,"-i","pipe:0","-vf",buildImfEncode(imf,"unused.mp4").filter,"-frames:v","1","-f","rawvideo","pipe:1"],{input,timeout:30000});
  assert.ifError(run.error); assert.equal(run.status,0,run.stderr.toString());
  const pixels=imf.crop.width*imf.crop.height;
  const actual=[run.stdout.readUInt16LE(pixels),run.stdout.readUInt16LE(2*pixels+pixels/4),run.stdout.readUInt16LE(2*pixels+pixels/2+pixels/4)];
  actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<2,`Channel ${i}: ${v} vs ${expected[i]}`));
});

test("real RGB MXF plus PCM converts, trims, crops and packages verified HDR10 HLS", async t => {
  const { root, files, api } = await fixture(t, true);
  const imf = await inspectImfPackage(files);
  const probe = applyImfColor(imf, await api.probeVideo(imf.video.path), (await api.probeMediaStreams(imf.audio.path))[0]);
  const output = path.join(root,"output"); await fs.mkdir(output);
  const result = await api.prepareImfPlayback(imf,{masterType:"hdr10",mode:"copy"},probe,output);
  assert.equal(result.finalized.verification.status,"ready");
  assert.deepEqual(validateImfOutput(imf,result.probe,result.contract),[]);
  assert.equal(result.contract.hdrStaticMetadata.contentLightLevel.max_content,961);
  assert.equal(result.contract.hdrStaticMetadata.contentLightLevel.max_average,34);
  assert.equal(result.contract.dolbyMetadata.profile,null);
  const playlist = await fs.readFile(result.finalized.playlistPath,"utf8");
  assert.match(playlist,/VIDEO-RANGE=PQ/); assert.match(playlist,/RESOLUTION=160x80/);
  assert.match(playlist,/hvc1\./); assert.match(playlist,/mp4a\.40\.2/);
  assert.doesNotMatch(playlist,/dvh1|SUPPLEMENTAL-CODECS/);
  const report = JSON.parse(await fs.readFile(path.join(output,"color-verification.json"),"utf8"));
  assert.equal(report.sourceContract.pixelFormat,"rgb48le"); assert.equal(report.sourceContract.width,160);
  assert.equal(report.outputContract.height,80);
  assert.equal(report.verification.conversion.usesDolbyMetadata,false);
  // Decode packaged media too: a plausible playlist/metadata alone is not a working output.
  await api.withLocalHlsInput(path.join(output,"media.m3u8"), input => execFile(ffmpeg,["-v","error","-i",input,"-f","null","-"]));
  const broken = path.join(root,"broken"); await fs.mkdir(broken);
  const originalRun = api.runProcess;
  api.runProcess = async () => { throw new Error("Encoder unavailable"); };
  await assert.rejects(api.prepareImfPlayback(imf,{masterType:"hdr10"},probe,broken),/Encoder unavailable/);
  api.runProcess = originalRun;
  await assert.rejects(fs.stat(broken),{code:"ENOENT"});
  assert.ok((await fs.stat(imf.video.path)).size > 0);
});

test("upload routes IMF to HDR10, archives RGB provenance and sends converted audio to SDR", async t => {
  const { root, files, api } = await fixture(t, true);
  const imf = await inspectImfPackage(files);
  const metadata = {title:"IMF",slug:"imf",label:"Dolby Vision Master",masterType:"dolby_vision",sourceKind:"master_package",mode:"copy",isDefault:true};
  api.requireUploadAuth = () => {};
  api.parseMultipart = async () => ({fields:{},files:{masterPackage:files}});
  api.videoProcessingSlots = {acquire: async () => () => {}};
  api.resolveVideoUploadProject = async () => ({metadata,project:null});
  api.moveMasterPackageFiles = async () => ({imf,files,sidecars:[],sourcePath:imf.video.path,packageDir:root});
  let registered = 0, derivativeCalls = 0, response;
  api.createOrUpdateDirectusRecords = async (meta, source, playlist, probe, _files, sidecar, evidence) => {
    registered++;
    assert.equal(meta.masterType,"hdr10"); assert.equal(meta.label,"HDR10 (IMF)"); assert.equal(meta.processingMode,"transcode");
    assert.equal(source,imf.video.path); assert.equal(probe.pix_fmt,"rgb48le");
    assert.equal(evidence.sourceContract.matrixCoefficients,"gbr");
    assert.equal(evidence.outputContract.pixelFormat,"yuv420p10le");
    assert.equal(evidence.sourceHash,await hashImfPackage(files));
    return {project:{id:1},master:{id:2,type:"hdr10",source_sha256:evidence.sourceHash}};
  };
  api.createDolbySdrMaster = async (meta, source, probe, contract) => {
    derivativeCalls++;
    assert.match(source,/hdr10\.mp4$/); assert.equal(meta.masterType,"hdr10");
    assert.equal(probe.audio_streams[0].codec_name,"aac"); assert.equal(contract.height,80);
    return {status:"ready",master:{id:3,type:"sdr"}};
  };
  api.sendJson = (_res,status,payload) => { response={status,payload}; };
  await api.handleUpload({ headers: {} },{});
  assert.equal(response.status,201,response.payload.error);
  assert.equal(registered,1); assert.equal(derivativeCalls,1);
  assert.equal(response.payload.verification.conversion.intent,"imf_rgb_to_hdr10");
  assert.equal(response.payload.masters.length,2);
});
