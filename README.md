# cc-skill-trace

**Claude Code のスキル発動デバッガー＆ビジュアライザー**

どのスキルが・いつ・なぜ自動発動されたかをターミナルで即確認できる Claude Code プラグイン。

---

## ターミナルダッシュボード

`cc-skill-trace show` を実行すると以下のような表示が出ます:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  🔍 cc-skill-trace                                 12 total invocations       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│    12 invocations     9 🤖 auto     3 👤 user     4 unique skills            │
│                                                                              │
│   🤖 Auto-trigger rate  ████████████████████░░░░  75%                       │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   📊 Skills                                                                  │
│                                                                              │
│   commit        ████████████████████░░░░  8x   6auto · 2user               │
│   review-pr     ████████████░░░░░░░░░░░░  3x   2auto · 1user               │
│   security      ████░░░░░░░░░░░░░░░░░░░░  1x   1auto · 0user               │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   🕐 Recent invocations  (newest first)                                     │
│                                                                              │
│   ● 14:34:55  commit         🤖 auto  "テストが通ったらPRを作って"            │
│   ● 14:31:07  commit         🤖 auto  "この変更をコミットして"               │
│   ● 14:28:44  review-pr      👤 user  "/review-pr 123"                      │
│   ● 14:25:33  commit         🤖 auto  "作業が終わったらコミット"             │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│   cc-skill-trace report  → open browser for full interactive view           │
╰──────────────────────────────────────────────────────────────────────────────╯
```

---

## Claude Code プラグインとして使う（推奨）

```bash
npm install -g cc-skill-trace
cc-skill-trace install   # hook + skill を両方登録
```

Claude Code を再起動後、チャットで:

```
/skill-trace
```

と打つだけで Claude がダッシュボードを表示し、**「なぜこのスキルが自動発動したか」** を解説します。

---

## CLI コマンド

```bash
# ターミナルダッシュボード（デフォルト）
cc-skill-trace show

# セッションログから遡ってインポート + 表示
cc-skill-trace show --scan

# 特定スキルだけ絞り込み
cc-skill-trace show --skill commit

# 日付フィルタ
cc-skill-trace show --since 2026-04-10

# コンパクトな一行リスト
cc-skill-trace show --compact

# ブラウザでインタラクティブレポートを開く
cc-skill-trace report

# 過去セッションのバックフィルのみ
cc-skill-trace scan

# hook を登録（+skill を ~/.claude/skills/ にインストール）
cc-skill-trace install
cc-skill-trace install --project  # プロジェクトレベル

# イベントストアをリセット
cc-skill-trace clear
```

---

## 仕組み

### 1. リアルタイムキャプチャ（hook）

`cc-skill-trace install` が `~/.claude/settings.json` に以下を追加します:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Skill",
      "hooks": [{ "type": "command", "command": "cc-skill-trace hook-capture" }]
    }]
  }
}
```

スキルが呼ばれるたびに `hook-capture` が起動し `~/.cc-skill-trace/events.jsonl` に追記。常に `{}` を返して Claude Code をブロックしません。

### 2. 遡り解析（scan）

既存の `~/.claude/projects/**/*.jsonl` セッションログを解析し、過去のスキル発動を抽出。直前のユーザー発言（トリガー）も合わせて取得します。

### 3. Claude Code Skill（/skill-trace）

`~/.claude/skills/skill-trace/SKILL.md` をインストールすることで、Claude Code のチャットから `/skill-trace` でダッシュボードを呼べます。Claude が結果を解釈して「なぜ auto-trigger が多いか」などをコメントします。

---

## データ

```
~/.cc-skill-trace/
└── events.jsonl   # ローカル保存のみ。外部送信なし。
```

---

## License

MIT
