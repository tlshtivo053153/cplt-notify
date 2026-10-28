import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, rm, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// plugin の subagent 除外だけを検証する。依存: node のみ。使い方: node --test tests/parent-filter.test.mjs
// 本物の @opencode/plugin は無いので stub を temp に置き、plugin 実物をコピーして読み込む。
// HOME を temp に向けることで spool 先も隔離する(homedir() は $HOME を見る)。

let plugin
let spool
let tmpRoot
let origHome

async function run(events, sessions) {
  const cleanups = []
  const ctx = {
    event: {
      async *subscribe() {
        for (const e of events) yield e
      },
    },
    session: {
      get: async ({ sessionID }) => {
        if (!Object.hasOwn(sessions, sessionID)) throw new Error("not found: " + sessionID)
        return sessions[sessionID]
      },
    },
  }
  cleanups.push(plugin.setup(ctx))
  // 固定待ちだと遅い環境で取こぼすので、最初の書込が出るまで待ってから少し集める。陰性は何も出ないまま上限まで待つ
  const end = Date.now() + 500
  for (;;) {
    if ((await readdir(spool).catch(() => [])).length) break
    if (Date.now() > end) break
    await new Promise((r) => setTimeout(r, 50))
  }
  await new Promise((r) => setTimeout(r, 300))
  cleanups.forEach((fn) => fn?.())
  return new Set(await readdir(spool).catch(() => []))
}

