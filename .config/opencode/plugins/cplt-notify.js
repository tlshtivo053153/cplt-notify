import { Plugin } from "@opencode/plugin"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const dir = join(homedir(), ".cache", "cplt", "notify")

const kindOf = {
  // V2 でサーバーに流れるのは execution 系。session.idle は TUI 側にしか出ない。
  "session.execution.succeeded": "done",
  "permission.asked": "permission",
  "form.created": "question",
  "session.execution.failed": "error",
}

export default Plugin.define({
  id: "cplt-notify",
  setup(ctx) {
    const controller = new AbortController()
    void (async () => {
      // writeFile はディレクトリを作らないため、無い環境では無言で全通知が失敗する
      await mkdir(dir, { recursive: true })
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const kind = kindOf[event.type]
        if (!kind) continue
        // 通知失敗でセッションを止めない。dir は消されることがあるので毎回作り直す
        await mkdir(dir, { recursive: true }).catch(() => {})
        await writeFile(join(dir, kind), "").catch((e) => console.error("cplt-notify:", e))
      }
    })().catch((e) => {
      if (e?.name !== "AbortError") console.error("cplt-notify:", e)
    })
    return () => controller.abort()
  },
})
