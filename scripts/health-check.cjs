const checks = [
  ["frontend", "http://127.0.0.1:3000"],
  ["directus", "http://127.0.0.1:8055/server/health"],
  ["upload_api", "http://127.0.0.1:8060/health"],
  ["test_hls", "http://127.0.0.1:3000/media/api-upload-test/sdr/master.m3u8"]
];

async function check(name, url) {
  const started = Date.now();

  try {
    const response = await fetch(url);
    const elapsed = Date.now() - started;

    if (!response.ok) {
      return {
        name,
        ok: false,
        status: response.status,
        elapsed
      };
    }

    return {
      name,
      ok: true,
      status: response.status,
      elapsed
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error.message,
      elapsed: Date.now() - started
    };
  }
}

async function main() {
  const results = await Promise.all(checks.map(([name, url]) => check(name, url)));

  for (const result of results) {
    const status = result.ok ? "ok" : "failed";
    const detail = result.status ? `status=${result.status}` : `error=${result.error}`;
    console.log(`${result.name}=${status} ${detail} elapsed=${result.elapsed}ms`);
  }

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