// 陽性assert用: 固定待ちではなく書込が出るまで待つ(遅延環境の偽陰性防止)。陰性はrun()内のgrace待ち後に判定
async function waitFor(name, timeout = 5000) {
  const end = Date.now() + timeout
  for (;;) {
    if ((await readdir(spool).catch(() => [])).includes(name)) return true
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

// 陰性assert用: grace期間中に一度でも書込が出たら偽陽性なので即失敗
async function waitAbsent(name, timeout = 1000) {
  const end = Date.now() + timeout
  for (;;) {
    if ((await readdir(spool).catch(() => [])).includes(name)) return false
    if (Date.now() > end) return true
    await new Promise((r) => setTimeout(r, 50))
  }
}

test.before(async () => {
  origHome = process.env.HOME
  const t = await mkdtemp(join(tmpdir(), "cplt-parent-"))
  tmpRoot = t
  const home = join(t, "home")
  await mkdir(join(t, "plugin", "node_modules", "@opencode", "plugin"), { recursive: true })
  await writeFile(
    join(t, "plugin", "node_modules", "@opencode", "plugin", "package.json"),
    JSON.stringify({ name: "@opencode/plugin", version: "0.0.0-stub", type: "module", main: "index.js" }),
  )
  await writeFile(
    join(t, "plugin", "node_modules", "@opencode", "plugin", "index.js"),
    "export const Plugin = { define: (o) => o }\n",
  )
  const src = await readFile(new URL("../.config/opencode/plugins/cplt-notify.js", import.meta.url))
  await writeFile(join(t, "plugin", "cplt-notify.js"), src)
  process.env.HOME = home
  assert.equal(homedir(), home, "homedir() must follow $HOME for spool isolation")
  plugin = (await import(pathToFileURL(join(t, "plugin", "cplt-notify.js")).href)).default
  spool = join(home, ".cache", "cplt", "notify")
})

test.after(async () => {
  process.env.HOME = origHome
  await rm(tmpRoot, { recursive: true, force: true })
})

const main = { id: "main", parentID: null }
const sub = { id: "sub", parentID: "main" }

test("top-level succeeded notifies", async () => {
  await rm(spool, { recursive: true, force: true })
  await run([{ type: "session.execution.succeeded", data: { sessionID: "main" } }], { main })
  assert.ok(await waitFor("done"), "main done must be written")
})

test("subagent succeeded is silent", async () => {
  await rm(spool, { recursive: true, force: true })
  await run([{ type: "session.execution.succeeded", data: { sessionID: "sub" } }], { main, sub })
  assert.ok(await waitAbsent("done"), "subagent done must not be written")
})

test("subagent failed is silent, top-level failed notifies", async () => {
  await rm(spool, { recursive: true, force: true })
  await run([{ type: "session.execution.failed", data: { sessionID: "sub" } }], { main, sub })
  assert.ok(await waitAbsent("error"), "subagent error must not be written")
  await run([{ type: "session.execution.failed", data: { sessionID: "main" } }], { main, sub })
  assert.ok(await waitFor("error"), "main error must be written")
})

test("lookup failure notifies (fail-open for main)", async () => {
  await rm(spool, { recursive: true, force: true })
  await run([{ type: "session.execution.succeeded", data: { sessionID: "gone" } }], { main })
  assert.ok(await waitFor("done"), "unknown session must still notify")
})

test("missing session API notifies (fail-open)", async () => {
  await rm(spool, { recursive: true, force: true })
  const noSession = {
    event: {
      async *subscribe() {
        yield { type: "session.execution.succeeded", data: { sessionID: "main" } }
      },
    },
  }
  const done = plugin.setup(noSession)
  assert.ok(await waitFor("done"), "absent ctx.session must still notify")
  done?.()
})

test("permission/question stay immediate even for subagents", async () => {
  await rm(spool, { recursive: true, force: true })
  const files = await run(
    [
      { type: "permission.asked", data: { sessionID: "sub" } },
      { type: "form.created", data: { form: { sessionID: "sub" } } },
    ],
    { main, sub },
  )
  assert.ok(files.has("permission"), "subagent permission must still notify")
  assert.ok(files.has("question"), "subagent question must still notify")
})

test("event without sessionID notifies (fail-open)", async () => {
  await rm(spool, { recursive: true, force: true })
  await run([{ type: "session.execution.succeeded", data: {} }], { main })
  assert.ok(await waitFor("done"), "missing sessionID must still notify")
})

test("sync lookup throw neither silences nor kills the loop", async () => {
  await rm(spool, { recursive: true, force: true })
  const throwing = {
    event: {
      async *subscribe() {
        yield { type: "session.execution.succeeded", data: { sessionID: "boom" } }
        yield { type: "session.execution.succeeded", data: { sessionID: "main" } }
      },
    },
    session: {
      get: ({ sessionID }) => {
        if (sessionID === "boom") throw new Error("sync boom")
        return Promise.resolve(main)
      },
    },
  }
  const done = plugin.setup(throwing)
  assert.ok(await waitFor("done"), "loop must survive a sync lookup throw and notify main")
  done?.()
})

test("malformed event neither silences nor kills the loop", async () => {
  await rm(spool, { recursive: true, force: true })
  const mixed = {
    event: {
      async *subscribe() {
        yield null
        yield undefined
        yield { type: "session.execution.succeeded", data: { sessionID: "main" } }
      },
    },
    session: { get: async () => main },
  }
  const done = plugin.setup(mixed)
  assert.ok(await waitFor("done"), "loop must skip a malformed event and notify main")
  done?.()
})

test("keeps retrying bus failures with backoff", async () => {
  const origSetTimeout = global.setTimeout
  const delays = []
  global.setTimeout = (fn, ms, ...a) => {
    delays.push(ms)
    return origSetTimeout(fn, 5, ...a)
  }
  try {
    let calls = 0
    const failing = {
      event: {
        async *subscribe() {
          calls += 1
          throw new Error("bus down")
        },
      },
    }
    const done = plugin.setup(failing)
    try {
      const end = Date.now() + 5000
      while (calls < 35 && Date.now() < end) await new Promise((r) => origSetTimeout(r, 50))
      assert.ok(calls >= 35, `bus must be retried past 10 without giving up (got ${calls})`)
      for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], "backoff must not shrink")
      assert.equal(delays.at(-1), 30000, "backoff must cap at 30s")
    } finally {
      done?.()
    }
  } finally {
    global.setTimeout = origSetTimeout
  }
})

