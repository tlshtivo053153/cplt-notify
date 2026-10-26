import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from "node:fs/promises"
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
  await new Promise((r) => setTimeout(r, 500))
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
