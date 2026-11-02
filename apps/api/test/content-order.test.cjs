const test = require("node:test");
const assert = require("node:assert/strict");
const { arrange, createContentOrder, readIds } = require("../src/content-order.cjs");

const rows = ids => ids.map((id, index) => ({ id, sort_order: index + 1 }));

test("order input is bounded and free of duplicates", () => {
  assert.deepEqual(readIds([3, 1]), [3, 1]);
  for (const input of [null, "1,2", [1], [1, 1], [0, 1], [1.5, 2], ["1", "2"], Array.from({ length: 1001 }, (_, index) => index + 1)]) {
    assert.throws(() => readIds(input), error => error.statusCode === 400);
  }
});

test("works rearrange within the slots they hold, leaving the rest in place", () => {
  assert.deepEqual(arrange(rows([1, 2, 3, 4, 5]), [5, 3, 1]), [5, 2, 3, 4, 1]);
  assert.throws(() => arrange(rows([1, 2]), [2, 9]), error => error.statusCode === 409);
});

function store(initial) {
  const state = { rows: initial.map(row => ({ ...row })), writes: [] };
  state.request = async (route, options) => {
    if (!options) return { data: state.rows };
    state.writes.push(options.body);
    for (const { id, sort_order } of options.body) state.rows.find(row => row.id === id).sort_order = sort_order;
    return { data: options.body };
  };
  return state;
}

test("only moved rows are written, counting from 1 so new work still leads", async () => {
  const state = store(rows([1, 2, 3, 4]));
  await createContentOrder({ request: state.request }).save("videos", [1, 3, 2, 4]);
  assert.deepEqual(state.writes, [[{ id: 3, sort_order: 2 }, { id: 2, sort_order: 3 }]]);
});

test("a first arrangement numbers everything, including rows it did not show", async () => {
  const state = store([{ id: 3, sort_order: 0 }, { id: 2, sort_order: 0 }, { id: 1, sort_order: 0 }]);
  await createContentOrder({ request: state.request }).save("posts", [2, 3]);
  assert.deepEqual(state.rows.map(({ id, sort_order }) => [id, sort_order]), [[3, 2], [2, 1], [1, 3]]);
});

test("an order already in place writes nothing", async () => {
  const state = store(rows([1, 2]));
  await createContentOrder({ request: state.request }).save("albums", [1, 2]);
  assert.deepEqual(state.writes, []);
});

test("a missing field is reported, because Directus would accept the write and drop it", async () => {
  const request = async () => { throw Object.assign(new Error("forbidden"), { statusCode: 403 }); };
  await assert.rejects(createContentOrder({ request }).save("posts", [1, 2]), error => error.statusCode === 409 && /setup:cms-schema/.test(error.message));
});

test("a write the CMS does not echo back is never reported as saved", async () => {
  const state = store(rows([1, 2]));
  const request = async (route, options) => (options ? { data: [] } : state.request(route));
  await assert.rejects(createContentOrder({ request }).save("projects", [2, 1]), error => error.statusCode === 502);
});
