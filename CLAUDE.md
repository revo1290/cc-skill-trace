# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cc-skill-trace** — Claude Code の Skill 発動デバッガー＆ビジュアライザー。  
どのスキルがいつ・なぜ自動発動されたかを追跡し、ブラウザレポートで可視化する OSS ツール。

## Commands

```bash
npm install           # 依存関係インストール
npm run build         # TypeScript → dist/ にコンパイル (tsc) + SKILL.md を dist/skill/ にコピー
npm run dev           # ウォッチモードでビルド
npm run typecheck     # 型チェックのみ（コンパイルなし）
npm run lint          # biome lint
npm run format:check  # biome format チェック（npm run format で自動修正）
npm test              # 全テスト（CLI サブプロセスを起動する integration.test.ts を含む）
npm run test:unit     # integration.test.ts を除いたユニットテストのみ
node dist/cli/index.js <cmd>   # ビルド後の動作確認
node --import tsx/esm src/cli/index.ts <cmd>   # ビルドせず src から直接実行
```

## Architecture

```
src/
├── core/
│   ├── types.ts      # 全型定義（SessionLogEntry, SkillInvocationEvent, HookPayload, EVENT_SCHEMA_VERSION）
│   ├── parser.ts     # ~/.claude/projects/**/*.jsonl を解析してスキル発動を抽出
│   ├── store.ts       # events.jsonl の読み書き・整合性チェック・修復・重複排除
│   ├── filter.ts       # EventFilter（--since/--skill/--grep 等）と日付・duration パーサ
│   ├── analyze.ts     # 自動発動診断・期間差分・コスト推定・ストリーク等の分析ロジック
│   ├── config.ts      # ~/.cc-skill-trace/{config.json,state.json} の読み書き、getStoreDir()
│   └── utils.ts       # expandTilde 等の小さな汎用ヘルパー
├── skill/
│   └── SKILL.md       # Claude Code Skill 定義。/skill-trace スラッシュコマンドになる
└── cli/
    ├── index.ts        # CLI エントリポイント（commander）。各 register*Command を呼ぶだけの薄い配線
    ├── context.ts      # VERSION 解決・config の遅延ロード＆キャッシュ
    ├── options.ts       # 共通フィルタ系オプション定義（addFilterOptions 等）
    ├── ui.ts            # 色制御・確認プロンプト・ブラウザ起動・update チェック等のCLI共通ヘルパー
    ├── format.ts         # ターミナルダッシュボード（box-drawing + chalk。renderDashboard が中心）
    ├── web-report.ts     # スタンドアロン HTML レポート生成（Chart.js を CDN から読み込み）
    ├── atomic-write.ts   # settings.json の原子的書き込み（.tmp→rename、失敗時のtmp掃除）
    ├── hooks.ts           # settings.json 内の自前フックエントリ判定（command フィールド一致）
    ├── skill-md.ts        # SKILL.md の新旧比較（CRLF非依存）
    ├── follow.ts           # show --follow のオーバーラップ防止ガード
    ├── duration.ts         # clear --older-than 用の簡易 duration パーサ（filter.ts とは別系統）
    ├── version.ts          # package.json を辿ってバージョン解決（構造非依存）
    └── commands/
        ├── install.ts      # install / uninstall / status / doctor / init
        ├── scan.ts          # scan（--resume/--watch/--dry-run）、scanAndMerge 共有ロジック
        ├── show.ts           # show（デフォルトコマンド）、replay
        ├── stats.ts          # stats / list-skills / diagnose / check
        ├── export.ts          # export（json/csv/sql）/ report / clear / prune / tag
        ├── capture.ts          # hook-capture（Pre/PostToolUse 両方をここで処理）
        └── completion.ts        # completion（bash/zsh/fish）
```

### Data flow

1. `cc-skill-trace install` → `~/.claude/settings.json` に PreToolUse + PostToolUse hook を登録 + `~/.claude/skills/skill-trace/SKILL.md` をコピー
2. Claude Code セッション中に Skill tool が呼ばれる → PreToolUse hook → `hook-capture` サブコマンドが起動しイベントを追記
3. Skill tool 完了時 → PostToolUse hook → `hook-capture --post` が同一イベントに outcome/durationMs を追記
4. `hook-capture` は常に `{}` を返す（ブロックしない）。stdin 読み取りにはタイムアウトとサイズ上限がある
5. `cc-skill-trace show` → events.jsonl を読んで **ターミナルダッシュボード**を表示
6. `/skill-trace` (Claude Code 内) → SKILL.md の指示に従い Claude が `cc-skill-trace show --scan --terse` を実行して結果を解説
7. `cc-skill-trace report` → events.jsonl を読んで HTML を生成しブラウザで開く
8. `cc-skill-trace scan` → `~/.claude/projects/**/*.jsonl` を遡ってバックフィル。hook 由来イベントとは `selectNewEvents`（session+skill+args+時刻窓）で突合し二重登録を防ぐ

### Key design decisions

- フックは **絶対に Claude Code をブロックしない**（例外をすべて握りつぶして exit 0）
- `hook-capture` は `src/cli/commands/capture.ts` の hidden サブコマンドとして実装（Pre/Post 両方をこの1ファイルで処理）
- `show` はデフォルトコマンド。`cc-skill-trace` だけで dashboard が出る
- ターミナル出力は box-drawing 文字 + ANSI カラーで視認性を最大化（`format.ts:renderDashboard`）。`NO_COLOR`/非TTY では自動的に無効化
- HTML レポートは依存ゼロのスタンドアロンファイル（Chart.js は CDN、ヒートマップ/ブランチ別グラフは自前CSS）
- イベントストアは JSONL。`v` フィールドでスキーマバージョン管理（v1 は暗黙、v2 で `recordedVia`/`tags`/`outcome`/`durationMs` 追加）
- `readEvents` はストリーミング読み取り＋行単位フィルタ。ファイル全体をメモリに載せない
- 設定は `~/.cc-skill-trace/config.json`（ユーザー編集用）と `state.json`（内部状態、last scan 等）に分離
- `CC_STORE_DIR` / `--store` でイベントストアの場所を切り替え可能
- `CC_DEBUG=1` または `--verbose` で診断ログを stderr に出力
- `CC_SCAN_CONCURRENCY` 環境変数でスキャン並列数を変更（デフォルト: 8）
- `CC_PROJECTS_DIR` 環境変数でスキャン対象ディレクトリを変更（先頭の `~/` はホームディレクトリに展開される）
- SKILL.md は `dist/skill/SKILL.md`（ビルド時に `scripts/copy-skill.mjs` がコピー）を優先し、`src/skill/SKILL.md`（`files` で同梱）にフォールバック
- `install`/`uninstall` は settings.json の hook を `hooks[].command` フィールドの完全一致で判定（`isCcSkillTraceHook`）。他ツールのフックを誤って触らない

### hook-capture と triggerMessage の制限

リアルタイムフック（`hook-capture`）経由で記録されたイベントには `triggerMessage` が含まれない。  
`triggerMessage` は `cc-skill-trace scan` によるセッションログのバックフィルでのみ取得できる。  
これは PreToolUse フックのペイロードに直前のユーザーメッセージが含まれないため。

### テストを追加する場所

新しいコアロジックは対応する `*.test.ts` に追加する（例: `core/filter.ts` → `core/filter.test.ts`）。CLI のエンドツーエンド動作（実プロセス起動・サンドボックス化した `HOME`/`CC_STORE_DIR`/`CC_PROJECTS_DIR`）は `cli/integration.test.ts` に集約している。
