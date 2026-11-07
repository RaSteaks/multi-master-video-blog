// One persisted vocabulary shared by the CMS schema, API and author controls.
const PROJECT_LAYOUTS = [
  { value: "grid", label: "双列展示", description: "保留原有双列大预览。" },
  { value: "catalogue", label: "目录与展台", description: "左侧选择项目，右侧集中展示。" },
  { value: "mosaic", label: "拼贴展墙", description: "宽窄卡片交错排列。" },
  { value: "alternating", label: "图文交替", description: "预览与介绍左右交替。" },
  { value: "masonry", label: "错落瀑布", description: "不同画幅的卡片错落陈列。" },
  { value: "groups", label: "分组陈列", description: "按照作者填写的展示分组排列。" },
  { value: "dual", label: "双主推", description: "突出前两项，其余作品紧凑展示。" },
];

function isProjectLayout(value) {
  return PROJECT_LAYOUTS.some(layout => layout.value === value);
}

function readProjectLayout(value) {
  // Existing singleton records have no selection until the author saves one.
  if (value == null) return "grid";
  if (!isProjectLayout(value)) throw new Error("实验室布局无效，请重新选择模板。");
  return value;
}

module.exports = { PROJECT_LAYOUTS, isProjectLayout, readProjectLayout };
