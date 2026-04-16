# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cc-skill-trace** — Claude Code の Skill 発動デバッガー＆ビジュアライザー。  
どのスキルがいつ・なぜ自動発動されたかを追跡し、ブラウザレポートで可視化する OSS ツール。

## Commands

```bash
npm install          # 依存関係インストール
npm run build        # TypeScript → dist/ にコンパイル (tsc)
npm run dev          # ウォッチモードでビルド
npm run typecheck    # 型チェックのみ（コンパイルなし）
node dist/cli/index.js <cmd>   # ビルド後の動作確認
```

## Architecture

```
src/
├── core/
│   ├── types.ts      # 全型定義（SessionLogEntry, SkillInvocationEvent, HookPayload）
│   ├── parser.ts     # ~/.claude/projects/**/*.jsonl を解析してスキル発動を抽出
│   └── store.ts      # ~/.cc-skill-trace/events.jsonl への読み書き
├── hook/
│   └── capture.ts    # Claude Code の PreToolUse フック。stdin → events.jsonl に追記
├── skill/
│   └── SKILL.md      # Claude Code Skill 定義。/skill-trace スラッシュコマンドになる
└── cli/
    ├── index.ts      # CLI エントリポイント（commander）。コマンド: install/show/scan/report/clear
    ├── format.ts     # ターミナルダッシュボード（ box-drawing + chalk。renderDashboard が中心）
    └── web-report.ts # スタンドアロン HTML レポート生成（Chart.js を CDN から読み込み）
```

### Data flow

1. `cc-skill-trace install` → `~/.claude/settings.json` に PreToolUse hook を登録 + `~/.claude/skills/skill-trace/SKILL.md` をコピー
2. Claude Code セッション中に Skill tool が呼ばれる → hook → `capture.ts` が起動
3. `capture.ts` はイベントを `~/.cc-skill-trace/events.jsonl` に追記して `{}` を返す（ブロックしない）
4. `cc-skill-trace show` → events.jsonl を読んで **ターミナルダッシュボード**を表示
5. `/skill-trace` (Claude Code 内) → SKILL.md の指示に従い Claude が `cc-skill-trace show --scan` を実行して結果を解説
6. `cc-skill-trace report` → events.jsonl を読んで HTML を生成しブラウザで開く
7. `cc-skill-trace scan` → `~/.claude/projects/**/*.jsonl` を遡ってバックフィル

### Key design decisions

- フックは **絶対に Claude Code をブロックしない**（例外をすべて握りつぶして exit 0）
- `show` はデフォルトコマンド。`cc-skill-trace` だけで dashboard が出る
- ターミナル出力は box-drawing 文字 + ANSI カラーで視認性を最大化（`format.ts:renderDashboard`）
- HTML レポートは依存ゼロのスタンドアロンファイル（Chart.js は CDN）
- イベントストアは JSONL（SQLite は v2 で検討）
