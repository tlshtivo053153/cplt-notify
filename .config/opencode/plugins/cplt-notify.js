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
    let failures = 0
    const loop = async () => {
      // event bus の一時的失敗で購読が死んでも、次回から鳴るよう購読し直す。壊れたままなら諦める
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            failures = 0
            if (!Object.hasOwn(kindOf, event.type)) continue
            const kind = kindOf[event.type]
            // 通知失敗でセッションを止めない。dir は消されることがあるので毎回作り直す
            await mkdir(dir, { recursive: true }).catch(() => {})
            // symlink先の切詰めを避けるためtmpに書いて同dir内でrenameする。tmp名は並走セッションと被らないようpidで分ける
            const tmp = join(dir, `.${kind}.${process.pid}.tmp`)
            await rm(tmp, { force: true }).catch(() => {})
            await writeFile(tmp, "", { flag: "wx" }).catch((e) => console.error("cplt-notify:", e))
            await rename(tmp, join(dir, kind)).catch(() => rm(tmp, { force: true }).catch(() => {}))
          }
          return
        } catch (e) {
          if (e?.name === "AbortError") return
          failures += 1
          console.error("cplt-notify:", e)
          if (failures >= 10) {
            console.error("cplt-notify: giving up after 10 failures")
            return
          }
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
    void loop()
    return () => controller.abort()
  },
})
