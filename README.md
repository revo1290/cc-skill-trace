# cc-skill-trace

**Claude Code のスキル発動デバッガー＆ビジュアライザー**

どのスキルが・いつ・なぜ自動発動されたかをターミナルで即確認できる Claude Code プラグイン。

---

## ターミナルダッシュボード

`cc-skill-trace show` を実行すると以下のような表示が出ます:

```
════════════════════════════════════════════════════════════════════════════════
  🔍 cc-skill-trace ─ Skill Invocation Debugger
────────────────────────────────────────────────────────────────────────────────

    12 invocations     9 🤖 auto     3 👤 user     4 unique skills

  🤖 Auto-trigger  ████████████████████████░░░░░░  75%

────────────────────────────────────────────────────────────────────────────────

  📊 Skills

  commit       ████████████████████████  8x  6auto · 2user
  review-pr    ████████████░░░░░░░░░░░░  3x  2auto · 1user
  security     ████░░░░░░░░░░░░░░░░░░░░  1x  1auto · 0user

────────────────────────────────────────────────────────────────────────────────

  🕐 Recent invocations  (newest first)

  ● 14:34:55  commit     🤖 auto  "テストが通ったらPRを作って"
  ● 14:31:07  commit     🤖 auto  "この変更をコミットして"
  ● 14:28:44  review-pr  👤 user  "/review-pr 123"

────────────────────────────────────────────────────────────────────────────────
  cc-skill-trace report  → interactive browser dashboard
════════════════════════════════════════════════════════════════════════════════
```

---

## インストール

### npm（推奨）

```bash
npm install -g cc-skill-trace
```

> npm 未公開の場合は下記の GitHub インストールをご利用ください。

### GitHub から直接インストール

```bash
npm install -g github:revo1290/cc-skill-trace
```

### ソースからビルド

```bash
git clone https://github.com/revo1290/cc-skill-trace.git
cd cc-skill-trace
npm install
npm run build
npm link
```

---

## セットアップ

```bash
# Claude Code に hook + /skill-trace スキルを登録
cc-skill-trace install

# Claude Code を再起動
```

これだけです。以降、スキルが発動するたびに自動でキャプチャされます。

### Claude Code 内から使う（プラグイン）

Claude Code のチャットで `/skill-trace` と打つだけでダッシュボードを表示し、「なぜこのスキルが自動発動したか」を Claude が解説します。

---

## CLI コマンド

```bash
# ターミナルダッシュボード（デフォルト）
cc-skill-trace show

# 過去のセッションログを遡ってインポート＋表示
cc-skill-trace show --scan

# ブラウザでインタラクティブレポートを開く（グラフ付き）
cc-skill-trace report

# 特定スキルだけ絞り込み
cc-skill-trace show --skill commit

# 日付フィルタ
cc-skill-trace show --since 2026-04-10

# コンパクトな一行リスト
cc-skill-trace show --compact

# hook + skill を登録（install の手動実行）
cc-skill-trace install             # グローバル (~/.claude/settings.json)
cc-skill-trace install --project   # プロジェクトレベル (.claude/settings.json)

# イベントストアをリセット
cc-skill-trace clear
```

---

## 仕組み

### 1. リアルタイムキャプチャ（PreToolUse hook）

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

スキルが呼ばれるたびに `hook-capture` が起動し `~/.cc-skill-trace/events.jsonl` に追記。  
常に `{}` を返して **Claude Code の処理をブロックしません**。

### 2. 遡り解析（scan）

`~/.claude/projects/**/*.jsonl` のセッションログを解析し、過去のスキル発動を抽出します。  
直前のユーザー発言（トリガーメッセージ）も合わせて取得します。

### 3. Claude Code Skill（/skill-trace）

`~/.claude/skills/skill-trace/SKILL.md` をインストールすることで、  
Claude Code のチャットから `/skill-trace` でダッシュボードを呼べます。  
Claude が結果を解釈して「なぜ auto-trigger が多いか」などをコメントします。

---

## データの保存場所

```
~/.cc-skill-trace/
└── events.jsonl   # ローカル保存のみ。外部送信なし。
```

---

## Requirements

- Node.js 18 以上
- Claude Code（Claude Code でのスキル機能が必要）

---

## License

MIT © [revo1290](https://github.com/revo1290)
