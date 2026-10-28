import { Plugin } from "@opencode/plugin"
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const spoolDir = () => join(process.env.HOME || homedir(), ".cache", "cplt", "notify")

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
    // 中断されたらすぐ起きる待ち。破棄時に最大30秒引き留めない
    const sleep = (ms) =>
      new Promise((r) => {
        if (controller.signal.aborted) return r()
        const off = () => {
          clearTimeout(t)
          controller.signal.removeEventListener("abort", off)
          r()
        }
        const t = setTimeout(off, ms)
        controller.signal.addEventListener("abort", off, { once: true })
      })
    const loop = async () => {
      // event bus の一時的失敗で購読が死んでも、次回から鳴るよう購読し直す。壊れたままなら待ちを伸ばして続ける
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            failures = 0
            if (!Object.hasOwn(kindOf, event.type)) continue
            const kind = kindOf[event.type]
            if (kind === "done" || kind === "error") {
              // subagent(子セッション)の完了では鳴らさない。親なしトップレベルの完了だけ残す
              // permission/question は即時のまま
              // shortcut: fork が将来 parentID を持つようになったら fork 完了が無音になる。その時は child-session 判定に切替える
              try {
                const sessionID = event.data?.sessionID
                if (sessionID && ctx.session?.get) {
                  if ((await ctx.session.get({ sessionID }))?.parentID) continue
                }
              } catch {
                // 照会失敗時は鳴らす側に倒す(main の取りこぼし防止)。bus 失敗回数には数えない
              }
            }
            // 通知失敗でセッションを止めない。dir は消されることがあるので毎回作り直す
            // watcher と同じく symlink 先には書かない
            const dir = spoolDir()
            if ((await lstat(dir).catch(() => null))?.isSymbolicLink()) {
              console.error("cplt-notify: refusing symlink spool dir")
              continue
            }
            await mkdir(dir, { recursive: true }).catch(() => {})
            // symlink先の切詰めを避けるためtmpに書いて同dir内でrenameする。固定名にして異常終了時のゴミを次回消せるようにする(同時書込はwatcher側の絞り込みで1回分に潰れる)
            const tmp = join(dir, `.${kind}.tmp`)
            await rm(tmp, { force: true }).catch(() => {})
            await writeFile(tmp, "", { flag: "wx" }).catch((e) => {
              if (e?.code !== "EEXIST") console.error("cplt-notify:", e)
            })
            await rename(tmp, join(dir, kind)).catch(async () => {
              // dir が処理中に消されると tmp ごと消えるので、作り直して書き直してから一度だけ再試行する
              if ((await lstat(dir).catch(() => null))?.isSymbolicLink()) return
              await mkdir(dir, { recursive: true }).catch(() => {})
              await rm(tmp, { force: true }).catch(() => {})
              await writeFile(tmp, "", { flag: "wx" }).catch((e) => {
                if (e?.code !== "EEXIST") console.error("cplt-notify:", e)
              })
              await rename(tmp, join(dir, kind)).catch(() => rm(tmp, { force: true }).catch(() => {}))
            })
          }
          // bus が正常終了しても購読し直す(空回りを避けるため1秒待つ)
          if (controller.signal.aborted) return
          failures = 0
          await sleep(1000)
        } catch (e) {
          if (e?.name === "AbortError") return
          failures += 1
          console.error("cplt-notify:", e)
          // 諦めず待ちを伸ばして購読し直す(起動直後の連敗で一生無音にしない)
          await sleep(Math.min(1000 * failures, 30000))
        }
      }
    }
    void loop()
    return () => controller.abort()
  },
})
