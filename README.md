# cplt-notify

[navikt/cplt](https://github.com/navikt/cplt) 越しに opencode v2 を使うときに、実行完了・失敗・許可確認・質問を音で通知するもの。opencode v1 には対応しない。サンドボックス内の opencode plugin が spool ファイルを書き、ホスト側の watcher が `inotifywait + paplay` で対応する音源を再生する。

Linux のみ対応。

## 仕組み

```text
opencode plugin → ~/.cache/cplt/notify/{done,permission,question,error} → watcher → paplay
```

## イベント対応表

| opencode イベント | spool ファイル | 音源ファイル |
| --- | --- | --- |
| `session.execution.succeeded` | `done` | `notification-success-soft.wav` |
| `permission.asked` | `permission` | `notification-attention-clear.wav` |
| `form.created` | `question` | `notification-message-in-clear.wav` |
| `session.execution.failed` | `error` | `notification-error-soft.wav` |

`done`・`error` は親なしトップレベルセッションの完了・失敗のみ(subagent の完了は無音)。`permission`・`question` は即時。

## 必要なもの

- `opencode` v2
- `inotifywait`（`inotify-tools`）
- `paplay`（PulseAudio / PipeWire 環境）
- `flock`（`util-linux`。二重起動防止用。通常は最初から入っている）

```sh
sudo apt install inotify-tools pulseaudio-utils
```

## インストール

```sh
mkdir -p ~/.config/opencode/plugins ~/.local/bin ~/.local/share/cplt-notify ~/.cache/cplt/notify
cp .config/opencode/plugins/cplt-notify.js ~/.config/opencode/plugins/
cp .local/bin/cplt-notify-watcher.sh ~/.local/bin/
chmod +x ~/.local/bin/cplt-notify-watcher.sh
```

### 音源の配置（同梱なし）

音源はリポジトリに同梱しない。[SFX Kit](https://github.com/wyzowl/sfx-kit)（CC0-1.0）から `sounds/notifications/` 配下の4ファイルを取得し、ファイル名そのままで配置する。

```sh
base=https://raw.githubusercontent.com/wyzowl/sfx-kit/main/sounds/notifications
for f in notification-success-soft notification-attention-clear notification-message-in-clear notification-error-soft; do
  curl -fSL -o "$HOME/.local/share/cplt-notify/$f.wav" "$base/$f.wav"
done
cd ~/.local/share/cplt-notify && sha256sum -c - <<'EOF'
49fa865e894e26a59dea81144844270d532fa899d7eb94f2ac0687af4a66ebc1  notification-success-soft.wav
cda9c0855762e8b65bf793023f9ce379f34fb2ad55580da85710a8f94a55e96f  notification-attention-clear.wav
56f3cea7149ec69f8aef73c7428533bb3b588d35b8916d4f33d9e1cc8b7c1e3c  notification-message-in-clear.wav
a4fbba71503798c6c3f375b41e69d2f4dcf43866a1a29273eaa54a0280c8f339  notification-error-soft.wav
EOF
```
合わなければ上流の更新か破損なので入れ直す。

## 常駐方法

A・B いずれか一方を選ぶ。

### A: systemd --user

`~/.config/systemd/user/cplt-notify-watcher.service` を作成する。

```ini
[Unit]
Description=cplt-notify watcher
After=sound.target

[Service]
ExecStart=%h/.local/bin/cplt-notify-watcher.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now cplt-notify-watcher.service
```

### B: rc ファイル

`~/.bashrc`（zsh なら `~/.zshrc`）に以下を1行追加する。二重起動は watcher 内の flock が拒否する。

```sh
"$HOME/.local/bin/cplt-notify-watcher.sh" >/dev/null 2>&1 &
```

## 動作確認

```sh
: > ~/.cache/cplt/notify/done
```

完了音（`notification-success-soft.wav`）が再生されれば成功。`touch` ではなく `: >` を使う（`touch` は2回目以降 ATTRIB しか出ず鳴らない）。

## テスト

```sh
node --test tests/parent-filter.test.mjs
bash tests/smoke.sh
```

`smoke.sh` は `inotifywait` が無い環境では `ALLOW_SKIP=1` でスキップできる。

## トラブルシュート

- `bad spool dir` で watcher が終了する: `~/.cache/cplt/notify` かその親がシンボリックリンクになっている。実ディレクトリに置き換えてから起動する。
- 音が出ない: `inotifywait`・`paplay` が導入されているか、音源4ファイル名が表通りかを確認する。watcher の監視エラーは `~/.cache/cplt/watcher-inotify.err` に残る。
- 通知が来ない: `~/.config/opencode/plugins/cplt-notify.js` が配置されているか、opencode を再起動したかを確認する。

## アンインストール

```sh
systemctl --user disable --now cplt-notify-watcher.service 2>/dev/null
pkill -f cplt-notify-watcher.sh 2>/dev/null
rm -f ~/.config/opencode/plugins/cplt-notify.js ~/.local/bin/cplt-notify-watcher.sh
rm -rf ~/.cache/cplt/notify ~/.local/share/cplt-notify
```

rc ファイルを選んだ場合は追加した1行も削除する。

## 謝辞

音源は [SFX Kit by Wyzowl](https://github.com/wyzowl/sfx-kit)（CC0-1.0）を利用。本リポジトリに音源ファイルは含まない。
