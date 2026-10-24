import { Plugin } from "@opencode/plugin"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
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
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const kind = kindOf[event.type]
        if (!kind) continue
        // 通知失敗でセッションを止めない。dir は消されることがあるので毎回作り直す
        await mkdir(dir, { recursive: true }).catch(() => {})
        // symlink先の切詰めを避けるためtmpに書いて同dir内でrenameする
        const tmp = join(dir, `.${kind}.tmp`)
        await rm(tmp, { force: true }).catch(() => {})
        await writeFile(tmp, "", { flag: "wx" }).catch((e) => console.error("cplt-notify:", e))
        await rename(tmp, join(dir, kind)).catch(() => {})
      }
    })().catch((e) => {
      if (e?.name !== "AbortError") console.error("cplt-notify:", e)
    })
    return () => controller.abort()
  },
})