test("resubscribes after a clean bus end", async () => {
  await rm(spool, { recursive: true, force: true })
  const origSetTimeout = global.setTimeout
  global.setTimeout = (fn, ...a) => origSetTimeout(fn, 5, ...a.slice(1))
  try {
    let calls = 0
    let yielded = false
    const twoShot = {
      event: {
        async *subscribe() {
          calls += 1
          if (yielded) return
          yielded = true
          yield { type: "session.execution.succeeded", data: { sessionID: "main" } }
        },
      },
      session: { get: async () => main },
    }
    const done = plugin.setup(twoShot)
    try {
      assert.ok(await waitFor("done"), "must resubscribe after a clean bus end")
      const end2 = Date.now() + 5000
      while (calls < 2 && Date.now() < end2) await new Promise((r) => origSetTimeout(r, 20))
      assert.ok(calls >= 2, `bus must be subscribed again (calls=${calls})`)
    } finally {
      done?.()
    }
    await new Promise((r) => origSetTimeout(r, 100))
  } finally {
    global.setTimeout = origSetTimeout
  }
})

test("skips spool dir symlink", async () => {
  await rm(spool, { recursive: true, force: true })
  await mkdir(join(tmpRoot, "home", ".cache", "cplt"), { recursive: true })
  const target = join(tmpRoot, "link-target")
  await mkdir(target, { recursive: true })
  await symlink(target, spool)
  try {
    const files = await run([{ type: "session.execution.succeeded", data: { sessionID: "main" } }], { main })
    assert.ok(!files.has("done"), "symlink spool dir must not be written")
    assert.deepStrictEqual(await readdir(target), [], "symlink target must stay empty")
  } finally {
    await rm(spool, { force: true })
  }
})

test("skips symlinked spool parent", async () => {
  await rm(spool, { recursive: true, force: true })
  const cplt = join(tmpRoot, "home", ".cache", "cplt")
  await mkdir(cplt, { recursive: true })
  const target = join(tmpRoot, "parent-target")
  await mkdir(target, { recursive: true })
  await rm(cplt, { recursive: true, force: true })
  await symlink(target, cplt)
  try {
    const files = await run([{ type: "session.execution.succeeded", data: { sessionID: "main" } }], { main })
    assert.ok(!files.has("done"), "symlinked parent must not be written")
    assert.deepStrictEqual(await readdir(target), [], "symlink target must stay empty")
  } finally {
    await rm(cplt, { force: true })
  }
})

test("retries after a transient rename failure", async () => {
  await rm(spool, { recursive: true, force: true })
  // stub fs: fail the first rename with ENOENT, then use the real one
  await writeFile(
    join(tmpRoot, "plugin", "stub-fs.mjs"),
    'export * from "node:fs/promises";\nimport { rename as realRename } from "node:fs/promises";\nlet once = false;\nexport async function rename(a, b) {\n  if (!once) { once = true; const e = new Error("transient ENOENT"); e.code = "ENOENT"; throw e; }\n  return realRename(a, b);\n}\n',
  )
  const src = await readFile(join(tmpRoot, "plugin", "cplt-notify.js"), "utf8")
  assert.ok(src.includes('from "node:fs/promises"'), "plugin must import node:fs/promises")
  await writeFile(join(tmpRoot, "plugin", "cplt-notify-retry.js"), src.replace('from "node:fs/promises"', 'from "./stub-fs.mjs"'))
  const retryPlugin = (await import(pathToFileURL(join(tmpRoot, "plugin", "cplt-notify-retry.js")).href)).default
  const stop = retryPlugin.setup({
    event: {
      async *subscribe() {
        yield { type: "session.execution.succeeded", data: { sessionID: "main" } }
      },
    },
    session: { get: async () => main },
  })
  try {
    assert.ok(await waitFor("done"), "retry must still write done after transient rename failure")
  } finally {
    stop?.()
  }
})
